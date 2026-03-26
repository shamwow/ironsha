import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const {
  buildCodeReviewPrompt,
  buildQaPlanReviewPrompt,
  buildQaReviewPrompt,
  buildImplementPrompt,
  buildPrDescriptionPrompt,
  formatPreviousIterations,
  formatSubprocessFailure,
  parseArgs,
  renderPromptTemplate,
} = await import("./cli.js");
const { rewriteMediaReferencesForGithub } = await import("./local/cli.js");

test("formatSubprocessFailure surfaces provider rate limits clearly", () => {
  const message = formatSubprocessFailure(
    "claude",
    1,
    "",
    "You've hit your limit · resets 5pm (America/New_York)",
  );

  assert.match(message, /hit provider rate limits/i);
  assert.match(message, /resets 5pm/i);
});

test("formatSubprocessFailure includes stderr and output for generic failures", () => {
  const message = formatSubprocessFailure(
    "claude",
    1,
    "something on stderr",
    "some tool output",
  );

  assert.match(message, /claude exited with code 1/);
  assert.match(message, /stderr: something on stderr/);
  assert.match(message, /output: some tool output/);
});

test("formatSubprocessFailure surfaces repeated Claude api retries as usage exhaustion", () => {
  const message = formatSubprocessFailure(
    "claude",
    1,
    "",
    [
      '{"type":"system","subtype":"api_retry","attempt":1,"error":"unknown"}',
      '{"type":"system","subtype":"api_retry","attempt":2,"error":"unknown"}',
      '{"type":"system","subtype":"api_retry","attempt":3,"error":"unknown"}',
    ].join("\n"),
  );

  assert.match(message, /claude could not complete the request/i);
  assert.match(message, /usage is exhausted|provider is temporarily unavailable/i);
});

test("formatSubprocessFailure surfaces repeated Claude max-turn exhaustion clearly", () => {
  const message = formatSubprocessFailure(
    "claude",
    1,
    "",
    '{"type":"result","subtype":"error_max_turns","num_turns":51}',
  );

  assert.match(message, /exceeded its turn budget/i);
  assert.match(message, /retried once/i);
});

test("parseArgs accepts --plan-file without a task and resolves it from cwd", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ironsha-plan-file-"));
  const planPath = join(tempDir, "existing-plan.md");
  writeFileSync(planPath, "# Imported Plan\n");

  const originalCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const opts = parseArgs([
      "node",
      "cli.js",
      "--plan-file",
      "existing-plan.md",
    ]);

    assert.equal(opts.task, "");
    assert.equal(opts.planFile, realpathSync(planPath));
    assert.equal(opts.skipPlan, false);
    assert.equal(opts.skipPlanReview, false);
    assert.equal(opts.skipPlanQaReview, false);
  } finally {
    process.chdir(originalCwd);
  }
});

test("parseArgs supports explicit build command", () => {
  const opts = parseArgs([
    "node",
    "cli.js",
    "build",
    "ship the feature",
  ]);

  assert.equal(opts.command, "build");
  assert.equal(opts.task, "ship the feature");
});

test("parseArgs supports resume with llm and skip flags", () => {
  const opts = parseArgs([
    "node",
    "cli.js",
    "resume",
    "orchestrate-123",
    "--implement-llm",
    "codex:o3",
    "--skip-qa-review",
  ]);

  assert.equal(opts.command, "resume");
  assert.equal(opts.worktreeName, "orchestrate-123");
  assert.equal(opts.task, "");
  assert.equal(opts.implementLlm.provider, "codex");
  assert.equal(opts.implementLlm.model, "o3");
  assert.equal(opts.skipQaReview, true);
});

test("parseArgs prefers --plan-file over relying on --skip-plan worktree state", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ironsha-plan-file-"));
  const planPath = join(tempDir, "imported.md");
  writeFileSync(planPath, "# Imported Plan\n");

  const originalCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const opts = parseArgs([
      "node",
      "cli.js",
      "--skip-plan",
      "--plan-file",
      "imported.md",
    ]);

    assert.equal(opts.planFile, realpathSync(planPath));
    assert.equal(opts.skipPlan, true);
  } finally {
    process.chdir(originalCwd);
  }
});

