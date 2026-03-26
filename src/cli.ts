import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, createWriteStream, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  command: "build" | "resume";
  task: string;
  worktreeName?: string;
  planFile?: string;
  planLlm: LlmConfig;
  planReviewLlm: LlmConfig;
  planQaReviewLlm: LlmConfig;
  implementLlm: LlmConfig;
  codeReviewLlm: LlmConfig;
  reviewIterations: number;

  skipPlan: boolean;
  skipPlanReview: boolean;
  skipPlanQaReview: boolean;
  skipQaReview: boolean;
  skipImplement: boolean;
  skipCodeReview: boolean;
}

type WorkflowStep =
  | "plan"
  | "plan-review"
  | "qa-plan-review"
  | "implement"
  | "code-review"
  | "qa-review"
  | "publish"
  | "done";

interface WorkflowExecutionOptions {
  skipPlan: boolean;
  skipPlanReview: boolean;
  skipPlanQaReview: boolean;
  skipImplement: boolean;
  skipCodeReview: boolean;
  skipQaReview: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LLM: LlmConfig = { provider: "claude", model: "claude-opus-4-6" };
const VALID_PROVIDERS = ["claude", "codex"] as const;
const MAX_TURNS = 50;

const WORKFLOW_STEPS: WorkflowStep[] = [
  "plan",
  "plan-review",
  "qa-plan-review",
  "implement",
  "code-review",
  "qa-review",
  "publish",
];

const USAGE = `Usage:
  ironsha build "<task description>" [options]
  ironsha resume <worktree-name> [options]
  ironsha "<task description>" [options]

Options:
  --global-llm <provider:model>     LLM for all phases unless overridden per phase
  --plan-llm <provider:model>       LLM for planning (default: claude:claude-opus-4-6)
  --plan-review-llm <provider:model> LLM for plan review (default: claude:claude-opus-4-6)
  --plan-qa-review-llm <provider:model> LLM for QA plan review and QA review (default: claude:claude-opus-4-6)
  --implement-llm <provider:model>  LLM for implementation (default: claude:claude-opus-4-6)
  --code-review-llm <provider:model> LLM for code review (default: claude:claude-opus-4-6)
  --review-iterations <n>           Plan review cycles (default: 1)
  --plan-file <path>                Import an existing plan file and skip plan, plan review, and QA plan review
  --skip-plan                       Skip planning phase
  --skip-plan-review                Skip plan review phase
  --skip-plan-qa-review             Skip QA plan review phase
  --skip-qa-review                  Skip QA review loop
  --skip-implement                  Skip implementation phase
  --skip-code-review                Skip code review and publish phase

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

export function parseArgs(argv: string[]): OrchestrateOptions {
  const rawArgs = argv.slice(2);
  const command = rawArgs[0] === "build" || rawArgs[0] === "resume"
    ? rawArgs[0]
    : "build";
  const args = rawArgs[0] === command && (command === "build" || command === "resume")
    ? rawArgs.slice(1)
    : rawArgs;
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (args[i] === "--skip-plan") { boolFlags.add("skip-plan"); continue; }
    if (args[i] === "--skip-plan-review") { boolFlags.add("skip-plan-review"); continue; }
    if (args[i] === "--skip-plan-qa-review") { boolFlags.add("skip-plan-qa-review"); continue; }
    if (args[i] === "--skip-qa-review") { boolFlags.add("skip-qa-review"); continue; }
    if (args[i] === "--skip-implement") { boolFlags.add("skip-implement"); continue; }
    if (args[i] === "--skip-code-review") { boolFlags.add("skip-code-review"); continue; }
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  const planFile = flags["plan-file"] ? resolve(flags["plan-file"]) : undefined;
  const skipPlan = boolFlags.has("skip-plan");

  if (command === "resume") {
    const worktreeName = positional[0] ?? "";
    if (!worktreeName) {
      console.error("Error: worktree name is required for resume\n");
      console.log(USAGE);
      process.exit(1);
    }
    if (planFile) {
      console.error("Error: --plan-file is only supported with the build command\n");
      process.exit(1);
    }

    const globalLlm = flags["global-llm"] ? parseLlm(flags["global-llm"]) : undefined;
    return {
      command,
      worktreeName,
      task: "",
      planLlm: flags["plan-llm"] ? parseLlm(flags["plan-llm"]) : (globalLlm ?? DEFAULT_LLM),
      planReviewLlm: flags["plan-review-llm"] ? parseLlm(flags["plan-review-llm"]) : (globalLlm ?? DEFAULT_LLM),
      planQaReviewLlm: flags["plan-qa-review-llm"] ? parseLlm(flags["plan-qa-review-llm"]) : (globalLlm ?? DEFAULT_LLM),
      implementLlm: flags["implement-llm"] ? parseLlm(flags["implement-llm"]) : (globalLlm ?? DEFAULT_LLM),
      codeReviewLlm: flags["code-review-llm"] ? parseLlm(flags["code-review-llm"]) : (globalLlm ?? DEFAULT_LLM),
      reviewIterations: flags["review-iterations"] ? parseInt(flags["review-iterations"], 10) : 1,
      skipPlan,
      skipPlanReview: boolFlags.has("skip-plan-review"),
      skipPlanQaReview: boolFlags.has("skip-plan-qa-review"),
      skipQaReview: boolFlags.has("skip-qa-review"),
      skipImplement: boolFlags.has("skip-implement"),
      skipCodeReview: boolFlags.has("skip-code-review"),
    };
  }

  const task = positional[0] ?? "";

  if (planFile && !existsSync(planFile)) {
    console.error(`Error: --plan-file not found: ${planFile}\n`);
    process.exit(1);
  }
  if (planFile) {
    try {
      accessSync(planFile, constants.R_OK);
    } catch {
      console.error(`Error: --plan-file is not readable: ${planFile}\n`);
      process.exit(1);
    }
  }

  if (!task && !skipPlan && !planFile) {
    console.error("Error: task description is required (or use --skip-plan or --plan-file)\n");
    console.log(USAGE);
    process.exit(1);
  }

  const globalLlm = flags["global-llm"] ? parseLlm(flags["global-llm"]) : undefined;

  return {
    command,
    task,
    planFile,
    planLlm: flags["plan-llm"] ? parseLlm(flags["plan-llm"]) : (globalLlm ?? DEFAULT_LLM),
    planReviewLlm: flags["plan-review-llm"] ? parseLlm(flags["plan-review-llm"]) : (globalLlm ?? DEFAULT_LLM),
    planQaReviewLlm: flags["plan-qa-review-llm"] ? parseLlm(flags["plan-qa-review-llm"]) : (globalLlm ?? DEFAULT_LLM),
    implementLlm: flags["implement-llm"] ? parseLlm(flags["implement-llm"]) : (globalLlm ?? DEFAULT_LLM),
    codeReviewLlm: flags["code-review-llm"] ? parseLlm(flags["code-review-llm"]) : (globalLlm ?? DEFAULT_LLM),
    reviewIterations: flags["review-iterations"] ? parseInt(flags["review-iterations"], 10) : 1,
    skipPlan,
    skipPlanReview: boolFlags.has("skip-plan-review"),
    skipPlanQaReview: boolFlags.has("skip-plan-qa-review"),
    skipQaReview: boolFlags.has("skip-qa-review"),
    skipImplement: boolFlags.has("skip-implement"),
    skipCodeReview: boolFlags.has("skip-code-review"),
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

function ensureLogDir(baseDir?: string): string {
  if (!logDir) {
    if (!baseDir) {
      throw new Error("Transcript directory requested before worktree log root was configured.");
    }
    logDir = join(baseDir, ".ironsha", "logs");
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
  const claudeMaxTurnsExceeded = /"subtype":"error_max_turns"/.test(combined);

  if (command === "claude" && claudeRetryCount >= 3) {
    return [
      "claude could not complete the request after repeated API retries.",
      "This usually means your Claude usage is exhausted or the provider is temporarily unavailable.",
      "Check your Claude usage/quota and retry later.",
    ].join("\n");
  }

  if (command === "claude" && claudeMaxTurnsExceeded) {
    return [
      "claude exceeded its turn budget for this invocation.",
      "The invocation was retried once and still exceeded the turn budget.",
      "Reduce task scope or raise the max turn budget if this keeps happening.",
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

async function runLlmModeWithRetry(
  llm: LlmConfig,
  prompt: string,
  cwd: string,
  phase: string,
  mode: "print" | "agentic",
): Promise<string> {
  const maxAttempts = llm.provider === "claude" ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const spec = await buildProviderInvocation({
      provider: llm.provider,
      model: llm.model,
      mode,
      maxTurns: MAX_TURNS,
    });
    const transcript = openTranscriptStreams(phase);
    log("SUBPROCESS", `${spec.command} ${spec.args.join(" ")}`);
    log("SUBPROCESS", `Transcript: ${transcript.stdoutPath}`);

    try {
      return await new Promise((resolve, reject) => {
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
          const shouldRetryForMaxTurns = collector.shouldRetryForMaxTurns();
          await collector.cleanup();
          transcript.stdout.end();
          transcript.stderr.end();
          if (code === 0) {
            resolve(output);
            return;
          }
          if (
            llm.provider === "claude"
            && shouldRetryForMaxTurns
            && attempt < maxAttempts
          ) {
            log("SUBPROCESS", `Claude exceeded max turns during ${phase}; retrying once.`);
            resolve(await runLlmModeWithRetry(llm, prompt, cwd, phase, mode));
            return;
          }
          reject(new Error(formatSubprocessFailure(spec.command, code, collector.getStderr(), output)));
        });

        child.on("error", async (err) => {
          await collector.cleanup();
          reject(err);
        });
      });
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err;
      }
    }
  }

  throw new Error(`Unexpected ${mode} invocation retry failure.`);
}

/**
 * Run an LLM in print mode: pipe prompt via stdin, capture and return stdout.
 */
async function runPrintMode(llm: LlmConfig, prompt: string, cwd: string, phase: string = "print"): Promise<string> {
  return runLlmModeWithRetry(llm, prompt, cwd, phase, "print");
}

/**
 * Run an LLM in agentic mode: pipe prompt via stdin and capture output in transcripts.
 */
async function runAgenticMode(llm: LlmConfig, prompt: string, cwd: string, phase: string = "agentic"): Promise<string> {
  return runLlmModeWithRetry(llm, prompt, cwd, phase, "agentic");
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

function existingWorktreePath(repoRoot: string, worktreeName: string): string {
  return join(repoRoot, ".worktrees", worktreeName);
}

// ---------------------------------------------------------------------------
// Prompt Helpers
// ---------------------------------------------------------------------------

function readPromptFile(name: string): string {
  const srcRoot = resolve(import.meta.dirname, "..");
  return readFileSync(join(srcRoot, "src", "prompts", name), "utf-8");
}

export function renderPromptTemplate(name: string, replacements: Record<string, string>): string {
  let content = readPromptFile(name);
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  const missing = [...new Set([...content.matchAll(/{{([A-Z0-9_]+)}}/g)].map((match) => match[1]))];
  if (missing.length > 0) {
    throw new Error(`Missing required template variables for ${name}: ${missing.join(", ")}`);
  }
  return content;
}

function readGuide(platform: string): string {
  const srcRoot = resolve(import.meta.dirname, "..");
  const guidePath = join(srcRoot, "src", "guides", `${platform.toUpperCase()}_CODE_REVIEW.md`);
  if (existsSync(guidePath)) {
    return readFileSync(guidePath, "utf-8");
  }
  return "";
}

function ensureIronshaDir(cwd: string): string {
  const ironshaDir = join(cwd, ".ironsha");
  mkdirSync(ironshaDir, { recursive: true });
  return ironshaDir;
}

function planFilePath(cwd: string): string {
  return join(cwd, ".ironsha", "plan.md");
}

function stepFilePath(cwd: string): string {
  return join(cwd, ".ironsha", "step.txt");
}

function taskFilePath(cwd: string): string {
  return join(cwd, ".ironsha", "task.txt");
}

function writeWorkflowStep(cwd: string, step: WorkflowStep): void {
  ensureIronshaDir(cwd);
  writeFileSync(stepFilePath(cwd), `${step}\n`);
}

function readWorkflowStep(cwd: string): WorkflowStep {
  const path = stepFilePath(cwd);
  if (!existsSync(path)) {
    throw new Error(`Missing workflow step file: ${path}`);
  }
  const step = readFileSync(path, "utf-8").trim() as WorkflowStep;
  if (!(WORKFLOW_STEPS.includes(step) || step === "done")) {
    throw new Error(`Invalid workflow step in ${path}: ${step || "(empty)"}`);
  }
  return step;
}

function writeTaskFile(cwd: string, task: string): void {
  ensureIronshaDir(cwd);
  writeFileSync(taskFilePath(cwd), task);
}

function readRequiredFile(path: string, description: string): string {
  if (!existsSync(path)) {
    throw new Error(`Missing ${description}: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function isStepEnabled(step: WorkflowStep, opts: WorkflowExecutionOptions): boolean {
  switch (step) {
    case "plan":
      return !opts.skipPlan;
    case "plan-review":
      return !opts.skipPlanReview;
    case "qa-plan-review":
      return !opts.skipPlanQaReview;
    case "implement":
      return !opts.skipImplement;
    case "code-review":
      return !opts.skipCodeReview;
    case "qa-review":
      return !opts.skipCodeReview && !opts.skipQaReview;
    case "publish":
      return !opts.skipCodeReview;
    case "done":
      return true;
  }
}

function firstRunnableStep(opts: WorkflowExecutionOptions): WorkflowStep {
  for (const step of WORKFLOW_STEPS) {
    if (isStepEnabled(step, opts)) return step;
  }
  return "done";
}

function nextRunnableStepAfter(step: WorkflowStep, opts: WorkflowExecutionOptions): WorkflowStep {
  const currentIndex = WORKFLOW_STEPS.indexOf(step);
  for (let i = currentIndex + 1; i < WORKFLOW_STEPS.length; i++) {
    const candidate = WORKFLOW_STEPS[i];
    if (isStepEnabled(candidate, opts)) return candidate;
  }
  return "done";
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
  const artifactRoot = ".ironsha/pr-media/";
  if (platform === "react") {
    return [
      "- Inspect the changed files and determine whether the diff includes a user-visible UI change",
      "- If the diff changes UI, use Playwright to open the app, navigate it into the correct product state, and capture visual evidence before finishing",
      "  - static UI changes: use Playwright to take screenshots that clearly show the updated UI state",
      "  - interactive UI changes: use Playwright to drive the interaction and capture a short video that shows the behavior working",
      `- Save every screenshot and video under \`${artifactRoot}\` and include their exact file paths in your final summary`,
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
      `- Save every screenshot and video under \`${artifactRoot}\` and include their exact file paths in your final summary`,
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
  const uiInstructions = uiEvidenceInstructions(platform);
  return renderPromptTemplate("implement-implement.md", {
    PLAN: plan,
    UI_EVIDENCE_INSTRUCTIONS: uiInstructions.length > 0 ? `\n${uiInstructions.join("\n")}` : "",
  });
}

export function buildPrDescriptionPrompt(platform: string | null): string {
  const visualRequirements: string[] = [];
  if (platform === "react" || platform === "ios") {
    const tool = platform === "react" ? "Playwright" : "XcodeBuildMCP";
    visualRequirements.push(
      "- Inspect the diff and determine whether it includes a user-visible UI change",
      `- If it does, include a **Visual evidence** section where each item states the exact staged \`.ironsha/pr-media/...\` path, whether it is a screenshot or video, the exact screen/state shown, and that it was captured with ${tool}`,
      "- Do not reference repo-local `artifacts/...` paths in the PR description",
      "- Make every visual-evidence caption specific and falsifiable; only describe state that the artifact actually proves",
      "- If the test plan distinguishes baseline, fallback, preset, or other special-case flows, describe those checks using state that is actually unique to each flow",
      "- For interactive UI changes, require video evidence, not screenshots alone",
      "- If it does not, include **Visual evidence**: Not applicable",
    );
  }
  return renderPromptTemplate("code-review-pr-description.md", {
    VISUAL_EVIDENCE_REQUIREMENTS: visualRequirements.length > 0 ? `\n${visualRequirements.join("\n")}` : "",
  });
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

  const prompt = renderPromptTemplate("plan-plan.md", { TASK: opts.task });

  const plan = await runPrintMode(opts.planLlm, prompt, cwd, "plan");
  const planPath = planFilePath(cwd);
  writeFileSync(planPath, plan);
  log("PLAN", `Complete. Saved to .ironsha/plan.md`);
  return plan;
}

// ---------------------------------------------------------------------------
// Phase 2: Review & Iterate
// ---------------------------------------------------------------------------

async function runReviewPhase(opts: OrchestrateOptions, plan: string, cwd: string): Promise<string> {
  let currentPlan = plan;

  for (let i = 1; i <= opts.reviewIterations; i++) {
    log("REVIEW", `Starting iteration ${i}/${opts.reviewIterations} with ${llmLabel(opts.planReviewLlm)}...`);

    const prompt = renderPromptTemplate("plan-review.md", {
      TASK: opts.task,
      PLAN: currentPlan,
    });

    currentPlan = await runPrintMode(opts.planReviewLlm, prompt, cwd, `review-${i}`);
    const planPath = planFilePath(cwd);
    writeFileSync(planPath, currentPlan);
    log("REVIEW", `Iteration ${i}/${opts.reviewIterations} complete.`);
  }

  return currentPlan;
}

async function runQaPlanReviewPhase(opts: OrchestrateOptions, plan: string, cwd: string): Promise<string> {
  log("QA-PLAN", `Starting with ${llmLabel(opts.planQaReviewLlm)}...`);
  const updatedPlan = await runPrintMode(
    opts.planQaReviewLlm,
    buildQaPlanReviewPrompt(opts.task, plan),
    cwd,
    "qa-plan-review",
  );
  const planPath = planFilePath(cwd);
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
    renderPromptTemplate("ci-fix.md", { BUILD_OUTPUT: buildResult.output }),
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
  reviewEvent: "REQUEST_CHANGES" | "APPROVE" | "UNKNOWN";
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
    const reviewDetail = entry.reviewCommentBodies.length > 0
      ? entry.reviewCommentBodies.map(trimSingleLine).join(" | ")
      : "No blocking comments.";
    const lines = [
      `Cycle ${entry.cycle} review: ${entry.reviewEvent} - ${reviewDetail}`,
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
  return renderPromptTemplate("code-review-review.md", {
    BASE_PROMPT: basePrompt,
    ARCH_PROMPT: archPrompt,
    DETAILED_PROMPT: detailedPrompt,
    GUIDE_SECTION: guideContent ? `\n---\n\n${guideContent}` : "",
    PREVIOUS_ITERATIONS: previousIterations,
    THREAD_STATE: threadState || "(no threads yet)",
    BASE_BRANCH: baseBranch,
  });
}

export function buildQaReviewPrompt(
  previousIterations: string,
  threadState: string,
  description: string,
  baseBranch: string,
): string {
  return renderPromptTemplate("qa-review-review.md", {
    PREVIOUS_ITERATIONS: previousIterations,
    DESCRIPTION: description || "(no description)",
    THREAD_STATE: threadState || "(no threads yet)",
    BASE_BRANCH: baseBranch,
  });
}

async function runReviewFixLoop(cwd: string, config: ReviewLoopConfig): Promise<void> {
  const history: LoopIterationContext[] = [];

  for (let cycle = 1; ; cycle++) {
    log(config.logPhase, `--- Cycle ${cycle} ---`);
    const previousIterations = formatPreviousIterations(history);
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
          event?: "REQUEST_CHANGES" | "APPROVE";
          comments?: Array<{ body?: string }>;
        };
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

function commitAllChanges(cwd: string, message: string, logPhase: string): void {
  try {
    runGit(cwd, ["add", "-A"]);
    runGit(cwd, ["commit", "-m", message]);
  } catch {
    log(logPhase, "No changes to commit.");
  }
}

async function ensureReviewPreparation(
  opts: OrchestrateOptions,
  cwd: string,
  config: {
    logPhase: string;
    ciPhasePrefix: string;
    ciLlm: LlmConfig;
    commitMessage: string;
    allowGenerateDescription: boolean;
    forceGenerateDescription?: boolean;
    missingDescriptionError: string;
  },
): Promise<void> {
  log(config.logPhase, "Running CI (build/tests)...");
  await runPrCiPhase(config.ciLlm, cwd, config.ciPhasePrefix, config.logPhase);

  log(config.logPhase, "Initializing local state...");
  runStateCmd(cwd, ["init"]);

  log(config.logPhase, "Committing changes...");
  commitAllChanges(cwd, config.commitMessage, config.logPhase);

  const existingDescription = readLocalState(cwd).description?.trim();
  if (existingDescription && !config.forceGenerateDescription) {
    log(config.logPhase, "Using existing PR description from local state.");
    return;
  }

  if (!config.allowGenerateDescription) {
    throw new Error(config.missingDescriptionError);
  }

  log(config.logPhase, "Generating PR description...");
  const platform = detectPlatformFromDiff(cwd, "main");
  const descOutput = await runPrintMode(
    opts.codeReviewLlm,
    buildPrDescriptionPrompt(platform),
    cwd,
    "pr-description",
  );
  const prDraft = parsePrDraft(descOutput);
  runStateCmd(cwd, ["description", "set", "--title", prDraft.title], { stdin: prDraft.body });
}

function resetReviewPhaseState(cwd: string, phase: "code" | "qa", logPhase: string): void {
  const output = runStateCmd(cwd, ["review", "reset", "--phase", phase]);
  log(logPhase, output);
}

async function runCodeReviewPhase(
  opts: OrchestrateOptions,
  cwd: string,
  options: { allowGenerateDescription: boolean; resetState: boolean },
): Promise<void> {
  log("PR-REVIEW", `Starting with ${llmLabel(opts.codeReviewLlm)}...`);
  await ensureReviewPreparation(opts, cwd, {
    logPhase: "PR-REVIEW",
    ciPhasePrefix: "pr-ci",
    ciLlm: opts.codeReviewLlm,
    commitMessage: "orchestrate: implementation changes",
    allowGenerateDescription: options.allowGenerateDescription,
    forceGenerateDescription: options.resetState,
    missingDescriptionError: "Cannot resume code-review without a saved PR description in local state.",
  });
  if (options.resetState) {
    resetReviewPhaseState(cwd, "code", "PR-REVIEW");
  }

  const baseBranch = "main";
  const platform = detectPlatformFromDiff(cwd, baseBranch);
  const basePrompt = readPromptFile("code-review-base.md");
  const archPrompt = readPromptFile("code-review-architecture-pass.md");
  const detailedPrompt = readPromptFile("code-review-detailed-pass.md");
  const guideContent = platform ? readGuide(platform) : "";
  await runReviewFixLoop(cwd, {
    logPhase: "PR-REVIEW",
    reviewLlm: opts.codeReviewLlm,
    reviewPhasePrefix: "pr-review",
    fixPhasePrefix: "pr-fix",
    ciPhasePrefix: "pr-ci",
    reviewPhaseFlag: "code",
    passLabel: "code-review-passed",
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
    fixPrompt: (threadState, previousIterations) => renderPromptTemplate("code-review-fix.md", {
      PREVIOUS_ITERATIONS: previousIterations,
      THREAD_STATE: threadState,
    }),
  });
}

async function runQaReviewPhase(
  opts: OrchestrateOptions,
  cwd: string,
  options: { resetState: boolean },
): Promise<void> {
  log("QA-REVIEW", `Starting with ${llmLabel(opts.planQaReviewLlm)}...`);
  await ensureReviewPreparation(opts, cwd, {
    logPhase: "QA-REVIEW",
    ciPhasePrefix: "qa-ci",
    ciLlm: opts.planQaReviewLlm,
    commitMessage: "orchestrate: qa review prep",
    allowGenerateDescription: false,
    missingDescriptionError: "Cannot resume qa-review without a saved PR description in local state.",
  });
  if (options.resetState) {
    resetReviewPhaseState(cwd, "qa", "QA-REVIEW");
  }

  const baseBranch = "main";
  await runReviewFixLoop(cwd, {
    logPhase: "QA-REVIEW",
    reviewLlm: opts.planQaReviewLlm,
    reviewPhasePrefix: "qa-review",
    fixPhasePrefix: "qa-fix",
    ciPhasePrefix: "qa-ci",
    reviewPhaseFlag: "qa",
    passLabel: "qa-review-passed",
    approvalMessage: "QA review passed. Moving to publish.",
    reviewPrompt: (threadState, previousIterations) => buildQaReviewPrompt(
      previousIterations,
      threadState,
      runStateCmd(cwd, ["description"]),
      baseBranch,
    ),
    fixPrompt: (threadState, previousIterations) => renderPromptTemplate("qa-review-fix.md", {
      PREVIOUS_ITERATIONS: previousIterations,
      DESCRIPTION: runStateCmd(cwd, ["description"]),
      THREAD_STATE: threadState,
    }),
  });
}

function runPublishPhase(cwd: string): void {
  commitAllChanges(cwd, "orchestrate: final changes", "PR-REVIEW");
  log("PR-REVIEW", "Publishing to GitHub...");
  const publishOutput = runStateCmd(cwd, ["publish"]);
  log("PR-REVIEW", publishOutput);
  log("PR-REVIEW", "Complete.");
}

async function executeWorkflow(
  opts: OrchestrateOptions,
  cwd: string,
  workflowOpts: WorkflowExecutionOptions,
  initialStep: WorkflowStep,
  importedPlan?: string,
): Promise<void> {
  let currentStep = initialStep;
  let plan = importedPlan;
  writeWorkflowStep(cwd, currentStep);

  while (currentStep !== "done") {
    if (!isStepEnabled(currentStep, workflowOpts)) {
      currentStep = nextRunnableStepAfter(currentStep, workflowOpts);
      writeWorkflowStep(cwd, currentStep);
      continue;
    }

    switch (currentStep) {
      case "plan":
        plan = await runPlanPhase(opts, cwd);
        break;
      case "plan-review":
        plan ??= readRequiredFile(planFilePath(cwd), "plan file");
        plan = await runReviewPhase(opts, plan, cwd);
        break;
      case "qa-plan-review":
        plan ??= readRequiredFile(planFilePath(cwd), "plan file");
        plan = await runQaPlanReviewPhase(opts, plan, cwd);
        break;
      case "implement":
        plan ??= readRequiredFile(planFilePath(cwd), "plan file");
        await runImplementPhase(opts, plan, cwd);
        break;
      case "code-review":
        await runCodeReviewPhase(opts, cwd, {
          allowGenerateDescription: opts.command === "build",
          resetState: opts.command === "resume",
        });
        break;
      case "qa-review":
        await runQaReviewPhase(opts, cwd, {
          resetState: opts.command === "resume",
        });
        break;
      case "publish":
        runPublishPhase(cwd);
        break;
    }

    currentStep = nextRunnableStepAfter(currentStep, workflowOpts);
    writeWorkflowStep(cwd, currentStep);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<void> {
  const opts = parseArgs(argv);
  const repoRoot = process.cwd();
  const importedPlan = opts.command === "build" && opts.planFile ? readFileSync(opts.planFile, "utf-8") : undefined;
  const workflowOpts: WorkflowExecutionOptions = {
    skipPlan: Boolean(importedPlan) || opts.skipPlan,
    skipPlanReview: Boolean(importedPlan) || opts.skipPlanReview,
    skipPlanQaReview: Boolean(importedPlan) || opts.skipPlanQaReview,
    skipImplement: opts.skipImplement,
    skipCodeReview: opts.skipCodeReview,
    skipQaReview: opts.skipQaReview,
  };
  logDir = undefined;
  invocationCounter = 0;
  let worktreePath: string;

  if (opts.command === "resume") {
    worktreePath = existingWorktreePath(repoRoot, opts.worktreeName!);
    if (!existsSync(worktreePath)) {
      console.error(`Error: worktree not found: ${worktreePath}`);
      process.exit(1);
    }
    log("SETUP", `Resuming worktree at ${worktreePath}`);
  } else {
    log("SETUP", "Creating git worktree...");
    worktreePath = createWorktree(repoRoot);
    log("SETUP", `Worktree created at ${worktreePath}`);
  }

  log("SETUP", "Configuration:");
  if (opts.planFile) {
    log("SETUP", `  Plan file: ${opts.planFile}`);
  }
  log("SETUP", `  Plan:      ${llmLabel(opts.planLlm)}${workflowOpts.skipPlan ? " (skipped)" : ""}`);
  log("SETUP", `  Plan Review: ${llmLabel(opts.planReviewLlm)} x${opts.reviewIterations}${workflowOpts.skipPlanReview ? " (skipped)" : ""}`);
  log("SETUP", `  Plan QA:     ${llmLabel(opts.planQaReviewLlm)}${workflowOpts.skipPlanQaReview ? " (skipped)" : ""}`);
  log("SETUP", `  Implement: ${llmLabel(opts.implementLlm)}${opts.skipImplement ? " (skipped)" : ""}`);
  log("SETUP", `  Code Review: ${llmLabel(opts.codeReviewLlm)}${opts.skipCodeReview ? " (skipped)" : ""}`);
  log("SETUP", `  Transcripts: ${ensureLogDir(worktreePath)}`);

  try {
    if (opts.command === "build") {
      writeTaskFile(worktreePath, opts.task);
      if (importedPlan) {
        const importedPlanPath = planFilePath(worktreePath);
        ensureIronshaDir(worktreePath);
        writeFileSync(importedPlanPath, importedPlan);
        log("PLAN", `Skipped. Imported existing plan from ${opts.planFile}`);
        log("PLAN", "Saved imported plan to .ironsha/plan.md");
      }
      await executeWorkflow(opts, worktreePath, workflowOpts, firstRunnableStep(workflowOpts), importedPlan);
    } else {
      const savedStep = readWorkflowStep(worktreePath);
      if (savedStep === "done") {
        throw new Error(`Workflow already complete for ${worktreePath}`);
      }
      if (savedStep === "plan" || savedStep === "plan-review" || savedStep === "qa-plan-review") {
        opts.task = readRequiredFile(taskFilePath(worktreePath), "task file");
      }
      if (savedStep === "plan-review" || savedStep === "qa-plan-review" || savedStep === "implement") {
        readRequiredFile(planFilePath(worktreePath), "plan file");
      }
      await executeWorkflow(opts, worktreePath, workflowOpts, savedStep);
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
