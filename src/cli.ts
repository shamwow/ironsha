import "dotenv/config";
import { spawn, execSync } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LlmConfig {
  provider: "claude" | "codex";
  model: string;
}

interface OrchestrateOptions {
  task: string;
  planLlm: LlmConfig;
  reviewLlm: LlmConfig;
  implementLlm: LlmConfig;
  prLlm: LlmConfig;
  reviewIterations: number;

  skipPlan: boolean;
  skipReview: boolean;
  skipImplement: boolean;
  skipPr: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LLM: LlmConfig = { provider: "claude", model: "claude-opus-4-6" };
const VALID_PROVIDERS = ["claude", "codex"] as const;
const MAX_TURNS = 1000;

const USAGE = `Usage: ironsha build "<task description>" [options]

Options:
  --plan-llm <provider:model>       LLM for planning (default: claude:claude-opus-4-6)
  --review-llm <provider:model>     LLM for plan review (default: claude:claude-opus-4-6)
  --implement-llm <provider:model>  LLM for implementation (default: claude:claude-opus-4-6)
  --pr-llm <provider:model>         LLM for PR review (default: claude:claude-opus-4-6)
  --review-iterations <n>           Plan review cycles (default: 1)
  --skip-plan                       Skip planning phase
  --skip-review                     Skip plan review phase
  --skip-implement                  Skip implementation phase
  --skip-pr                         Skip PR review phase

Provider:model examples:
  claude:claude-opus-4-6
  claude:claude-sonnet-4-6
  codex:o3
  codex:o4-mini
`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(phase: string, message: string): void {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  process.stderr.write(`[${time}] [${phase}] ${message}\n`);
}

// ---------------------------------------------------------------------------
// Argument Parsing
// ---------------------------------------------------------------------------

function parseLlm(value: string): LlmConfig {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    console.error(`Invalid LLM format: "${value}". Expected <provider>:<model> (e.g. claude:claude-opus-4-6)`);
    process.exit(1);
  }
  const provider = value.slice(0, colonIndex);
  const model = value.slice(colonIndex + 1);
  if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
    console.error(`Unknown provider: "${provider}". Valid providers: ${VALID_PROVIDERS.join(", ")}`);
    process.exit(1);
  }
  if (!model) {
    console.error(`Missing model in LLM config: "${value}"`);
    process.exit(1);
  }
  return { provider: provider as "claude" | "codex", model };
}

function parseArgs(argv: string[]): OrchestrateOptions {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (args[i] === "--skip-plan") { boolFlags.add("skip-plan"); continue; }
    if (args[i] === "--skip-review") { boolFlags.add("skip-review"); continue; }
    if (args[i] === "--skip-implement") { boolFlags.add("skip-implement"); continue; }
    if (args[i] === "--skip-pr") { boolFlags.add("skip-pr"); continue; }
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  const task = positional[0] ?? "";
  const skipPlan = boolFlags.has("skip-plan");

  if (!task && !skipPlan) {
    console.error("Error: task description is required (or use --skip-plan)\n");
    console.log(USAGE);
    process.exit(1);
  }

  return {
    task,
    planLlm: flags["plan-llm"] ? parseLlm(flags["plan-llm"]) : DEFAULT_LLM,
    reviewLlm: flags["review-llm"] ? parseLlm(flags["review-llm"]) : DEFAULT_LLM,
    implementLlm: flags["implement-llm"] ? parseLlm(flags["implement-llm"]) : DEFAULT_LLM,
    prLlm: flags["pr-llm"] ? parseLlm(flags["pr-llm"]) : DEFAULT_LLM,
    reviewIterations: flags["review-iterations"] ? parseInt(flags["review-iterations"], 10) : 1,
    skipPlan,
    skipReview: boolFlags.has("skip-review"),
    skipImplement: boolFlags.has("skip-implement"),
    skipPr: boolFlags.has("skip-pr"),
  };
}

// ---------------------------------------------------------------------------
// Subprocess Helpers
// ---------------------------------------------------------------------------

function buildClaudeArgs(model: string, _mode: "print" | "agentic"): string[] {
  return [
    "--print", "--verbose", "--model", model,
    "--thinking", "enabled",
    "--output-format", "stream-json",
    "--max-turns", String(MAX_TURNS),
    "--dangerously-skip-permissions",
  ];
}

