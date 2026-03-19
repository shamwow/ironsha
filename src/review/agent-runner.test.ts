import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const {
  buildClaudeInvocation,
} = await import("./agent-runner.js");

test("buildClaudeInvocation preserves the existing Claude CLI contract", () => {
  const invocation = buildClaudeInvocation({
    promptPath: "/tmp/ironsha-prompt.md",
    mcpConfigPath: "/tmp/ironsha-mcp.json",
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
    "/tmp/ironsha-prompt.md",
    "--mcp-config",
    "/tmp/ironsha-mcp.json",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(invocation.cleanupPaths[0], "/tmp/ironsha-mcp.json");
  assert.equal(invocation.env.CLAUDECODE, "");
});
