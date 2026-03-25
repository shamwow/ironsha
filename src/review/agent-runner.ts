import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, resolveProviderModel, type AgentProvider } from "../config.js";
import { logger } from "../logger.js";
import {
  buildProviderInput,
  buildProviderInvocation,
  ProviderOutputCollector,
  type BuildProviderInvocationOptions,
  type ProviderInvocationSpec,
} from "../llm/provider-runtime.js";

export interface RunAgentOptions {
  provider: AgentProvider;
  checkoutPath: string;
  promptPath: string;
  userMessage: string;
  githubToken: string;
  maxTurns: number;
  timeoutMs: number;
  reviewId: string;
  pass: string;
  /** When true, do not configure the GitHub MCP server. */
  skipMcpGithub?: boolean;
}

interface TranscriptMetadata {
  provider: AgentProvider;
  resolvedModel: string | null;
  command: string;
  pass: string;
  createdAt: string;
}

export function providerDisplayName(_provider: AgentProvider): string {
  return _provider === "codex" ? "Codex" : "Claude Code";
}

async function saveTranscript(
  transcriptId: string,
  stdout: string,
  stderr: string,
  metadata: TranscriptMetadata,
): Promise<void> {
  const dir = config.TRANSCRIPT_DIR;
  await mkdir(dir, { recursive: true });

  await Promise.all([
    writeFile(join(dir, `${transcriptId}.json`), stdout),
    writeFile(
      join(dir, `${transcriptId}.meta.json`),
      JSON.stringify(metadata, null, 2),
    ),
    stderr.length > 0
      ? writeFile(join(dir, `${transcriptId}.stderr.log`), stderr)
      : Promise.resolve(),
  ]);
}

function transcriptGroupId(name: string): string {
  if (name.endsWith(".stderr.log")) {
    return name.slice(0, -".stderr.log".length);
  }
  if (name.endsWith(".meta.json")) {
    return name.slice(0, -".meta.json".length);
  }
  if (name.endsWith(".json")) {
    return name.slice(0, -".json".length);
  }
  return name;
}

async function pruneTranscripts(keep: number = 30): Promise<void> {
  const dir = config.TRANSCRIPT_DIR;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const groups = new Map<string, { fullPath: string; mtimeMs: number }[]>();
  await Promise.all(
    entries.map(async (name) => {
      const fullPath = join(dir, name);
      const fileStats = await stat(fullPath);
      const groupId = transcriptGroupId(name);
      const group = groups.get(groupId) ?? [];
      group.push({ fullPath, mtimeMs: fileStats.mtimeMs });
      groups.set(groupId, group);
    }),
  );

  const sortedGroups = Array.from(groups.values())
    .map((files) => ({
      files,
      latestMtimeMs: Math.max(...files.map((file) => file.mtimeMs)),
    }))
    .sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);

  const toDelete = sortedGroups.slice(keep).flatMap((group) => group.files);
  await Promise.all(toDelete.map((file) => rm(file.fullPath, { force: true })));
}

async function cleanupInvocationFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

async function buildInvocationSpec(
  options: RunAgentOptions,
): Promise<ProviderInvocationSpec> {
  const resolvedModel = resolveProviderModel(options.provider);
  const invocationOptions: BuildProviderInvocationOptions = {
    provider: options.provider,
    model: resolvedModel,
    mode: "review",
    promptPath: options.promptPath,
    maxTurns: options.maxTurns,
  };
  if (!options.skipMcpGithub && options.provider === "claude") {
    invocationOptions.githubToken = options.githubToken;
  }
  return buildProviderInvocation(invocationOptions);
}

export type AgentRunner = (options: RunAgentOptions) => Promise<string>;

export async function runAgent(
  options: RunAgentOptions,
): Promise<string> {
  const invocation = await buildInvocationSpec(options);
  const transcriptId = `${options.reviewId}-${options.pass}`;
  const displayName = providerDisplayName(options.provider);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.checkoutPath,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const collector = new ProviderOutputCollector(invocation, false);
    let settled = false;

    const finalize = async (
      handler: (context: { stdout: string; stderr: string; finalOutput: string }) => void,
    ): Promise<void> => {
      if (settled) return;
      settled = true;

      const finalOutput = await collector.finalize();
      const stdout = collector.getStdout();
      const stderr = collector.getStderr();

      try {
        await saveTranscript(
          transcriptId,
          stdout,
          stderr,
          {
            provider: options.provider,
            resolvedModel: invocation.resolvedModel ?? null,
            command: invocation.command,
            pass: options.pass,
            createdAt: new Date().toISOString(),
          },
        );
      } catch (err) {
        logger.warn({ err, transcriptId }, "Failed to save transcript");
      } finally {
        await cleanupInvocationFiles(invocation.cleanupPaths).catch((err) => {
          logger.warn({ err, transcriptId }, "Failed to clean up agent temp files");
        });
        void pruneTranscripts().catch((err) => {
          logger.warn({ err }, "Failed to prune transcripts");
        });
        handler({ stdout, stderr, finalOutput });
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      collector.handleStdout(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      collector.handleStderr(data);
    });

    child.stdin.write(buildProviderInput(invocation, options.userMessage));
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      void finalize(({ stderr }) => {
        reject(
          new Error(`${displayName} timed out after ${options.timeoutMs}ms\nstderr: ${stderr}`),
        );
      });
    }, options.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      void finalize(({ stdout, stderr, finalOutput }) => {
        if (code === 0) {
          resolve(finalOutput);
          return;
        }

        reject(
          new Error(
            `${displayName} exited with code ${code}\nstderr: ${stderr}\nstdout: ${stdout}\noutput: ${finalOutput}`,
          ),
        );
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      void finalize(() => {
        reject(err);
      });
    });
  });
}
