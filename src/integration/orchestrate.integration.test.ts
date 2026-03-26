import "dotenv/config";
import { randomBytes } from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

interface IntegrationFixture {
  rootDir: string;
  repoPath: string;
  remotePath: string;
  llmMockBinPath: string;
  liveCleanup?: {
    repo: string;
    token: string;
    prNumber?: number;
  };
}

interface LiveGithubConfig {
  token: string;
  repo: string;
  baseBranch: string;
}

const fixtures: IntegrationFixture[] = [];

function getLiveGithubConfig(): LiveGithubConfig | null {
  const token = process.env.LIVE_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const repo = process.env.LIVE_GITHUB_REPO ?? "shamwow/ironsha-ios-test-fixture";
  const baseBranch = process.env.LIVE_GITHUB_BASE_BRANCH ?? "main";

  if (!token) {
    return null;
  }

  return { token, repo, baseBranch };
}

function setupGitIdentity(cwd: string): void {
  execSync('git config user.name "ironsha-test"', { cwd, stdio: "pipe" });
  execSync('git config user.email "test@ironsha"', { cwd, stdio: "pipe" });
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createMockClaudeScript(): string {
  return [
    "#!/usr/bin/env node",
    'const { mkdirSync, writeFileSync } = require("node:fs");',
    'const { basename, join } = require("node:path");',
    "",
    "async function readStdin() {",
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) chunks.push(chunk);",
    '  return Buffer.concat(chunks).toString("utf8");',
    "}",
    "",
    "function emit(text) {",
    "  process.stdout.write(JSON.stringify({",
    '    type: "assistant",',
    '    message: { content: [{ type: "text", text }] },',
    '  }) + "\\n");',
    "}",
    "",
    "function extractThreadIds(prompt) {",
    "  const matches = [...prompt.matchAll(/^### Thread ([^ ]+) \\(/gm)];",
    "  return matches.map((match) => match[1]);",
    "}",
    "",
    "function hasPreviousReviewContext(prompt) {",
    '  return prompt.includes("## Previous Iterations") && prompt.includes("Cycle 1 review: REQUEST_CHANGES - Clarify the completed task wording before merge. | Add a follow-up note for reviewers. [fallback-thread]");',
    "}",
    "",
    "function buildReviewResponse(prompt) {",
    '  if (hasPreviousReviewContext(prompt)) {',
    '    return ["```json", "{\\"comments\\":[],\\"event\\":\\"APPROVE\\"}", "```"].join("\\n");',
    "  }",
    "  return [",
    '    "```json",',
    '    JSON.stringify({',
    '      event: "REQUEST_CHANGES",',
    '      comments: [',
    '        { path: "src/task.txt", line: 1, body: "Clarify the completed task wording before merge." },',
    '        { path: "src/task.txt", line: 999, body: "Add a follow-up note for reviewers. [fallback-thread]" },',
    '      ],',
    '    }),',
    '    "```",',
    '  ].join("\\n");',
    "}",
    "",
    "function buildFixResponse(prompt) {",
    '  const targetDir = join(process.cwd(), "src");',
    "  mkdirSync(targetDir, { recursive: true });",
    '  writeFileSync(join(targetDir, "review-followup.txt"), "Reviewer follow-up addressed.\\n");',
    "  const threads = extractThreadIds(prompt).map((threadId) => ({",
    "    thread_id: threadId,",
    '    explanation: `Addressed review thread ${threadId} with the requested follow-up changes.`,',
    "  }));",
    '  return ["```json", JSON.stringify({ threads_addressed: threads }), "```"].join("\\n");',
    "}",
    "",
    "function writeVisualEvidence() {",
    '  const artifactDir = join(process.cwd(), ".ironsha", "pr-media");',
    "  mkdirSync(artifactDir, { recursive: true });",
    '  writeFileSync(join(artifactDir, "mock-ui-screenshot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yh1cAAAAASUVORK5CYII=", "base64"));',
    '  writeFileSync(join(artifactDir, "mock-ui-demo.mp4"), Buffer.from("AAAAIGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMW1wNDEAABBtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACc3RibAAAAAAAAAABAAABH21kYXQAAAAA", "base64"));',
    "}",
    "",
    "function buildQaReviewResponse(prompt) {",
    '  const hasToolingInstructions = prompt.includes("Playwright-driven visual evidence") && prompt.includes("XcodeBuildMCP-driven visual evidence");',
    '  if (!hasToolingInstructions) {',
    '    return ["```json", JSON.stringify({ event: "REQUEST_CHANGES", comments: [{ path: null, line: null, body: "QA prompt must require Playwright for web UI evidence and XcodeBuildMCP for iOS UI evidence." }] }), "```"].join("\\n");',
    "  }",
    '  return ["```json", "{\\"comments\\":[],\\"event\\":\\"APPROVE\\"}", "```"].join("\\n");',
    "}",
    "",
    "const PLAN = [",
    '  "# Implementation Plan",',
    '  "",',
    '  "1. Update src/task.txt so the requested task is complete.",',
    '  "2. Keep scripts/verify-task.js passing against the new output.",',
    '].join("\\n");',
    "",
    "(async () => {",
    "  const prompt = await readStdin();",
    "",
    '  if (prompt.includes("You are a software architect planning an implementation.")) {',
    "    emit(PLAN);",
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("You are a senior engineer reviewing an implementation plan.")) {',
    "    emit(PLAN);",
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("You are a QA engineer reviewing an implementation plan.")) {',
    "    emit(PLAN);",
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("You are a software engineer implementing a plan.")) {',
    '    const targetDir = join(process.cwd(), "src");',
    "    mkdirSync(targetDir, { recursive: true });",
    '    writeFileSync(join(targetDir, "task.txt"), "Task completed by mock implementer.\\n");',
    "    writeVisualEvidence();",
    '    emit("Implementation complete.");',
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("Output a single JSON object with this shape:")) {',
    '    emit(JSON.stringify({',
    '      title: "Complete the requested task in src/task.txt",',
    '      body: [',
    '        "**Summary**",',
    '        "- Complete the requested task in `src/task.txt`",',
    '        "",',
    '        "**Test plan**",',
    '        "- Run `node scripts/verify-task.js`",',
    '        "",',
    '        "**Visual evidence**",',
    '        "- Screenshot: ![Mock UI screenshot](./.ironsha/pr-media/mock-ui-screenshot.png)",',
    '        "- Video: [Mock UI demo recording](./.ironsha/pr-media/mock-ui-demo.mp4)",',
    '      ].join("\\n"),',
    '    }));',
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("Perform BOTH architecture and detailed review in a single pass.")) {',
    "    emit(buildReviewResponse(prompt));",
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("You are a QA reviewer validating that the implemented feature works at the product level.")) {',
    "    emit(buildQaReviewResponse(prompt));",
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("Address all UNRESOLVED threads.")) {',
    "    emit(buildFixResponse(prompt));",
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("You are an engineer addressing QA review findings.")) {',
    "    emit(buildFixResponse(prompt));",
    "    return;",
    "  }",
    "",
    '  emit("Mock response.");',
    "})().catch((err) => {",
    "  console.error(err);",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

function createMockCodexScript(): string {
  return [
    "#!/usr/bin/env node",
    'const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");',
    'const { basename, dirname, join } = require("node:path");',
    "",
    "async function readStdin() {",
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) chunks.push(chunk);",
    '  return Buffer.concat(chunks).toString("utf8");',
    "}",
    "",
    "function parseFlag(args, name) {",
    "  const index = args.indexOf(name);",
    "  return index === -1 ? undefined : args[index + 1];",
    "}",
    "",
    "function emitJson(event) {",
    '  process.stdout.write(JSON.stringify(event) + "\\n");',
    "}",
    "",
    "function extractThreadIds(prompt) {",
    "  const matches = [...prompt.matchAll(/^### Thread ([^ ]+) \\(/gm)];",
    "  return matches.map((match) => match[1]);",
    "}",
    "",
    "function hasPreviousReviewContext(prompt) {",
    '  return prompt.includes("## Previous Iterations") && prompt.includes("Cycle 1 review: REQUEST_CHANGES - Clarify the completed task wording before merge. | Add a follow-up note for reviewers. [fallback-thread]");',
    "}",
    "",
    "function buildReviewResponse(prompt) {",
    '  if (hasPreviousReviewContext(prompt)) {',
    '    return ["```json", "{\\"comments\\":[],\\"event\\":\\"APPROVE\\"}", "```"].join("\\n");',
    "  }",
    "  return [",
    '    "```json",',
    '    JSON.stringify({',
    '      event: "REQUEST_CHANGES",',
    '      comments: [',
    '        { path: "src/task.txt", line: 1, body: "Clarify the completed task wording before merge." },',
    '        { path: "src/task.txt", line: 999, body: "Add a follow-up note for reviewers. [fallback-thread]" },',
    '      ],',
    '    }),',
    '    "```",',
    '  ].join("\\n");',
    "}",
    "",
    "function buildFixResponse(prompt) {",
    '  const targetDir = join(process.cwd(), "src");',
    "  mkdirSync(targetDir, { recursive: true });",
    '  writeFileSync(join(targetDir, "review-followup.txt"), "Reviewer follow-up addressed.\\n");',
    "  const threads = extractThreadIds(prompt).map((threadId) => ({",
    "    thread_id: threadId,",
    '    explanation: `Addressed review thread ${threadId} with the requested follow-up changes.`,',
    "  }));",
    '  return ["```json", JSON.stringify({ threads_addressed: threads }), "```"].join("\\n");',
    "}",
    "",
    "function writeVisualEvidence() {",
    '  const artifactDir = join(process.cwd(), ".ironsha", "pr-media");',
    "  mkdirSync(artifactDir, { recursive: true });",
    '  writeFileSync(join(artifactDir, "mock-ui-screenshot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yh1cAAAAASUVORK5CYII=", "base64"));',
    '  writeFileSync(join(artifactDir, "mock-ui-demo.mp4"), Buffer.from("AAAAIGZ0eXBpc29tAAAAAGlzb21pc28yYXZjMW1wNDEAABBtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACc3RibAAAAAAAAAABAAABH21kYXQAAAAA", "base64"));',
    "}",
    "",
    "function buildQaReviewResponse(prompt) {",
    '  const hasToolingInstructions = prompt.includes("Playwright-driven visual evidence") && prompt.includes("XcodeBuildMCP-driven visual evidence");',
    '  if (!hasToolingInstructions) {',
    '    return ["```json", JSON.stringify({ event: "REQUEST_CHANGES", comments: [{ path: null, line: null, body: "QA prompt must require Playwright for web UI evidence and XcodeBuildMCP for iOS UI evidence." }] }), "```"].join("\\n");',
    "  }",
    '  return ["```json", "{\\"comments\\":[],\\"event\\":\\"APPROVE\\"}", "```"].join("\\n");',
    "}",
    "",
    "const PLAN = [",
    '  "# Implementation Plan",',
    '  "",',
    '  "1. Update src/task.txt so the requested task is complete.",',
    '  "2. Keep scripts/verify-task.js passing against the new output.",',
    '].join("\\n");',
    "",
    "(async () => {",
    "  const args = process.argv.slice(2);",
    '  const outputPath = parseFlag(args, "--output-last-message");',
    "  if (!outputPath) throw new Error('missing --output-last-message');",
    "  const prompt = await readStdin();",
    '  emitJson({ type: "session.started" });',
    "",
    '  let finalMessage = "Mock response.";',
    '  if (prompt.includes("You are a software architect planning an implementation.")) {',
    "    finalMessage = PLAN;",
    '  } else if (prompt.includes("You are a senior engineer reviewing an implementation plan.")) {',
    "    finalMessage = PLAN;",
    '  } else if (prompt.includes("You are a QA engineer reviewing an implementation plan.")) {',
    "    finalMessage = PLAN;",
    '  } else if (prompt.includes("You are a software engineer implementing a plan.")) {',
    '    const targetDir = join(process.cwd(), "src");',
    "    mkdirSync(targetDir, { recursive: true });",
    '    writeFileSync(join(targetDir, "task.txt"), "Task completed by mock implementer.\\n");',
    "    writeVisualEvidence();",
    '    finalMessage = "Implementation complete.";',
    '  } else if (prompt.includes("Output a single JSON object with this shape:")) {',
    '    finalMessage = JSON.stringify({',
    '      title: "Complete the requested task in src/task.txt",',
    '      body: [',
    '        "**Summary**",',
    '        "- Complete the requested task in `src/task.txt`",',
    '        "",',
    '        "**Test plan**",',
    '        "- Run `node scripts/verify-task.js`",',
    '        "",',
    '        "**Visual evidence**",',
    '        "- Screenshot: ![Mock UI screenshot](./.ironsha/pr-media/mock-ui-screenshot.png)",',
    '        "- Video: [Mock UI demo recording](./.ironsha/pr-media/mock-ui-demo.mp4)",',
    '      ].join("\\n"),',
    '    });',
    '  } else if (prompt.includes("Perform BOTH architecture and detailed review in a single pass.")) {',
    "    finalMessage = buildReviewResponse(prompt);",
    '  } else if (prompt.includes("You are a QA reviewer validating that the implemented feature works at the product level.")) {',
    "    finalMessage = buildQaReviewResponse(prompt);",
    '  } else if (prompt.includes("Address all UNRESOLVED threads.")) {',
    "    finalMessage = buildFixResponse(prompt);",
    '  } else if (prompt.includes("You are an engineer addressing QA review findings.")) {',
    "    finalMessage = buildFixResponse(prompt);",
    "  }",
    "",
    '  emitJson({ type: "message", role: "assistant", content: [{ type: "output_text", text: finalMessage }] });',
    '  emitJson({ type: "session.completed" });',
    "  mkdirSync(dirname(outputPath), { recursive: true });",
    '  writeFileSync(outputPath, finalMessage);',
    "})().catch((err) => {",
    "  console.error(err);",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

function createLiveGithubFixture(runId: string, live: LiveGithubConfig): IntegrationFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "ironsha-orchestrate-live-"));
  const repoPath = join(rootDir, "repo");
  const llmMockBinPath = join(rootDir, "mock-llm-bin");
  const remotePath = `https://x-access-token:${live.token}@github.com/${live.repo}.git`;

  mkdirSync(llmMockBinPath, { recursive: true });

  execSync(`git clone --branch "${live.baseBranch}" "${remotePath}" "${repoPath}"`, {
    stdio: "pipe",
  });
  setupGitIdentity(repoPath);

  writeExecutable(join(llmMockBinPath, "claude"), createMockClaudeScript());
  writeExecutable(join(llmMockBinPath, "codex"), createMockCodexScript());

  return {
    rootDir,
    repoPath,
    remotePath,
    llmMockBinPath,
    liveCleanup: { repo: live.repo, token: live.token },
  };
}

