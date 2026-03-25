import { randomBytes } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  mockBinPath: string;
  ghStatePath: string;
}

const fixtures: IntegrationFixture[] = [];

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
    'const { join } = require("node:path");',
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
    '  if (prompt.includes("You are a software engineer implementing a plan.")) {',
    '    const targetDir = join(process.cwd(), "src");',
    "    mkdirSync(targetDir, { recursive: true });",
    '    writeFileSync(join(targetDir, "task.txt"), "Task completed by mock implementer.\\n");',
    '    emit("Implementation complete.");',
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("Write a PR description that includes:")) {',
    "    emit([",
    '      "**Summary**",',
    '      "- Complete the requested task in `src/task.txt`",',
    '      "",',
    '      "**Test plan**",',
    '      "- Run `node scripts/verify-task.js`",',
    '    ].join("\\n"));',
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("Perform BOTH architecture and detailed review in a single pass.")) {',
    '    emit(["```json", "{\\"comments\\":[],\\"summary\\":\\"Mock review approval.\\",\\"event\\":\\"APPROVE\\"}", "```"].join("\\n"));',
    "    return;",
    "  }",
    "",
    '  if (prompt.includes("Address all UNRESOLVED threads.")) {',
    '    emit(["```json", "{\\"threads_addressed\\":[]}", "```"].join("\\n"));',
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
    'const { dirname, join } = require("node:path");',
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
    '  } else if (prompt.includes("You are a software engineer implementing a plan.")) {',
    '    const targetDir = join(process.cwd(), "src");',
    "    mkdirSync(targetDir, { recursive: true });",
    '    writeFileSync(join(targetDir, "task.txt"), "Task completed by mock implementer.\\n");',
    '    finalMessage = "Implementation complete.";',
    '  } else if (prompt.includes("Write a PR description that includes:")) {',
    "    finalMessage = [",
    '      "**Summary**",',
    '      "- Complete the requested task in `src/task.txt`",',
    '      "",',
    '      "**Test plan**",',
    '      "- Run `node scripts/verify-task.js`",',
    '    ].join("\\n");',
    '  } else if (prompt.includes("Perform BOTH architecture and detailed review in a single pass.")) {',
    '    finalMessage = ["```json", "{\\"comments\\":[],\\"summary\\":\\"Mock review approval.\\",\\"event\\":\\"APPROVE\\"}", "```"].join("\\n");',
    '  } else if (prompt.includes("Address all UNRESOLVED threads.")) {',
    '    finalMessage = ["```json", "{\\"threads_addressed\\":[]}", "```"].join("\\n");',
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

function createMockGhScript(): string {
  return [
    "#!/usr/bin/env node",
    'const { execFileSync } = require("node:child_process");',
    'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
    "",
    "function loadState() {",
    '  const path = process.env.MOCK_GH_STATE_PATH;',
    '  if (!path) throw new Error("MOCK_GH_STATE_PATH is required");',
    "  if (!existsSync(path)) {",
    "    return { path, state: { pr: null } };",
    "  }",
    '  return { path, state: JSON.parse(readFileSync(path, "utf8")) };',
    "}",
    "",
    "function saveState(path, state) {",
    "  writeFileSync(path, JSON.stringify(state, null, 2));",
    "}",
    "",
    "function parseFlag(args, name) {",
    "  const index = args.indexOf(name);",
    "  return index === -1 ? undefined : args[index + 1];",
    "}",
    "",
    "function readInput(args) {",
    '  return args.includes("--input") ? readFileSync(0, "utf8") : "";',
    "}",
    "",
    "const args = process.argv.slice(2);",
    "const { path: statePath, state } = loadState();",
    "",
    'if (args[0] === "pr" && args[1] === "view") {',
    "  if (!state.pr) process.exit(1);",
    '  const jq = parseFlag(args, "--jq");',
    '  if (jq === ".number") {',
    "    process.stdout.write(String(state.pr.number));",
    "    process.exit(0);",
    "  }",
    '  if (jq === ".url") {',
    "    process.stdout.write(state.pr.url);",
    "    process.exit(0);",
    "  }",
    "  process.stdout.write(JSON.stringify(state.pr));",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "pr" && args[1] === "create") {',
    '  const title = parseFlag(args, "--title") || "";',
    '  const body = parseFlag(args, "--body") || "";',
    '  const base = parseFlag(args, "--base") || "main";',
    '  const headBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {',
    "    cwd: process.cwd(),",
    '    encoding: "utf8",',
    "  }).trim();",
    "  state.pr = {",
    "    number: 1,",
    '    url: "https://github.com/mock/mock-repo/pull/1",',
    "    title,",
    "    body,",
    "    base,",
    "    headBranch,",
    "    reviews: [],",
    "    comments: [],",
    "    labels: [],",
    "  };",
    "  saveState(statePath, state);",
    "  process.stdout.write(state.pr.url);",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "pr" && args[1] === "edit") {',
    "  if (!state.pr) process.exit(1);",
    '  state.pr.body = parseFlag(args, "--body") || state.pr.body;',
    "  saveState(statePath, state);",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "api") {',
    '  const endpoint = args[1] || "";',
    "  const input = readInput(args);",
    "  const payload = input ? JSON.parse(input) : null;",
    "",
    '  if (endpoint.endsWith("/files")) {',
    '    process.stdout.write("[]");',
    "    process.exit(0);",
    "  }",
    "",
    '  if (endpoint.endsWith("/reviews")) {',
    "    if (!state.pr) process.exit(1);",
    "    state.pr.reviews.push(payload);",
    "    saveState(statePath, state);",
    '    process.stdout.write("{}");',
    "    process.exit(0);",
    "  }",
    "",
    '  if (endpoint.endsWith("/comments")) {',
    '    const isPaginate = args.includes("--paginate");',
    "    if (isPaginate) {",
    '      process.stdout.write(JSON.stringify(state.pr?.comments || []));',
    "      process.exit(0);",
    "    }",
    "  }",
    "",
    '  if (/\\/issues\\/\\d+\\/labels\\//.test(endpoint) && args.includes("-X")) {',
    '    const label = endpoint.split("/").pop();',
    "    if (state.pr && label) {",
    '      state.pr.labels = (state.pr.labels || []).filter((entry) => entry !== label);',
    "      saveState(statePath, state);",
    "    }",
    "    process.exit(0);",
    "  }",
    "",
    '  if (endpoint.endsWith("/labels")) {',
    "    if (!state.pr) process.exit(1);",
    "    state.pr.labels = payload?.labels || [];",
    "    saveState(statePath, state);",
    '    process.stdout.write("{}");',
    "    process.exit(0);",
    "  }",
    "",
    '  process.stdout.write("{}");',
    "  process.exit(0);",
    "}",
    "",
    'process.stderr.write("Unsupported gh invocation: " + args.join(" ") + "\\n");',
    "process.exit(1);",
    "",
  ].join("\n");
}

function createIntegrationFixture(runId: string): IntegrationFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "ironsha-orchestrate-"));
  const repoPath = join(rootDir, "repo");
  const remotePath = join(rootDir, "remote.git");
  const mockBinPath = join(rootDir, "mock-bin");
  const ghStatePath = join(rootDir, "gh-state.json");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(mockBinPath, { recursive: true });

  execSync("git init --bare remote.git", { cwd: rootDir, stdio: "pipe" });
  execSync("git init -b main", { cwd: repoPath, stdio: "pipe" });
  setupGitIdentity(repoPath);

  mkdirSync(join(repoPath, "scripts"), { recursive: true });
  mkdirSync(join(repoPath, "src"), { recursive: true });

  writeFileSync(
    join(repoPath, "README.md"),
    [
      "# Integration Fixture",
      "",
      "## Test",
      "```sh",
      "node scripts/verify-task.js",
      "```",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repoPath, "scripts", "verify-task.js"),
    [
      'const { readFileSync } = require("node:fs");',
      'const contents = readFileSync("src/task.txt", "utf8").trim();',
      'if (contents !== "Task completed by mock implementer.") {',
      '  console.error("Task file was not updated correctly.");',
      "  process.exit(1);",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(repoPath, "src", "task.txt"), `TODO ${runId}\n`);

  execSync("git add -A", { cwd: repoPath, stdio: "pipe" });
  execSync('git commit -m "initial fixture"', { cwd: repoPath, stdio: "pipe" });
  execSync(`git remote add origin "${remotePath}"`, { cwd: repoPath, stdio: "pipe" });
  execSync("git push -u origin main", { cwd: repoPath, stdio: "pipe" });

  writeExecutable(join(mockBinPath, "claude"), createMockClaudeScript());
  writeExecutable(join(mockBinPath, "codex"), createMockCodexScript());
  writeExecutable(join(mockBinPath, "gh"), createMockGhScript());
  writeFileSync(ghStatePath, JSON.stringify({ pr: null }, null, 2));

  return { rootDir, repoPath, remotePath, mockBinPath, ghStatePath };
}