function buildCodexArgs(model: string, mode: "print" | "agentic"): string[] {
  if (mode === "print") {
    return ["--model", model, "--quiet"];
  }
  return ["--model", model, "--full-auto"];
}

function buildInvocation(llm: LlmConfig, mode: "print" | "agentic"): { command: string; args: string[] } {
  if (llm.provider === "claude") {
    return { command: "claude", args: buildClaudeArgs(llm.model, mode) };
  }
  return { command: "codex", args: buildCodexArgs(llm.model, mode) };
}

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDECODE: "",
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
  };
}

function llmLabel(llm: LlmConfig): string {
  return `${llm.provider}:${llm.model}`;
}

// ---------------------------------------------------------------------------
// Transcript Logging
// ---------------------------------------------------------------------------

let logDir: string | undefined;
let invocationCounter = 0;

function ensureLogDir(): string {
  if (!logDir) {
    logDir = join(tmpdir(), "ironsha", `build-${Date.now()}`);
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

function openTranscriptStreams(phase: string): { stdoutPath: string; stdout: ReturnType<typeof createWriteStream>; stderr: ReturnType<typeof createWriteStream> } {
  const dir = ensureLogDir();
  invocationCounter++;
  const prefix = `${String(invocationCounter).padStart(2, "0")}-${phase}`;
  const stdoutPath = join(dir, `${prefix}.stdout.log`);
  const stderrPath = join(dir, `${prefix}.stderr.log`);
  return {
    stdoutPath,
    stdout: createWriteStream(stdoutPath),
    stderr: createWriteStream(stderrPath),
  };
}

interface StreamJsonExtraction {
  /** Text from assistant message content blocks */
  text: string | null;
  /** Text from the result event (used as fallback) */
  resultText: string | null;
}

/**
 * Extract text content from a stream-json line.
 */
function extractFromStreamJson(line: string): StreamJsonExtraction {
  if (!line.trim()) return { text: null, resultText: null };
  try {
    const event = JSON.parse(line);
    // Assistant message with text content
    if (event.type === "assistant" && event.message?.content) {
      const parts: string[] = [];
      for (const block of event.message.content) {
        if (block.type === "text") {
          parts.push(block.text);
        }
      }
      if (parts.length > 0) return { text: parts.join(""), resultText: null };
    }
    // Result message (final output) — may duplicate assistant text, so tracked separately
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
    // Not valid JSON — ignore
  }
  return { text: null, resultText: null };
}

interface ProcessedBuffer {
  text: string;
  resultText: string;
  remainder: string;
}

/**
 * Process a raw stdout buffer that may contain partial lines.
 */
function processStreamBuffer(buffer: string): ProcessedBuffer {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  let text = "";
  let resultText = "";
  for (const line of lines) {
    const extracted = extractFromStreamJson(line);
    if (extracted.text) text += extracted.text;
    if (extracted.resultText) resultText += extracted.resultText;
  }
  return { text, resultText, remainder };
}

/**
 * Run an LLM in print mode: pipe prompt via stdin, capture and return stdout.
 */
async function runPrintMode(llm: LlmConfig, prompt: string, cwd: string, phase: string = "print"): Promise<string> {
  const { command, args } = buildInvocation(llm, "print");
  const transcript = openTranscriptStreams(phase);
  log("SUBPROCESS", `${command} ${args.join(" ")}`);
  log("SUBPROCESS", `Transcript: ${transcript.stdoutPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let textContent = "";
    let resultContent = "";
    let lineBuffer = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      transcript.stdout.write(data);
      lineBuffer += data.toString();
      const { text, resultText, remainder } = processStreamBuffer(lineBuffer);
      lineBuffer = remainder;
      textContent += text;
      resultContent += resultText;
    });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); transcript.stderr.write(data); });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("close", (code) => {
      if (lineBuffer) {
        const extracted = extractFromStreamJson(lineBuffer);
        if (extracted.text) textContent += extracted.text;
        if (extracted.resultText) resultContent += extracted.resultText;
      }
      transcript.stdout.end();
      transcript.stderr.end();
      // Use assistant text if available, fall back to result text
      const output = textContent || resultContent;
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} exited with code ${code}\nstderr: ${stderr}`));
      }
    });

    child.on("error", (err) => reject(err));
  });
}

