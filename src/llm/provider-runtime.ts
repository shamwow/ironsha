import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../config.js";

export type ProviderMode = "print" | "agentic" | "review";

type StdoutFormat = "claude-stream-json" | "codex-jsonl" | "text";

export interface ProviderInvocationSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanupPaths: string[];
  resolvedModel: string;
  displayName: string;
  stdoutFormat: StdoutFormat;
  outputFilePath?: string;
  stdinPrefix?: string;
}

export interface BuildProviderInvocationOptions {
  provider: AgentProvider;
  model: string;
  mode: ProviderMode;
  promptPath?: string;
  githubToken?: string;
  maxTurns?: number;
}

interface StreamJsonExtraction {
  text: string | null;
  resultText: string | null;
}

function extractFromStreamJson(line: string): StreamJsonExtraction {
  if (!line.trim()) return { text: null, resultText: null };
  try {
    const event = JSON.parse(line);
    if (event.type === "assistant" && event.message?.content) {
      const parts: string[] = [];
      for (const block of event.message.content) {
        if (block.type === "text") {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return { text: parts.join(""), resultText: null };
    }
    if (event.type === "result" && event.result) {
      const resultStr = typeof event.result === "string"
        ? event.result
        : (event.result as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
      if (resultStr) return { text: null, resultText: resultStr };
    }
  } catch {
    // Ignore invalid lines; the caller still has the raw stdout transcript.
  }
  return { text: null, resultText: null };
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
  const tempPath = join(tempDir, `mcp-config-${Date.now()}-${randomUUID()}.json`);
  await writeFile(tempPath, JSON.stringify(mcpConfig, null, 2));
  return tempPath;
}

async function createCodexOutputFile(): Promise<string> {
  const tempDir = join(tmpdir(), "ironsha-codex");
  await mkdir(tempDir, { recursive: true });
  return join(tempDir, `output-${Date.now()}-${randomUUID()}.txt`);
}

export async function buildProviderInvocation(
  options: BuildProviderInvocationOptions,
): Promise<ProviderInvocationSpec> {
  switch (options.provider) {
    case "claude":
      return buildClaudeInvocation(options);
    case "codex":
      return buildCodexInvocation(options);
  }
}

async function buildClaudeInvocation(
  options: BuildProviderInvocationOptions,
): Promise<ProviderInvocationSpec> {
  const { mode, model, maxTurns, promptPath, githubToken } = options;
  const args =
    mode === "review"
      ? [
          "--print",
          "--output-format",
          "json",
          "--model",
          model,
          "--max-turns",
          String(maxTurns ?? 30),
          "--thinking",
          "enabled",
          "--append-system-prompt-file",
          promptPath ?? "",
        ]
      : [
          "--print",
          "--verbose",
          "--model",
          model,
          "--thinking",
          "enabled",
          "--output-format",
          "stream-json",
          "--max-turns",
          String(maxTurns ?? 1000),
        ];

  const cleanupPaths: string[] = [];
  if (mode === "review") {
    if (!promptPath) {
      throw new Error("Claude review mode requires promptPath");
    }
    if (githubToken) {
      const mcpConfigPath = await createClaudeMcpConfig(githubToken);
      args.push("--mcp-config", mcpConfigPath);
      cleanupPaths.push(mcpConfigPath);
    }
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
    cleanupPaths,
    resolvedModel: model,
    displayName: "Claude Code",
    stdoutFormat: mode === "review" ? "text" : "claude-stream-json",
  };
}

async function buildCodexInvocation(
  options: BuildProviderInvocationOptions,
): Promise<ProviderInvocationSpec> {
  const outputFilePath = await createCodexOutputFile();
  const args = [
    "exec",
    "--model",
    options.model,
    "--json",
    "--output-last-message",
    outputFilePath,
    "--color",
    "never",
  ];

  if (options.mode !== "print") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  args.push("-");

  let stdinPrefix = "";
  if (options.mode === "review") {
    if (!options.promptPath) {
      throw new Error("Codex review mode requires promptPath");
    }
    const promptText = await readFile(options.promptPath, "utf-8");
    stdinPrefix = `${promptText}\n\n---\n\n`;
  }

  return {
    command: "codex",
    args,
    env: { ...process.env },
    cleanupPaths: [outputFilePath],
    resolvedModel: options.model,
    displayName: "Codex",
    stdoutFormat: "codex-jsonl",
    outputFilePath,
    stdinPrefix,
  };
}

export class ProviderOutputCollector {
  private stdout = "";
  private stderr = "";
  private lineBuffer = "";
  private textContent = "";
  private resultContent = "";
  private claudeRetryCount = 0;

  constructor(
    private readonly spec: ProviderInvocationSpec,
    private readonly streamToUser: boolean,
  ) {}

  handleStdout(data: Buffer): string {
    const chunk = data.toString();
    this.stdout += chunk;

    if (this.spec.stdoutFormat === "claude-stream-json") {
      this.lineBuffer += chunk;
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop() ?? "";
      let streamed = "";
      for (const line of lines) {
        if (line.includes('"subtype":"api_retry"')) {
          this.claudeRetryCount++;
        }
        const extracted = extractFromStreamJson(line);
        if (extracted.text) {
          this.textContent += extracted.text;
          streamed += extracted.text;
        }
        if (extracted.resultText) {
          this.resultContent += extracted.resultText;
        }
      }
      return this.streamToUser ? streamed : "";
    }

    if (this.spec.stdoutFormat === "codex-jsonl") {
      return this.streamToUser ? chunk : "";
    }

    return this.streamToUser ? chunk : "";
  }

  handleStderr(data: Buffer): void {
    this.stderr += data.toString();
  }

  async finalize(): Promise<string> {
    if (this.spec.stdoutFormat === "claude-stream-json" && this.lineBuffer) {
      if (this.lineBuffer.includes('"subtype":"api_retry"')) {
        this.claudeRetryCount++;
      }
      const extracted = extractFromStreamJson(this.lineBuffer);
      if (extracted.text) this.textContent += extracted.text;
      if (extracted.resultText) this.resultContent += extracted.resultText;
      this.lineBuffer = "";
    }

    if (this.spec.outputFilePath) {
      try {
        const fileOutput = await readFile(this.spec.outputFilePath, "utf-8");
        if (fileOutput.trim().length > 0) {
          return fileOutput;
        }
      } catch {
        // Fall back to stdout-derived output below.
      }
    }

    if (this.spec.stdoutFormat === "claude-stream-json") {
      return this.textContent || this.resultContent || this.stdout;
    }

    return this.stdout;
  }

  getStdout(): string {
    return this.stdout;
  }

  getStderr(): string {
    return this.stderr;
  }

  shouldAbortForProviderFailure(): boolean {
    return this.spec.stdoutFormat === "claude-stream-json"
      && this.claudeRetryCount >= 3
      && this.textContent.length === 0
      && this.resultContent.length === 0;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.spec.cleanupPaths.map((path) => rm(path, { force: true })));
  }
}

export function buildProviderInput(
  spec: ProviderInvocationSpec,
  prompt: string,
): string {
  return `${spec.stdinPrefix ?? ""}${prompt}`;
}