function cleanupFixture(fixture: IntegrationFixture): void {
  try {
    rmSync(fixture.rootDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for temporary test repos.
  }
}

describe("orchestrate integration", { timeout: 120_000 }, () => {
  after(() => {
    for (const fixture of fixtures) {
      cleanupFixture(fixture);
    }
  });

  it("completes the task and creates a GitHub PR with mock LLM responses", () => {
    const runId = randomBytes(6).toString("hex");
    const fixture = createIntegrationFixture(runId);
    fixtures.push(fixture);

    const cliPath = join(import.meta.dirname, "..", "cli.js");
    const env = {
      ...process.env,
      PATH: `${fixture.mockBinPath}:${process.env.PATH ?? ""}`,
      MOCK_GH_STATE_PATH: fixture.ghStatePath,
    };

    execFileSync(
      process.execPath,
      [
        cliPath,
        "Complete the task in src/task.txt and open a PR",
        "--plan-llm", "claude:mock",
        "--review-llm", "claude:mock",
        "--implement-llm", "claude:mock",
        "--pr-llm", "claude:mock",
      ],
      {
        cwd: fixture.repoPath,
        env,
        stdio: "pipe",
      },
    );

    const ghState = JSON.parse(readFileSync(fixture.ghStatePath, "utf8")) as {
      pr: {
        number: number;
        title: string;
        body: string;
        base: string;
        headBranch: string;
        labels: string[];
        reviews: Array<{ event: string; body: string }>;
      };
    };

    assert.ok(ghState.pr, "Expected the mock GitHub CLI to record a PR");
    assert.equal(ghState.pr.number, 1);
    assert.equal(ghState.pr.base, "main");
    assert.equal(ghState.pr.title, ghState.pr.headBranch);
    assert.match(ghState.pr.body, /\*\*Summary\*\*/);
    assert.match(ghState.pr.body, /`src\/task\.txt`/);
    assert.match(ghState.pr.body, /`node scripts\/verify-task\.js`/);
    assert.deepEqual(ghState.pr.labels, ["human-review-needed"]);
    assert.equal(ghState.pr.reviews.length, 1);
    assert.equal(ghState.pr.reviews[0]?.event, "APPROVE");

    const pushedTaskContents = execSync(
      `git --git-dir="${fixture.remotePath}" show "${ghState.pr.headBranch}:src/task.txt"`,
      { encoding: "utf8" },
    ).trim();
    assert.equal(pushedTaskContents, "Task completed by mock implementer.");
  });

  it("streams raw codex jsonl into transcripts while still completing the task", () => {
    const runId = randomBytes(6).toString("hex");
    const fixture = createIntegrationFixture(runId);
    fixtures.push(fixture);

    const cliPath = join(import.meta.dirname, "..", "cli.js");
    const ironshaTmpRoot = join(tmpdir(), "ironsha");
    const buildDirsBefore = new Set(
      readdirSync(ironshaTmpRoot, { recursive: false })
        .map((entry) => String(entry))
        .filter((entry) => entry.startsWith("build-")),
    );
    const env = {
      ...process.env,
      PATH: `${fixture.mockBinPath}:${process.env.PATH ?? ""}`,
      MOCK_GH_STATE_PATH: fixture.ghStatePath,
    };

    execFileSync(
      process.execPath,
      [
        cliPath,
        "Complete the task in src/task.txt and open a PR",
        "--plan-llm", "codex:gpt-5.4",
        "--review-llm", "codex:gpt-5.4",
        "--implement-llm", "codex:gpt-5.4",
        "--pr-llm", "codex:gpt-5.4",
      ],
      {
        cwd: fixture.repoPath,
        env,
        stdio: "pipe",
      },
    );

    const buildDirsAfter = readdirSync(ironshaTmpRoot, { recursive: false })
      .map((entry) => String(entry))
      .filter((entry) => entry.startsWith("build-"));
    const newBuildDir = buildDirsAfter.find((entry) => !buildDirsBefore.has(entry));
    assert.ok(newBuildDir, "Expected a new orchestrator transcript directory");

    const transcriptRoot = join(ironshaTmpRoot, newBuildDir);
    const transcriptFiles = execSync(`find "${transcriptRoot}" -type f -name '*.stdout.log' | sort`, {
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    assert.ok(transcriptFiles.length > 0, "Expected codex transcript stdout files");

    const firstTranscript = readFileSync(transcriptFiles[0], "utf8");
    assert.match(firstTranscript, /"type":"session.started"/);
    assert.match(firstTranscript, /"type":"message"/);
    assert.match(firstTranscript, /"output_text"/);
  });
});