test("cli exits early with a clear error when --plan-file is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ironsha-plan-file-"));
  const cliPath = join(import.meta.dirname, "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "--plan-file",
      join(tempDir, "missing-plan.md"),
    ],
    {
      cwd: tempDir,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--plan-file not found/i);
  assert.doesNotMatch(result.stderr, /Creating git worktree/i);
});

test("resume exits early with a clear error when the worktree is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ironsha-resume-"));
  const cliPath = join(import.meta.dirname, "cli.js");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "resume",
      "orchestrate-missing",
    ],
    {
      cwd: tempDir,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /worktree not found/i);
  assert.doesNotMatch(result.stderr, /Creating git worktree/i);
});

test("buildImplementPrompt requires visual evidence handling for React UI diffs", () => {
  const prompt = buildImplementPrompt("# Plan", "react");

  assert.match(prompt, /Playwright/i);
  assert.match(prompt, /open the app, navigate it into the correct product state/i);
  assert.match(prompt, /screenshots/i);
  assert.match(prompt, /capture a short video/i);
  assert.match(prompt, /\.ironsha\/pr-media\//i);
  assert.match(prompt, /include their exact file paths in your final summary/i);
});

test("buildImplementPrompt requires XcodeBuildMCP for iOS UI diffs", () => {
  const prompt = buildImplementPrompt("# Plan", "ios");

  assert.match(prompt, /XcodeBuildMCP/i);
  assert.match(prompt, /launch the app in the iOS simulator/i);
  assert.match(prompt, /screenshots/i);
  assert.match(prompt, /capture a short video/i);
  assert.match(prompt, /\.ironsha\/pr-media\//i);
});

test("buildImplementPrompt omits visual evidence instructions for non-UI platforms", () => {
  const prompt = buildImplementPrompt("# Plan", "golang");

  assert.doesNotMatch(prompt, /Visual evidence/i);
  assert.doesNotMatch(prompt, /screenshots/i);
});

test("buildPrDescriptionPrompt requires a Visual evidence section for React and iOS diffs", () => {
  const reactPrompt = buildPrDescriptionPrompt("react");
  const iosPrompt = buildPrDescriptionPrompt("ios");

  assert.match(reactPrompt, /"title": "short PR title"/);
  assert.match(reactPrompt, /must be a concise human-readable PR title, not the branch or worktree name/i);
  assert.match(reactPrompt, /\*\*Visual evidence\*\*/);
  assert.match(reactPrompt, /Playwright/);
  assert.match(reactPrompt, /artifact path, whether it is a screenshot or video, the exact screen\/state shown/i);
  assert.match(reactPrompt, /Not applicable/);
  assert.match(iosPrompt, /\*\*Visual evidence\*\*/);
  assert.match(iosPrompt, /XcodeBuildMCP/);
  assert.match(iosPrompt, /interactive UI changes, require video evidence/i);
});

test("buildPrDescriptionPrompt does not require Visual evidence for non-UI platforms", () => {
  const prompt = buildPrDescriptionPrompt("golang");

  assert.match(prompt, /"title": "short PR title"/);
  assert.doesNotMatch(prompt, /Visual evidence/i);
});

test("buildQaPlanReviewPrompt requires product-level test setup and verification", () => {
  const prompt = buildQaPlanReviewPrompt("Add a button", "# Plan");

  assert.match(prompt, /product-level test plan/i);
  assert.match(prompt, /load the product into the state/i);
  assert.match(prompt, /verify the feature/i);
  assert.match(prompt, /Playwright/i);
  assert.match(prompt, /XcodeBuildMCP/i);
});

test("renderPromptTemplate throws when a required variable is missing", () => {
  assert.throws(
    () => renderPromptTemplate("plan-plan.md", {}),
    /Missing required template variables for plan-plan\.md: TASK/,
  );
});

test("buildQaReviewPrompt requires visual evidence validation for UI changes", () => {
  const prompt = buildQaReviewPrompt(
    "Cycle 1 review: REQUEST_CHANGES - Stage visual evidence under .ironsha/pr-media/ instead of repo-relative artifacts paths.",
    "No existing review threads.",
    "**Visual evidence**\n- artifacts/demo.mp4",
    "main",
  );

  assert.match(prompt, /## Previous Iterations/);
  assert.match(prompt, /Cycle 1 review: REQUEST_CHANGES - Stage visual evidence under .ironsha\/pr-media\/ instead of repo-relative artifacts paths\./);
  assert.match(prompt, /Visual evidence/i);
  assert.match(prompt, /video\/GIF/i);
  assert.match(prompt, /Playwright-driven visual evidence/i);
  assert.match(prompt, /XcodeBuildMCP-driven visual evidence/i);
  assert.match(prompt, /actually show the implemented feature/i);
  assert.match(prompt, /staged under `\.ironsha\/pr-media\/`/i);
  assert.match(prompt, /CLI can publish it during the publish step/i);
  assert.match(prompt, /rather than repo-local `artifacts\/` paths/i);
  assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
});

test("formatPreviousIterations returns a compact summary for prior loop cycles", () => {
  const formatted = formatPreviousIterations([
    {
      cycle: 1,
      reviewEvent: "REQUEST_CHANGES",
      reviewCommentBodies: [
        "Use uploaded GitHub media URLs instead of repo-relative paths.",
      ],
      fixSummary: "Replaced relative paths with uploaded URLs.",
      threadsAddressed: ["thread-1"],
      ciPassed: true,
      notableFailures: ["First screenshot link still rendered as a relative path."],
    },
  ]);

  assert.match(formatted, /Cycle 1 review: REQUEST_CHANGES - Use uploaded GitHub media URLs instead of repo-relative paths\./);
  assert.match(formatted, /Cycle 1 findings: Use uploaded GitHub media URLs instead of repo-relative paths\./);
  assert.match(formatted, /Cycle 1 fix: Replaced relative paths with uploaded URLs\./);
  assert.match(formatted, /Cycle 1 threads addressed: thread-1/);
  assert.match(formatted, /Cycle 1 CI: passed/);
  assert.match(formatted, /Cycle 1 notable failures: First screenshot link still rendered as a relative path\./);
});

test("buildCodeReviewPrompt includes previous iteration context", () => {
  const prompt = buildCodeReviewPrompt(
    "base prompt",
    "architecture prompt",
    "detailed prompt",
    "",
    "Cycle 1 review: REQUEST_CHANGES - Clarify the completed task wording before merge.",
    "### Thread thread-1 (UNRESOLVED)\n- Clarify the completed task wording.",
    "main",
  );

  assert.match(prompt, /## Previous Iterations/);
  assert.match(prompt, /Cycle 1 review: REQUEST_CHANGES - Clarify the completed task wording before merge\./);
  assert.match(prompt, /## Current Thread State/);
  assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
});

test("rewriteMediaReferencesForGithub rewrites all media to pr-media", () => {
  const body = [
    "![Screenshot](./.ironsha/pr-media/mock-ui-screenshot.png)",
    "[Video](./.ironsha/pr-media/mock-ui-demo.mp4)",
  ].join("\n");
  const rewritten = rewriteMediaReferencesForGithub(body, {
    owner: "shamwow",
    repo: "openarena",
    number: 18,
    branch: "feature-branch",
    baseBranch: "main",
    title: "Test PR",
  });

  assert.match(rewritten, /blob\/pr-media\/pr-media\/feature-branch\/\.ironsha\/pr-media\/mock-ui-screenshot\.png\?raw=true/);
  assert.match(rewritten, /blob\/pr-media\/pr-media\/feature-branch\/\.ironsha\/pr-media\/mock-ui-demo\.mp4/);
});
