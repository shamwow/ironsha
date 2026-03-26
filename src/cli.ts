import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runBuildAndTests } from "./review/build-runner.js";
import {
  buildProviderInput,
  buildProviderInvocation,
  ProviderOutputCollector,
} from "./llm/provider-runtime.js";
import type { AgentProvider } from "./config.js";
import type { PassLabel } from "./local/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LlmConfig {
  provider: AgentProvider;
  model: string;
}

interface OrchestrateOptions {
  task: string;
  planLlm: LlmConfig;
  reviewLlm: LlmConfig;
  qaLlm: LlmConfig;
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
const MAX_TURNS = 50;

const USAGE = `Usage: ironsha build "<task description>" [options]

Options:
  --plan-llm <provider:model>       LLM for planning (default: claude:claude-opus-4-6)
  --review-llm <provider:model>     LLM for plan review (default: claude:claude-opus-4-6)
  --qa-llm <provider:model>         LLM for QA plan/pr review (default: claude:claude-opus-4-6)
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
    qaLlm: flags["qa-llm"] ? parseLlm(flags["qa-llm"]) : DEFAULT_LLM,
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

function llmLabel(llm: LlmConfig): string {
  return `${llm.provider}:${llm.model}`;
}

function runGit(
  cwd: string,
  args: string[],
  options?: { encoding?: BufferEncoding },
): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    ...(options?.encoding ? { encoding: options.encoding } : {}),
  }).toString();
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

export function formatSubprocessFailure(
  command: string,
  code: number | null,
  stderr: string,
  output: string,
): string {
  const stderrText = stderr.trim();
  const outputText = output.trim();
  const combined = `${stderrText}\n${outputText}`;
  const claudeRetryCount = (combined.match(/"subtype":"api_retry"/g) ?? []).length;

  if (command === "claude" && claudeRetryCount >= 3) {
    return [
      "claude could not complete the request after repeated API retries.",
      "This usually means your Claude usage is exhausted or the provider is temporarily unavailable.",
      "Check your Claude usage/quota and retry later.",
    ].join("\n");
  }

  if (/You've hit your limit|rate[_ ]limit/i.test(combined)) {
    const detail = outputText || stderrText || "Provider rate limit reached.";
    return `${command} hit provider rate limits.\n${detail}`;
  }

  const parts = [`${command} exited with code ${code}`];
  if (stderrText) parts.push(`stderr: ${stderrText}`);
  if (outputText) parts.push(`output: ${outputText}`);
  return parts.join("\n");
}

/**
 * Run an LLM in print mode: pipe prompt via stdin, capture and return stdout.
 */
async function runPrintMode(llm: LlmConfig, prompt: string, cwd: string, phase: string = "print"): Promise<string> {
  const spec = await buildProviderInvocation({
    provider: llm.provider,
    model: llm.model,
    mode: "print",
    maxTurns: MAX_TURNS,
  });
  const transcript = openTranscriptStreams(phase);
  log("SUBPROCESS", `${spec.command} ${spec.args.join(" ")}`);
  log("SUBPROCESS", `Transcript: ${transcript.stdoutPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const collector = new ProviderOutputCollector(spec, false);

    child.stdout.on("data", (data: Buffer) => {
      transcript.stdout.write(data);
      collector.handleStdout(data);
      if (collector.shouldAbortForProviderFailure()) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      collector.handleStderr(data);
      transcript.stderr.write(data);
    });

    child.stdin.write(buildProviderInput(spec, prompt));
    child.stdin.end();

    child.on("close", async (code) => {
      const output = await collector.finalize();
      await collector.cleanup();
      transcript.stdout.end();
      transcript.stderr.end();
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(formatSubprocessFailure(spec.command, code, collector.getStderr(), output)));
      }
    });

    child.on("error", async (err) => {
      await collector.cleanup();
      reject(err);
    });
  });
}

/**
 * Run an LLM in agentic mode: pipe prompt via stdin and capture output in transcripts.
 */
