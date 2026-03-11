import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const {
  buildClaudeInvocation,
  buildCodexInvocation,
} = await import("./agent-runner.js");

test("buildClaudeInvocation preserves the existing Claude CLI contract", () => {
  const invocation = buildClaudeInvocation({
    promptPath: "/tmp/review-bot-prompt.md",
    mcpConfigPath: "/tmp/review-bot-mcp.json",
    model: "claude-opus-4-6",
    maxTurns: 30,
  });

  assert.equal(invocation.command, "claude");
  assert.deepEqual(invocation.args, [
    "--print",
    "--output-format",
    "json",
    "--model",
    "claude-opus-4-6",
    "--max-turns",
    "30",
    "--thinking",
    "enabled",
    "--append-system-prompt-file",
    "/tmp/review-bot-prompt.md",
    "--mcp-config",
    "/tmp/review-bot-mcp.json",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(invocation.cleanupPaths[0], "/tmp/review-bot-mcp.json");
  assert.equal(invocation.env.CLAUDECODE, "");
});

test("buildCodexInvocation wires developer instructions and GitHub MCP overrides", () => {
  const invocation = buildCodexInvocation({
    promptText: "review instructions",
    githubToken: "gh-token",
    outputPath: "/tmp/review-bot-codex-output.txt",
    model: "gpt-5-codex",
  });

  assert.equal(invocation.command, "codex");
  assert.equal(invocation.args[0], "--dangerously-bypass-approvals-and-sandbox");
  assert.equal(invocation.args[1], "exec");
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("--output-last-message"));
  assert.ok(
    invocation.args.includes(
      "developer_instructions=\"review instructions\"",
    ),
  );
  assert.ok(
    invocation.args.includes(
      "project_doc_fallback_filenames=[\"AGENTS.md\",\"CLAUDE.md\"]",
    ),
  );
  assert.ok(invocation.args.includes("mcp_servers.github.enabled=true"));
  assert.ok(invocation.args.includes("mcp_servers.github.required=true"));
  assert.ok(invocation.args.includes("mcp_servers.github.command=\"npx\""));
  assert.ok(
    invocation.args.includes(
      "mcp_servers.github.args=[\"-y\",\"@github/mcp-server\"]",
    ),
  );
  assert.ok(
    invocation.args.includes(
      "mcp_servers.github.env_vars=[\"GITHUB_PERSONAL_ACCESS_TOKEN\"]",
    ),
  );
  assert.ok(invocation.args.includes("--model"));
  assert.equal(invocation.env.GITHUB_PERSONAL_ACCESS_TOKEN, "gh-token");
  assert.equal(invocation.cleanupPaths[0], "/tmp/review-bot-codex-output.txt");
});

test("buildCodexInvocation omits the model flag when CODEX_MODEL is unset", () => {
  const invocation = buildCodexInvocation({
    promptText: "review instructions",
    githubToken: "gh-token",
    outputPath: "/tmp/review-bot-codex-output.txt",
  });

  assert.equal(invocation.args.includes("--model"), false);
});
