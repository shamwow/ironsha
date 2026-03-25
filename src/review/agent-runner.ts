import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, resolveProviderModel, type AgentProvider } from "../config.js";
import { logger } from "../logger.js";

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

interface ClaudeInvocationOptions {
  promptPath: string;
  mcpConfigPath?: string;
  model: string;
  maxTurns: number;
}

interface InvocationSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanupPaths: string[];
  resolvedModel?: string;
}

interface TranscriptMetadata {
  provider: AgentProvider;
  resolvedModel: string | null;
  command: string;
  pass: string;
  createdAt: string;
}

export function providerDisplayName(_provider: AgentProvider): string {
  return "Claude Code";
}

export function buildClaudeInvocation(
  options: ClaudeInvocationOptions,
): InvocationSpec {
  const { promptPath, mcpConfigPath, model, maxTurns } = options;

  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    model,
    "--max-turns",
    String(maxTurns),
    "--thinking",
    "enabled",
    "--append-system-prompt-file",
    promptPath,
  ];

  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  args.push("--dangerously-skip-permissions");

  return {
    command: "claude",
    args,
    env: {
      ...process.env,
      CLAUDECODE: "",
      ...(process.env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
        : {}),
    },
    cleanupPaths: mcpConfigPath ? [mcpConfigPath] : [],
    resolvedModel: model,
  };
}

async function createClaudeMcpConfig(token: string): Promise<string> {
  const mcpConfig = {
    mcpServers: {
      github: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@github/mcp-server"],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: token,
        },
      },
    },
  };

  const tempDir = join(tmpdir(), "ironsha-mcp");
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `mcp-config-${Date.now()}.json`);
  await writeFile(tempPath, JSON.stringify(mcpConfig, null, 2));
  return tempPath;
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
): Promise<InvocationSpec> {
  const resolvedModel = resolveProviderModel(options.provider);
  const mcpConfigPath = options.skipMcpGithub
    ? undefined
    : await createClaudeMcpConfig(options.githubToken);
  return buildClaudeInvocation({
    promptPath: options.promptPath,
    mcpConfigPath,
    model: resolvedModel,
    maxTurns: options.maxTurns,
  });
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

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finalize = async (handler: () => void): Promise<void> => {
      if (settled) return;
      settled = true;

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
        handler();
      }
    };

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin.write(options.userMessage);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      void finalize(() => {
        reject(
          new Error(`${displayName} timed out after ${options.timeoutMs}ms\nstderr: ${stderr}`),
        );
      });
    }, options.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      void finalize(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        reject(
          new Error(
            `${displayName} exited with code ${code}\nstderr: ${stderr}\nstdout: ${stdout}`,
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