async function runAgenticMode(llm: LlmConfig, prompt: string, cwd: string, phase: string = "agentic"): Promise<string> {
  const spec = await buildProviderInvocation({
    provider: llm.provider,
    model: llm.model,
    mode: "agentic",
    maxTurns: MAX_TURNS,
  });
  const transcript = openTranscriptStreams(phase);
  log("SUBPROCESS", `${spec.command} ${spec.args.join(" ")}`);
  log("SUBPROCESS", `Transcript: ${transcript.stdoutPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const collector = new ProviderOutputCollector(spec, false);

    child.stdout.on("data", (data: Buffer) => {
      transcript.stdout.write(data);
      collector.handleStdout(data);
      if (collector.shouldAbortForProviderFailure()) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      collector.handleStderr(data);
      transcript.stderr.write(data);
    });

    child.stdin.write(buildProviderInput(spec, prompt));
    child.stdin.end();

    child.on("close", async (code) => {
      const output = await collector.finalize();
      await collector.cleanup();
      transcript.stdout.end();
      transcript.stderr.end();
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(formatSubprocessFailure(spec.command, code, collector.getStderr(), output)));
      }
    });

    child.on("error", async (err) => {
      await collector.cleanup();
      reject(err);
    });
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
  runGit(repoRoot, ["worktree", "add", worktreePath, "-b", branchName]);

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
    diffOutput = runGit(cwd, ["diff", "--name-only", `origin/${baseBranch}...HEAD`], {
      encoding: "utf-8",
    });
  } catch {
    try {
      diffOutput = runGit(cwd, ["diff", "--name-only", `${baseBranch}...HEAD`], {
        encoding: "utf-8",
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

function uiEvidenceInstructions(platform: string | null): string[] {
  if (platform === "react") {
    return [
      "- Inspect the changed files and determine whether the diff includes a user-visible UI change",
      "- If the diff changes UI, use Playwright to open the app, navigate it into the correct product state, and capture visual evidence before finishing",
      "  - static UI changes: use Playwright to take screenshots that clearly show the updated UI state",
      "  - interactive UI changes: use Playwright to drive the interaction and capture a short video that shows the behavior working",
      "- Save the artifacts in the repo workspace and include their exact file paths in your final summary",
      "- In your final summary, name the Playwright flow used to reach the captured state and describe what each artifact shows",
      "- If Playwright is unavailable, say that explicitly and do not claim the visual evidence is complete",
      "- If the diff is not user-visible UI, state explicitly in your final summary that visual evidence was not required",
    ];
  }

  if (platform === "ios") {
    return [
      "- Inspect the changed files and determine whether the diff includes a user-visible UI change",
      "- If the diff changes UI, use XcodeBuildMCP to launch the app in the iOS simulator, navigate it into the correct product state, and capture visual evidence before finishing",
      "  - static UI changes: use XcodeBuildMCP to take screenshots that clearly show the updated UI state",
      "  - interactive UI changes: use XcodeBuildMCP to drive the interaction and capture a short video that shows the behavior working",
      "- Save the artifacts in the repo workspace and include their exact file paths in your final summary",
      "- In your final summary, name the XcodeBuildMCP/simulator flow used to reach the captured state and describe what each artifact shows",
      "- If XcodeBuildMCP is unavailable, say that explicitly and do not claim the visual evidence is complete",
      "- If the diff is not user-visible UI, state explicitly in your final summary that visual evidence was not required",
    ];
  }

  return [];
}

export function buildQaPlanReviewPrompt(task: string, plan: string): string {
  return [
    readPromptFile("qa-plan-review.md"),
    "",
    "## Original Task",
    task,
    "",
    "## Current Plan",
    plan,
  ].join("\n");
}

export function buildImplementPrompt(plan: string, platform: string | null): string {
  const instructions = [
    "- Implement each step of the plan in order",
    "- Follow existing codebase patterns and conventions",
    "- Read AGENTS.md, CLAUDE.md, ARCHITECTURE.md if they exist",
    "- After making changes, run the project's build and test commands to verify",
    "- Fix any build/test failures before proceeding",
    "- Do NOT commit changes — just make the code changes and ensure they build",
    "- Be thorough — implement every step in the plan",
    ...uiEvidenceInstructions(platform),
  ];

  return `You are a software engineer implementing a plan. Follow it step by step.

## Implementation Plan
${plan}

## Instructions
${instructions.join("\n")}`;
}

export function buildPrDescriptionPrompt(platform: string | null): string {
  const lines = [
    "Look at the git diff for this branch against the base branch.",
    "Output a single JSON object with this shape:",
    '{ "title": "short PR title", "body": "full PR description markdown" }',
    'The `title` must be a concise human-readable PR title, not the branch or worktree name.',
    'The `body` markdown must include:',
    "- **Summary**: What changed and why (1-3 bullet points)",
    "- **Test plan**: Explicit steps that verify the changes work correctly",
  ];

  if (platform === "react" || platform === "ios") {
    const tool = platform === "react" ? "Playwright" : "XcodeBuildMCP";
    lines.push(
      "- Inspect the diff and determine whether it includes a user-visible UI change",
      `- If it does, include a **Visual evidence** section where each item states the artifact path, whether it is a screenshot or video, the exact screen/state shown, and that it was captured with ${tool}`,
      "- For interactive UI changes, require video evidence, not screenshots alone",
      "- If it does not, include **Visual evidence**: Not applicable",
    );
  }

  lines.push("", "Output ONLY the JSON object, no other commentary.");
  return lines.join("\n");
}

type PrDraft = {
  title: string;
  body: string;
};

function parsePrDraft(output: string): PrDraft {
  const json = extractJsonBlock(output);
  if (json) {
    try {
      const parsed = JSON.parse(json) as Partial<PrDraft>;
      const title = parsed.title?.trim();
      const body = parsed.body?.trim();
      if (title && body) {
        return { title, body };
      }
    } catch {
      // Fall through to legacy behavior below.
    }
  }

  return {
    title: "",
    body: output.trim(),
  };
}

type LocalStateSnapshot = {
  label: string;
  passLabels?: string[];
  description?: string;
};

function readLocalState(cwd: string): LocalStateSnapshot {
  return JSON.parse(runStateCmd(cwd, ["show"])) as LocalStateSnapshot;
}

function hasPassLabel(cwd: string, label: PassLabel): boolean {
  return (readLocalState(cwd).passLabels ?? []).includes(label);
}

function extractJsonBlock(output: string): string | null {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/) ?? output.match(/(\{[\s\S]*\})/);
  return jsonMatch ? jsonMatch[1].trim() : null;
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

async function runQaPlanReviewPhase(opts: OrchestrateOptions, plan: string, cwd: string): Promise<string> {
  log("QA-PLAN", `Starting with ${llmLabel(opts.qaLlm)}...`);
  const updatedPlan = await runPrintMode(
    opts.qaLlm,
    buildQaPlanReviewPrompt(opts.task, plan),
    cwd,
    "qa-plan-review",
  );
  const planPath = join(cwd, ".plan.md");
  writeFileSync(planPath, updatedPlan);
  log("QA-PLAN", "Complete.");
  return updatedPlan;
}

// ---------------------------------------------------------------------------
// Phase 3: Implement
// ---------------------------------------------------------------------------

async function runImplementPhase(opts: OrchestrateOptions, plan: string, cwd: string): Promise<void> {
  log("IMPLEMENT", `Starting with ${llmLabel(opts.implementLlm)}...`);
  const platform = detectPlatformFromDiff(cwd, "main");
  const prompt = buildImplementPrompt(plan, platform);

  await runAgenticMode(opts.implementLlm, prompt, cwd, "implement");
  log("IMPLEMENT", "Complete.");
}

// ---------------------------------------------------------------------------
// Phase 4: PR Review
// ---------------------------------------------------------------------------

function runStateCmd(
  cwd: string,
  args: string[],
  options?: { stdin?: string },
): string {
  const ironshaRoot = resolve(import.meta.dirname, "..");
  const cliPath = join(ironshaRoot, "dist", "local", "cli.js");
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
    input: options?.stdin,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function runPrCiPhase(
  llm: LlmConfig,
  cwd: string,
  phase: string,
  logPhase: string = "PR-REVIEW",
): Promise<void> {
  const buildResult = await runBuildAndTests(cwd);
  if (buildResult.success) {
    log(logPhase, "Local build/tests passed.");
    return;
  }

  log(logPhase, "Local build/tests failed; invoking fixer...");
  await runAgenticMode(
    llm,
    [
      "The project's build/test commands have already been discovered and run locally.",
      "Do NOT search AGENTS.md, CLAUDE.md, README.md, or scan the repository for commands.",
      "Use the failing output below to fix the issues, then re-run the same build/test commands until they all pass.",
      "Only output a concise summary of what you fixed and confirm the commands passed.",
      "",
      "## Failing build/test output",
      "```",
      buildResult.output,
      "```",
    ].join("\n"),
    cwd,
    phase,
  );

  const rerunResult = await runBuildAndTests(cwd);
  if (!rerunResult.success) {
    throw new Error(`Local build/tests still failing after fix pass.\n${rerunResult.output}`);
  }

  log(logPhase, "Local build/tests passed after fix.");
}