/**
 * Run an LLM in agentic mode: pipe prompt via stdin, stream stdout to user's stderr.
 */
async function runAgenticMode(llm: LlmConfig, prompt: string, cwd: string, phase: string = "agentic"): Promise<string> {
  const { command, args } = buildInvocation(llm, "agentic");
  const transcript = openTranscriptStreams(phase);
  log("SUBPROCESS", `${command} ${args.join(" ")}`);
  log("SUBPROCESS", `Transcript: ${transcript.stdoutPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let textContent = "";
    let resultContent = "";
    let lineBuffer = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      transcript.stdout.write(data);
      lineBuffer += data.toString();
      const { text, resultText, remainder } = processStreamBuffer(lineBuffer);
      lineBuffer = remainder;
      if (text) {
        textContent += text;
      }
      if (resultText) resultContent += resultText;
    });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); transcript.stderr.write(data); });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("close", (code) => {
      if (lineBuffer) {
        const extracted = extractFromStreamJson(lineBuffer);
        if (extracted.text) {
          textContent += extracted.text;
        }
        if (extracted.resultText) resultContent += extracted.resultText;
      }
      transcript.stdout.end();
      transcript.stderr.end();
      const output = textContent || resultContent;
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} exited with code ${code}\nstderr: ${stderr}`));
      }
    });

    child.on("error", (err) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// Worktree Management
// ---------------------------------------------------------------------------

function createWorktree(repoRoot: string): string {
  const timestamp = Date.now();
  const branchName = `orchestrate-${timestamp}`;
  const worktreeDir = join(repoRoot, ".worktrees");
  const worktreePath = join(worktreeDir, branchName);

  mkdirSync(worktreeDir, { recursive: true });
  execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
    cwd: repoRoot,
    stdio: "pipe",
  });

  return worktreePath;
}

// ---------------------------------------------------------------------------
// Prompt Helpers
// ---------------------------------------------------------------------------

function readPromptFile(name: string): string {
  const srcRoot = resolve(import.meta.dirname, "..");
  return readFileSync(join(srcRoot, "src", "prompts", name), "utf-8");
}

function readGuide(platform: string): string {
  const srcRoot = resolve(import.meta.dirname, "..");
  const guidePath = join(srcRoot, "src", "guides", `${platform.toUpperCase()}_CODE_REVIEW.md`);
  if (existsSync(guidePath)) {
    return readFileSync(guidePath, "utf-8");
  }
  return "";
}

function readCommandFile(name: string): string {
  const srcRoot = resolve(import.meta.dirname, "..");
  return readFileSync(join(srcRoot, "commands", name), "utf-8");
}