function cleanupFixture(fixture: IntegrationFixture): void {
  if (fixture.liveCleanup?.prNumber) {
    try {
      execFileSync(
        "gh",
        [
          "pr",
          "close",
          String(fixture.liveCleanup.prNumber),
          "--repo",
          fixture.liveCleanup.repo,
        ],
        {
          env: { ...process.env, GH_TOKEN: fixture.liveCleanup.token },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch {
      // Best-effort cleanup for live GitHub test runs.
    }
  }
  try {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for temporary test repos.
  }
}

function runGhJson<T>(args: string[], token: string): T {
  const output = execFileSync(
    "gh",
    args,
    {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return JSON.parse(output) as T;
}

describe("orchestrate integration", { timeout: 120_000 }, () => {
  after(() => {
    for (const fixture of fixtures) {
      cleanupFixture(fixture);
    }
  });

  it(
    "publishes a real GitHub PR from the build workflow using mock LLM responses",
    { skip: !getLiveGithubConfig() },
    () => {
      const live = getLiveGithubConfig();
      assert.ok(
        live,
        "Expected GITHUB_TOKEN for live GitHub integration",
      );

      const [owner, repo] = live.repo.split("/");
      assert.ok(owner && repo, "LIVE_GITHUB_REPO must be in owner/repo format");

      const runId = randomBytes(6).toString("hex");
      const fixture = createLiveGithubFixture(runId, live);
      fixtures.push(fixture);

      const cliPath = join(import.meta.dirname, "..", "cli.js");
      const env = {
        ...process.env,
        PATH: `${fixture.llmMockBinPath}:${process.env.PATH ?? ""}`,
        GITHUB_TOKEN: live.token,
        GH_TOKEN: live.token,
      };

      const buildResult = spawnSync(
        process.execPath,
        [
          cliPath,
          "Complete the task in src/task.txt and open a PR",
          "--plan-llm", "codex:gpt-5.4",
          "--review-llm", "codex:gpt-5.4",
          "--qa-llm", "codex:gpt-5.4",
          "--implement-llm", "codex:gpt-5.4",
          "--pr-llm", "codex:gpt-5.4",
        ],
        {
          cwd: fixture.repoPath,
          encoding: "utf8",
          env,
          stdio: "pipe",
        },
      );
      assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout || "build failed");
      const buildOutput = `${buildResult.stdout ?? ""}\n${buildResult.stderr ?? ""}`;
      const prUrlMatch = buildOutput.match(/Published:\s+(https:\/\/github\.com\/[^\s]+\/pull\/(\d+))/);
      assert.ok(prUrlMatch, `Expected build output to include published PR URL.\n${buildOutput}`);
      const prNumber = Number(prUrlMatch[2]);
      assert.ok(Number.isInteger(prNumber) && prNumber > 0, "Expected a valid PR number from build output");
      fixture.liveCleanup ??= { repo: live.repo, token: live.token };
      fixture.liveCleanup.prNumber = prNumber;
      const repoPath = `repos/${live.repo}`;

      type GhPr = {
        number: number;
        title: string;
        body: string;
        baseRefName: string;
        headRefName: string;
        url: string;
        labels: Array<{ name: string }>;
        reviews: Array<{ state: string; body?: string | null }>;
      };
      type GhIssueRendered = {
        body: string;
        body_html?: string;
        body_text?: string;
      };
      type GhReview = {
        id: number;
        state: string;
        body?: string | null;
        submitted_at?: string | null;
      };
      type GhReviewComment = {
        id: number;
        body: string;
        path?: string;
        line?: number | null;
        in_reply_to_id?: number;
        created_at?: string;
      };
      type GhIssueComment = {
        body: string;
        created_at?: string;
      };
      type GhReaction = {
        content: string;
      };

      const prData = runGhJson<GhPr>(
        [
          "pr",
          "view",
          "--repo",
          live.repo,
          String(prNumber),
          "--json",
          "number,title,body,baseRefName,headRefName,url,labels,reviews",
        ],
        live.token,
      );

      assert.equal(prData.number, prNumber);
      assert.equal(prData.baseRefName, live.baseBranch);
      assert.equal(prData.title, "Complete the requested task in src/task.txt");
      const expectedScreenshotUrl = `https://github.com/${live.repo}/blob/pr-media/pr-media/${prData.headRefName}/.ironsha/pr-media/mock-ui-screenshot.png?raw=true`;
      const expectedVideoUrl = `https://github.com/${live.repo}/blob/pr-media/pr-media/${prData.headRefName}/.ironsha/pr-media/mock-ui-demo.mp4`;
      assert.match(prData.body, /\*\*Summary\*\*/);
      assert.match(prData.body, /`src\/task\.txt`/);
      assert.match(prData.body, /`node scripts\/verify-task\.js`/);
      assert.match(prData.body, /\*\*Visual evidence\*\*/);
      assert.match(prData.body, new RegExp(`!\\[Mock UI screenshot\\]\\(${expectedScreenshotUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
      assert.match(prData.body, new RegExp(`\\[Mock UI demo recording\\]\\(${expectedVideoUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
      assert.ok(
        prData.labels.some((label) => label.name === "agent-code-review-passed"),
        "Expected published PR to have the code review pass label",
      );
      assert.ok(
        prData.labels.some((label) => label.name === "agent-qa-review-passed"),
        "Expected published PR to have the QA review pass label",
      );
      assert.ok(
        prData.reviews.some((review) =>
          review.state === "APPROVED" &&
          /Automated code review and QA review passed/.test(review.body ?? "")
        ),
        "Expected published PR to contain an approval review",
      );

      const renderedPr = runGhJson<GhIssueRendered>(
        [
          "api",
          `${repoPath}/issues/${prNumber}`,
          "-H",
          "Accept: application/vnd.github.full+json",
        ],
        live.token,
      );
      assert.match(renderedPr.body, /\*\*Visual evidence\*\*/);
      assert.ok(renderedPr.body_html, "Expected GitHub to return rendered PR HTML");
      assert.match(renderedPr.body_html!, new RegExp(`<img[^>]+${expectedScreenshotUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
      assert.match(renderedPr.body_html!, new RegExp(`<a[^>]+${expectedVideoUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));

      const reviewComments = runGhJson<GhReviewComment[]>(
        ["api", `${repoPath}/pulls/${prNumber}/comments`, "--paginate"],
        live.token,
      );
      const reviews = runGhJson<GhReview[]>(
        ["api", `${repoPath}/pulls/${prNumber}/reviews`, "--paginate"],
        live.token,
      );
      const issueComments = runGhJson<GhIssueComment[]>(
        ["api", `${repoPath}/issues/${prNumber}/comments`, "--paginate"],
        live.token,
      );

      assert.ok(
        !prData.reviews.some((review) => /Mock review requests follow-up changes|Mock review approval after follow-up|Mock QA approval after validating the feature end to end/.test(review.body ?? "")),
        "Did not expect summary-only reviewer or QA reviews to be published",
      );
      assert.ok(
        reviewComments.some((comment) =>
          comment.path === "src/task.txt" &&
          comment.line === 1 &&
          /Clarify the completed task wording/.test(comment.body),
        ) || reviews.some((review) =>
          /\*\*src\/task\.txt:1\*\*/.test(review.body ?? "") &&
          /Clarify the completed task wording/.test(review.body ?? ""),
        ),
        "Expected a reviewer comment on src/task.txt",
      );

      const inlineReply = reviewComments.find((comment) =>
        Boolean(comment.in_reply_to_id) && /Addressed review thread/.test(comment.body),
      );
      assert.ok(inlineReply, "Expected an inline author reply to a reviewer comment");

      assert.ok(
        issueComments.some((comment) => /Addressed review thread/.test(comment.body)),
        "Expected an author fallback comment response on the PR",
      );

      const finalApprovalReview = reviews.find((review) =>
        review.state === "APPROVED" &&
        /Automated code review and QA review passed/.test(review.body ?? ""),
      );
      assert.ok(finalApprovalReview?.submitted_at, "Expected the final approval review with a timestamp");
      assert.ok(inlineReply.created_at, "Expected the inline author reply to have a creation timestamp");
      const fallbackReply = issueComments.find((comment) => /Addressed review thread/.test(comment.body));
      assert.ok(fallbackReply?.created_at, "Expected the fallback author reply to have a creation timestamp");

      const inlineReplyTime = Date.parse(inlineReply.created_at!);
      const fallbackReplyTime = Date.parse(fallbackReply.created_at!);
      const finalApprovalTime = Date.parse(finalApprovalReview.submitted_at!);

      assert.ok(
        Number.isFinite(inlineReplyTime) && Number.isFinite(fallbackReplyTime) &&
          Number.isFinite(finalApprovalTime),
        "Expected valid timestamps for reply and approval events",
      );
      assert.ok(
        inlineReplyTime <= finalApprovalTime,
        "Expected inline author replies to be posted before the final approval review",
      );
      assert.ok(
        fallbackReplyTime <= finalApprovalTime,
        "Expected fallback author replies to be posted before the final approval review",
      );

      const resolvedComment = reviewComments.find((comment) =>
        /Clarify the completed task wording/.test(comment.body),
      );
      if (resolvedComment) {
        const reactions = runGhJson<GhReaction[]>(
          ["api", `${repoPath}/pulls/comments/${resolvedComment.id}/reactions`],
          live.token,
        );
        const reactionKinds = new Set(reactions.map((reaction) => reaction.content));
        assert.ok(
          reactionKinds.has("rocket") && reactionKinds.has("+1"),
          "Expected reviewer resolution reactions on the inline thread",
        );
      } else {
        assert.ok(
          reviews.some((review) =>
            /\*\*src\/task\.txt:1\*\*/.test(review.body ?? "") &&
            /Clarify the completed task wording/.test(review.body ?? ""),
          ),
          "Expected the reviewer finding to be published on the PR even when GitHub does not retain it as a pull comment",
        );
      }

      execSync(`git fetch origin ${prData.headRefName}`, { cwd: fixture.repoPath, stdio: "pipe" });
      const pushedTaskContents = execSync(
        `git show FETCH_HEAD:src/task.txt`,
        { cwd: fixture.repoPath, encoding: "utf8" },
      ).trim();
      assert.equal(pushedTaskContents, "Task completed by mock implementer.");
      execSync(`git fetch origin pr-media`, { cwd: fixture.repoPath, stdio: "pipe" });
      const pushedScreenshot = execSync(
        `git show FETCH_HEAD:pr-media/${prData.headRefName}/.ironsha/pr-media/mock-ui-screenshot.png`,
        { cwd: fixture.repoPath, stdio: "pipe" },
      );
      assert.ok(pushedScreenshot.length > 0, "Expected pr-media branch to include the mock screenshot artifact");
      const pushedVideo = execSync(
        `git show FETCH_HEAD:pr-media/${prData.headRefName}/.ironsha/pr-media/mock-ui-demo.mp4`,
        { cwd: fixture.repoPath, stdio: "pipe" },
      );
      assert.ok(pushedVideo.length > 0, "Expected pr-media branch to include the mock video artifact");
    },
  );
});