type ReviewLoopConfig = {
  logPhase: string;
  reviewLlm: LlmConfig;
  reviewPhasePrefix: string;
  fixPhasePrefix: string;
  ciPhasePrefix: string;
  reviewPhaseFlag: "code" | "qa";
  passLabel: PassLabel;
  approvalMessage: string;
  reviewPrompt: (threadState: string, previousIterations: string) => string;
  fixPrompt: (threadState: string, previousIterations: string) => string;
};

type LoopIterationContext = {
  cycle: number;
  reviewSummary: string;
  reviewEvent: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" | "UNKNOWN";
  reviewCommentBodies: string[];
  fixSummary?: string;
  threadsAddressed: string[];
  ciPassed: boolean;
  notableFailures: string[];
};

function trimSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatPreviousIterations(history: LoopIterationContext[]): string {
  if (history.length === 0) {
    return "No previous iterations.";
  }

  return history.slice(-3).map((entry) => {
    const lines = [
      `Cycle ${entry.cycle} review: ${entry.reviewEvent} - ${trimSingleLine(entry.reviewSummary || "No review summary recorded.")}`,
    ];

    if (entry.reviewCommentBodies.length > 0) {
      lines.push(`Cycle ${entry.cycle} findings: ${entry.reviewCommentBodies.map(trimSingleLine).join(" | ")}`);
    }

    if (entry.fixSummary) {
      lines.push(`Cycle ${entry.cycle} fix: ${trimSingleLine(entry.fixSummary)}`);
    }

    if (entry.threadsAddressed.length > 0) {
      lines.push(`Cycle ${entry.cycle} threads addressed: ${entry.threadsAddressed.join(", ")}`);
    }

    lines.push(`Cycle ${entry.cycle} CI: ${entry.ciPassed ? "passed" : "failed"}`);

    if (entry.notableFailures.length > 0) {
      lines.push(`Cycle ${entry.cycle} notable failures: ${entry.notableFailures.map(trimSingleLine).join(" | ")}`);
    }

    return lines.join("\n");
  }).join("\n\n");
}