function detectPlatformFromDiff(cwd: string, baseBranch: string): string | null {
  let diffOutput: string;
  try {
    diffOutput = execSync(`git diff --name-only origin/${baseBranch}...HEAD`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    try {
      diffOutput = execSync(`git diff --name-only ${baseBranch}...HEAD`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
  }

  const extMap: Record<string, string> = {
    ".swift": "ios",
    ".kt": "android",
    ".kts": "android",
    ".go": "golang",
    ".tsx": "react",
    ".ts": "react",
    ".jsx": "react",
  };

  const counts: Record<string, number> = {};
  for (const file of diffOutput.trim().split("\n")) {
    const ext = file.slice(file.lastIndexOf("."));
    const platform = extMap[ext];
    if (platform) {
      counts[platform] = (counts[platform] ?? 0) + 1;
    }
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [platform, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = platform;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Phase 1: Plan
// ---------------------------------------------------------------------------

async function runPlanPhase(opts: OrchestrateOptions, cwd: string): Promise<string> {
  log("PLAN", `Starting with ${llmLabel(opts.planLlm)}...`);

  const prompt = `You are a software architect planning an implementation.

## Task
${opts.task}

## Instructions
- Analyze the codebase thoroughly — read ARCHITECTURE.md, AGENTS.md, CLAUDE.md if they exist
- Identify all files that need to change
- Produce a detailed, step-by-step implementation plan in Markdown
- For each step, specify: which file to change, what to change, and why
- Consider edge cases, testing strategy, and potential issues
- The plan should be detailed enough that another AI can implement it without ambiguity

## Output
Respond with a complete Markdown implementation plan. Nothing else.`;

  const plan = await runPrintMode(opts.planLlm, prompt, cwd, "plan");
  const planPath = join(cwd, ".plan.md");
  writeFileSync(planPath, plan);
  log("PLAN", `Complete. Saved to .plan.md`);
  return plan;
}

// ---------------------------------------------------------------------------
// Phase 2: Review & Iterate
// ---------------------------------------------------------------------------

async function runReviewPhase(opts: OrchestrateOptions, plan: string, cwd: string): Promise<string> {
  let currentPlan = plan;

  for (let i = 1; i <= opts.reviewIterations; i++) {
    log("REVIEW", `Starting iteration ${i}/${opts.reviewIterations} with ${llmLabel(opts.reviewLlm)}...`);

    const prompt = `You are a senior engineer reviewing an implementation plan.

## Original Task
${opts.task}

## Current Plan
${currentPlan}

## Instructions
- Identify missing steps, incorrect assumptions, or gaps
- Check for edge cases that aren't addressed
- Verify the plan follows existing codebase patterns and conventions
- Check that the testing strategy is adequate
- Produce an UPDATED version of the entire plan incorporating your improvements
- If the plan is already excellent, return it unchanged with a note that no changes were needed

## Output
Respond with the complete updated Markdown plan. Nothing else.`;

    currentPlan = await runPrintMode(opts.reviewLlm, prompt, cwd, `review-${i}`);
    const planPath = join(cwd, ".plan.md");
    writeFileSync(planPath, currentPlan);
    log("REVIEW", `Iteration ${i}/${opts.reviewIterations} complete.`);
  }

  return currentPlan;
}

// ---------------------------------------------------------------------------
// Phase 3: Implement
// ---------------------------------------------------------------------------

async function runImplementPhase(opts: OrchestrateOptions, plan: string, cwd: string): Promise<void> {
  log("IMPLEMENT", `Starting with ${llmLabel(opts.implementLlm)}...`);

  const prompt = `You are a software engineer implementing a plan. Follow it step by step.

## Implementation Plan
${plan}

## Instructions
- Implement each step of the plan in order
- Follow existing codebase patterns and conventions
- Read AGENTS.md, CLAUDE.md, ARCHITECTURE.md if they exist
- After making changes, run the project's build and test commands to verify
- Fix any build/test failures before proceeding
- Do NOT commit changes — just make the code changes and ensure they build
- Be thorough — implement every step in the plan`;

  await runAgenticMode(opts.implementLlm, prompt, cwd, "implement");
  log("IMPLEMENT", "Complete.");
}

// ---------------------------------------------------------------------------
// Phase 4: PR Review
// ---------------------------------------------------------------------------

function runStateCmd(cwd: string, stateArgs: string): string {
  const ironshaRoot = resolve(import.meta.dirname, "..");
  const cliPath = join(ironshaRoot, "dist", "local", "cli.js");
  return execSync(`node "${cliPath}" ${stateArgs}`, {
    cwd,
    encoding: "utf-8",
    env: buildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function runPrReviewPhase(opts: OrchestrateOptions, cwd: string): Promise<void> {
  log("PR-REVIEW", `Starting with ${llmLabel(opts.prLlm)}...`);

  // --- Setup ---
  log("PR-REVIEW", "Running CI (build/tests)...");
  await runAgenticMode(opts.prLlm, `Discover build and test commands from AGENTS.md, CLAUDE.md, or README.md in this project. Run them all. If any fail, fix the issues and re-run until all pass. Only output a summary of what you ran and whether it passed.`, cwd, "pr-ci");

  log("PR-REVIEW", "Initializing local state...");
  runStateCmd(cwd, "init");
  runStateCmd(cwd, "label set bot-review-needed");

  log("PR-REVIEW", "Committing changes...");
  try {
    execSync("git add -A && git commit -m 'orchestrate: implementation changes'", {
      cwd,
      stdio: "pipe",
    });
  } catch {
    log("PR-REVIEW", "No changes to commit (or already committed).");
  }

  log("PR-REVIEW", "Generating PR description...");
  const descOutput = await runPrintMode(
    opts.prLlm,
    `Look at the git diff for this branch against the base branch. Write a PR description that includes:
- **Summary**: What changed and why (1-3 bullet points)
- **Test plan**: Explicit steps that verify the changes work correctly

Output ONLY the description text, no other commentary.`,
    cwd,
    "pr-description",
  );
  runStateCmd(cwd, `description set --body "${descOutput.replace(/"/g, '\\"')}"`);

  // --- Detect platform for review guides ---
  const baseBranch = "main";
  const platform = detectPlatformFromDiff(cwd, baseBranch);

  // --- Build review prompt ---
  const basePrompt = readPromptFile("base.md")
    .replace(
      "You have access to the GitHub MCP server — use it to list PR review comments, read thread conversations, and understand the current review state",
      "All review thread state is provided below. Do NOT use GitHub MCP tools.",
    )
    .replace(
      "Use the GitHub MCP tools to list review comments on this PR",
      "Review the thread state provided below",
    );
  const archPrompt = readPromptFile("architecture-pass.md");
  const detailedPrompt = readPromptFile("detailed-pass.md");
  const guideContent = platform ? readGuide(platform) : "";

  // --- Build fix prompt ---
  const codeFixPrompt = readPromptFile("code-fix.md")
    .replace(
      "You have access to the GitHub MCP server — use it to list PR review comments, read thread conversations, and understand what changes are requested",
      "All review thread state is provided below. Do NOT use GitHub MCP tools.",
    )
    .replace(
      "Use the GitHub MCP tools to list all review comments and threads on this PR",
      "Review the thread state provided below",
    );

  // --- Review/Fix Loop ---
  for (let cycle = 1; ; cycle++) {
    log("PR-REVIEW", `--- Cycle ${cycle} ---`);

    // Step A: Review
    log("PR-REVIEW", "Running review...");
    const threadState = runStateCmd(cwd, "threads");

    const reviewPrompt = [
      basePrompt,
      "\n---\n",
      archPrompt,
      "\n---\n",
      detailedPrompt,
      guideContent ? `\n---\n${guideContent}` : "",
      "\n---\n\n## Current Thread State\n",
      threadState || "(no threads yet)",
      `\n\n## Instructions\nReview the code. Read the diff with \`git diff origin/${baseBranch}...HEAD\`. Perform BOTH architecture and detailed review in a single pass. Output a single JSON block per the format above.`,
    ].join("\n");

    const reviewOutput = await runAgenticMode(opts.prLlm, reviewPrompt, cwd, `pr-review-${cycle}`);

    // Extract JSON from output and post review
    const jsonMatch = reviewOutput.match(/```json\s*([\s\S]*?)```/) ?? reviewOutput.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      const reviewJson = jsonMatch[1].trim();
      try {
        runStateCmd(cwd, `review post --json '${reviewJson.replace(/'/g, "'\\''")}'`);
      } catch (err) {
        log("PR-REVIEW", `Failed to post review: ${err}`);
      }
    } else {
      log("PR-REVIEW", "Warning: could not extract JSON from review output");
    }

    // Check label
    const label = runStateCmd(cwd, "label");
    log("PR-REVIEW", `Label after review: ${label}`);

    if (label === "human-review-needed") {
      log("PR-REVIEW", "Review approved! Moving to publish.");
      break;
    }

    // Step B: Fix
    log("PR-REVIEW", "Running fix pass...");
    const fixThreadState = runStateCmd(cwd, "threads");

    const fixPrompt = [
      codeFixPrompt,
      "\n---\n\n## Current Thread State\n",
      fixThreadState,
      "\n\n## Instructions\nAddress all UNRESOLVED threads. Make code changes, run build/tests, then output the JSON result.",
    ].join("\n");

    const fixOutput = await runAgenticMode(opts.prLlm, fixPrompt, cwd, `pr-fix-${cycle}`);

    // Parse fix output and post replies/resolve threads
    const fixJsonMatch = fixOutput.match(/```json\s*([\s\S]*?)```/) ?? fixOutput.match(/(\{[\s\S]*\})/);
    if (fixJsonMatch) {
      try {
        const fixResult = JSON.parse(fixJsonMatch[1].trim()) as {
          threads_addressed?: Array<{ thread_id: string; explanation: string }>;
        };
        for (const thread of fixResult.threads_addressed ?? []) {
          try {
            runStateCmd(cwd, `reply ${thread.thread_id} --body "${thread.explanation.replace(/"/g, '\\"')}"`);
            runStateCmd(cwd, `resolve ${thread.thread_id}`);
          } catch (err) {
            log("PR-REVIEW", `Failed to resolve thread ${thread.thread_id}: ${err}`);
          }
        }
      } catch {
        log("PR-REVIEW", "Warning: could not parse fix output JSON");
      }
    }

    // Commit fixes
    try {
      execSync(`git add -A && git commit -m 'orchestrate: address review cycle ${cycle}'`, {
        cwd,
        stdio: "pipe",
      });
    } catch {
      log("PR-REVIEW", "No changes to commit after fix pass.");
    }

    // Re-run CI
    log("PR-REVIEW", "Re-running CI...");
    await runAgenticMode(opts.prLlm, `Run the project's build and test commands (from AGENTS.md, CLAUDE.md, or README.md). Fix any failures. Output a summary.`, cwd, `pr-ci-${cycle}`);
  }

  // Publish
  log("PR-REVIEW", "Publishing to GitHub...");
  try {
    const publishOutput = runStateCmd(cwd, "publish");
    log("PR-REVIEW", publishOutput);
  } catch (err) {
    log("PR-REVIEW", `Publish failed: ${err}`);
  }

  log("PR-REVIEW", "Complete.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<void> {
  const opts = parseArgs(argv);
  const repoRoot = process.cwd();

  log("SETUP", "Configuration:");
  log("SETUP", `  Plan:      ${llmLabel(opts.planLlm)}${opts.skipPlan ? " (skipped)" : ""}`);
  log("SETUP", `  Review:    ${llmLabel(opts.reviewLlm)} x${opts.reviewIterations}${opts.skipReview ? " (skipped)" : ""}`);
  log("SETUP", `  Implement: ${llmLabel(opts.implementLlm)}${opts.skipImplement ? " (skipped)" : ""}`);
  log("SETUP", `  PR Review: ${llmLabel(opts.prLlm)}${opts.skipPr ? " (skipped)" : ""}`);
  log("SETUP", `  Transcripts: ${ensureLogDir()}`);

  // Create worktree
  log("SETUP", "Creating git worktree...");
  const worktreePath = createWorktree(repoRoot);
  log("SETUP", `Worktree created at ${worktreePath}`);

  try {
    // Phase 1: Plan
    let plan: string;
    if (!opts.skipPlan) {
      plan = await runPlanPhase(opts, worktreePath);
    } else {
      const planPath = join(worktreePath, ".plan.md");
      if (!existsSync(planPath)) {
        console.error(`Error: --skip-plan specified but no .plan.md found at ${planPath}`);
        process.exit(1);
      }
      plan = readFileSync(planPath, "utf-8");
      log("PLAN", `Skipped. Loaded existing plan from .plan.md`);
    }

    // Phase 2: Review & Iterate
    if (!opts.skipReview) {
      plan = await runReviewPhase(opts, plan, worktreePath);
    } else {
      log("REVIEW", "Skipped.");
    }

    // Phase 3: Implement
    if (!opts.skipImplement) {
      await runImplementPhase(opts, plan, worktreePath);
    } else {
      log("IMPLEMENT", "Skipped.");
    }

    // Phase 4: PR Review
    if (!opts.skipPr) {
      await runPrReviewPhase(opts, worktreePath);
    } else {
      log("PR-REVIEW", "Skipped.");
    }

    log("DONE", `All phases complete. Worktree: ${worktreePath}`);
  } catch (err) {
    log("ERROR", `${err}`);
    log("ERROR", `Worktree preserved at: ${worktreePath}`);
    process.exit(1);
  }
}

// Allow direct execution
if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