export function buildCodeReviewPrompt(
  basePrompt: string,
  archPrompt: string,
  detailedPrompt: string,
  guideContent: string,
  previousIterations: string,
  threadState: string,
  baseBranch: string,
): string {
  return [
    basePrompt,
    "\n---\n",
    archPrompt,
    "\n---\n",
    detailedPrompt,
    guideContent ? `\n---\n${guideContent}` : "",
    "\n---\n\n## Previous Iterations\n",
    previousIterations,
    "\n---\n\n## Current Thread State\n",
    threadState || "(no threads yet)",
    `\n\n## Instructions\nReview the code. Read the diff with \`git diff origin/${baseBranch}...HEAD\`. Perform BOTH architecture and detailed review in a single pass. Output a single JSON block per the format above.`,
  ].join("\n");
}

export function buildQaReviewPrompt(
  qaPrompt: string,
  previousIterations: string,
  threadState: string,
  description: string,
  baseBranch: string,
): string {
  return [
    qaPrompt,
    "\n---\n\n## Previous Iterations\n",
    previousIterations,
    "\n---\n\n## Current PR Description\n",
    description || "(no description)",
    "\n---\n\n## Current Thread State\n",
    threadState || "(no threads yet)",
    `\n\n## Instructions\nReview the implemented feature from a QA perspective. Read the diff with \`git diff origin/${baseBranch}...HEAD\`. Verify the test plan exercises the feature at the product level. For React/web UI changes, require Playwright-driven visual evidence that shows how the app was loaded into the correct state. For iOS UI changes, require XcodeBuildMCP-driven visual evidence that shows how the simulator was loaded into the correct state. For UI changes, verify the PR description includes the right visual evidence, require video/GIF for interactive behavior, confirm the screenshot/video artifacts actually show the implemented feature working correctly, and validate that the screenshot and video links are GitHub-hosted, load successfully from the PR or branch, and render inline for screenshots where GitHub supports it instead of 404ing. Output a single JSON block per the format above.`,
  ].join("\n");
}

async function runReviewFixLoop(cwd: string, config: ReviewLoopConfig): Promise<void> {
  const history: LoopIterationContext[] = [];

  for (let cycle = 1; ; cycle++) {
    log(config.logPhase, `--- Cycle ${cycle} ---`);
    const previousIterations = formatPreviousIterations(history);
    let reviewSummary = "";
    let reviewEvent: LoopIterationContext["reviewEvent"] = "UNKNOWN";
    let reviewCommentBodies: string[] = [];
    let fixSummary: string | undefined;
    let threadsAddressed: string[] = [];
    const notableFailures: string[] = [];

    log(config.logPhase, "Running review...");
    const threadState = runStateCmd(cwd, ["threads", "--phase", config.reviewPhaseFlag]);
    const reviewOutput = await runAgenticMode(
      config.reviewLlm,
      config.reviewPrompt(threadState, previousIterations),
      cwd,
      `${config.reviewPhasePrefix}-${cycle}`,
    );

    const reviewJson = extractJsonBlock(reviewOutput);
    if (reviewJson) {
      try {
        const parsedReview = JSON.parse(reviewJson) as {
          summary?: string;
          event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
          comments?: Array<{ body?: string }>;
        };
        reviewSummary = parsedReview.summary ?? "";
        reviewEvent = parsedReview.event ?? "UNKNOWN";
        reviewCommentBodies = (parsedReview.comments ?? [])
          .map((comment) => comment.body?.trim())
          .filter((body): body is string => Boolean(body));
        runStateCmd(cwd, ["review", "post", "--phase", config.reviewPhaseFlag, "--json", reviewJson]);
      } catch (err) {
        notableFailures.push(`Failed to parse or post review JSON: ${String(err)}`);
        log(config.logPhase, `Failed to post review: ${err}`);
      }
    } else {
      notableFailures.push("Could not extract JSON from review output.");
      log(config.logPhase, "Warning: could not extract JSON from review output");
    }

    const state = readLocalState(cwd);
    log(config.logPhase, `Label after review: ${state.label}`);
    log(config.logPhase, `Pass labels after review: ${(state.passLabels ?? []).join(", ") || "(none)"}`);

    if (hasPassLabel(cwd, config.passLabel)) {
      log(config.logPhase, config.approvalMessage);
      break;
    }

    log(config.logPhase, "Running fix pass...");
    const fixThreadState = runStateCmd(cwd, ["threads", "--phase", config.reviewPhaseFlag]);
    const fixOutput = await runAgenticMode(
      config.reviewLlm,
      config.fixPrompt(fixThreadState, previousIterations),
      cwd,
      `${config.fixPhasePrefix}-${cycle}`,
    );

    const fixJson = extractJsonBlock(fixOutput);
    if (fixJson) {
      try {
        const fixResult = JSON.parse(fixJson) as {
          threads_addressed?: Array<{ thread_id: string; explanation: string }>;
          summary?: string;
        };
        fixSummary = fixResult.summary?.trim();
        threadsAddressed = (fixResult.threads_addressed ?? []).map((thread) => thread.thread_id);
        for (const thread of fixResult.threads_addressed ?? []) {
          try {
            runStateCmd(cwd, ["reply", thread.thread_id, "--body", thread.explanation]);
            runStateCmd(cwd, ["resolve", thread.thread_id]);
          } catch (err) {
            notableFailures.push(`Failed to resolve thread ${thread.thread_id}: ${String(err)}`);
            log(config.logPhase, `Failed to resolve thread ${thread.thread_id}: ${err}`);
          }
        }
      } catch {
        notableFailures.push("Could not parse fix output JSON.");
        log(config.logPhase, "Warning: could not parse fix output JSON");
      }
    } else {
      notableFailures.push("Could not extract JSON from fix output.");
    }

    try {
      runGit(cwd, ["add", "-A"]);
      runGit(cwd, ["commit", "-m", `orchestrate: address ${config.reviewPhaseFlag} review cycle ${cycle}`]);
    } catch {
      log(config.logPhase, "No changes to commit after fix pass.");
    }

    log(config.logPhase, "Re-running CI...");
    let ciPassed = true;
    try {
      await runPrCiPhase(config.reviewLlm, cwd, `${config.ciPhasePrefix}-${cycle}`, config.logPhase);
    } catch (err) {
      ciPassed = false;
      notableFailures.push(`CI rerun failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      history.push({
        cycle,
        reviewSummary,
        reviewEvent,
        reviewCommentBodies,
        fixSummary,
        threadsAddressed,
        ciPassed,
        notableFailures,
      });
    }
  }
}

async function runPrReviewPhase(opts: OrchestrateOptions, cwd: string): Promise<void> {
  log("PR-REVIEW", `Starting with ${llmLabel(opts.prLlm)}...`);

  // --- Setup ---
  log("PR-REVIEW", "Running CI (build/tests)...");
  await runPrCiPhase(opts.prLlm, cwd, "pr-ci");

  log("PR-REVIEW", "Initializing local state...");
  runStateCmd(cwd, ["init"]);
  runStateCmd(cwd, ["label", "set", "bot-review-needed"]);

  log("PR-REVIEW", "Committing changes...");
  try {
    runGit(cwd, ["add", "-A"]);
    runGit(cwd, ["commit", "-m", "orchestrate: implementation changes"]);
  } catch {
    log("PR-REVIEW", "No changes to commit (or already committed).");
  }

  log("PR-REVIEW", "Generating PR description...");
  const baseBranch = "main";
  const platform = detectPlatformFromDiff(cwd, baseBranch);
  const descOutput = await runPrintMode(
    opts.prLlm,
    buildPrDescriptionPrompt(platform),
    cwd,
    "pr-description",
  );
  const prDraft = parsePrDraft(descOutput);
  runStateCmd(cwd, ["description", "set", "--title", prDraft.title], { stdin: prDraft.body });

  // --- Detect platform for review guides ---

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
  const qaReviewPromptBase = readPromptFile("qa-review.md");
  const qaFixPromptBase = readPromptFile("qa-fix.md");

  await runReviewFixLoop(cwd, {
    logPhase: "PR-REVIEW",
    reviewLlm: opts.prLlm,
    reviewPhasePrefix: "pr-review",
    fixPhasePrefix: "pr-fix",
    ciPhasePrefix: "pr-ci",
    reviewPhaseFlag: "code",
    passLabel: "agent-code-review-passed",
    approvalMessage: "Code review passed. Moving to QA review.",
    reviewPrompt: (threadState, previousIterations) => buildCodeReviewPrompt(
      basePrompt,
      archPrompt,
      detailedPrompt,
      guideContent,
      previousIterations,
      threadState,
      baseBranch,
    ),
    fixPrompt: (threadState, previousIterations) => [
      codeFixPrompt,
      "\n---\n\n## Previous Iterations\n",
      previousIterations,
      "\n---\n\n## Current Thread State\n",
      threadState,
      "\n\n## Instructions\nAddress all UNRESOLVED threads. Use the previous-iteration context to avoid repeating failed approaches unless the environment or inputs materially changed. Make code changes, run build/tests, then output the JSON result.",
    ].join("\n"),
  });

  log("QA-REVIEW", `Starting with ${llmLabel(opts.qaLlm)}...`);
  await runReviewFixLoop(cwd, {
    logPhase: "QA-REVIEW",
    reviewLlm: opts.qaLlm,
    reviewPhasePrefix: "qa-review",
    fixPhasePrefix: "qa-fix",
    ciPhasePrefix: "qa-ci",
    reviewPhaseFlag: "qa",
    passLabel: "agent-qa-review-passed",
    approvalMessage: "QA review passed. Moving to publish.",
    reviewPrompt: (threadState, previousIterations) => buildQaReviewPrompt(
      qaReviewPromptBase,
      previousIterations,
      threadState,
      runStateCmd(cwd, ["description"]),
      baseBranch,
    ),
    fixPrompt: (threadState, previousIterations) => [
      qaFixPromptBase,
      "\n---\n\n## Previous Iterations\n",
      previousIterations,
      "\n---\n\n## Current PR Description\n",
      runStateCmd(cwd, ["description"]),
      "\n---\n\n## Current Thread State\n",
      threadState,
      "\n\n## Instructions\nAddress all UNRESOLVED QA threads. Use the previous-iteration context to avoid repeating failed approaches unless the environment or inputs materially changed. Update the PR description and visual evidence artifacts if needed. Make code changes only where required, run build/tests, then output the JSON result.",
    ].join("\n"),
  });

  // Commit any outstanding changes before publish
  try {
    runGit(cwd, ["add", "-A"]);
    runGit(cwd, ["commit", "-m", "orchestrate: final changes"]);
  } catch {
    // Nothing to commit
  }

  // Publish
  log("PR-REVIEW", "Publishing to GitHub...");
  const publishOutput = runStateCmd(cwd, ["publish"]);
  log("PR-REVIEW", publishOutput);

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
  log("SETUP", `  QA:        ${llmLabel(opts.qaLlm)}`);
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

    if (!opts.skipReview) {
      plan = await runQaPlanReviewPhase(opts, plan, worktreePath);
    } else {
      log("QA-PLAN", "Skipped.");
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
