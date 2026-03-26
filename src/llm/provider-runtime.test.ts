import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const {
  buildProviderInput,
  buildProviderInvocation,
  ProviderOutputCollector,
} = await import("./provider-runtime.js");

test("buildProviderInvocation preserves the Claude review CLI contract", async () => {
  const invocation = await buildProviderInvocation({
    provider: "claude",
    model: "claude-opus-4-6",
    mode: "review",
    promptPath: "/tmp/ironsha-prompt.md",
    githubToken: "gh-test-token",
    maxTurns: 30,
  });

  assert.equal(invocation.command, "claude");
  assert.deepEqual(invocation.args.slice(0, 11), [
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
  ]);
  assert.ok(invocation.args.includes("--mcp-config"));
  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.equal(invocation.env.CLAUDECODE, "");
  assert.equal(invocation.displayName, "Claude Code");
  assert.equal(invocation.stdoutFormat, "text");
  await Promise.all(invocation.cleanupPaths.map((path: string) => import("node:fs/promises").then((fs) => fs.rm(path, { force: true }))));
});

test("buildProviderInvocation uses codex exec for print mode without quiet", async () => {
  const invocation = await buildProviderInvocation({
    provider: "codex",
    model: "gpt-5.4",
    mode: "print",
  });

  assert.equal(invocation.command, "codex");
  assert.deepEqual(invocation.args.slice(0, 8), [
    "exec",
    "--model",
    "gpt-5.4",
    "--json",
    "--output-last-message",
    invocation.outputFilePath,
    "--color",
    "never",
  ]);
  assert.ok(!invocation.args.includes("--quiet"));
  assert.ok(!invocation.args.includes("--full-auto"));
  assert.equal(invocation.args.at(-1), "-");
  assert.equal(invocation.displayName, "Codex");
  assert.equal(invocation.stdoutFormat, "codex-jsonl");
});

test("buildProviderInvocation composes prompt file into codex review stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ironsha-provider-test-"));
  const promptPath = join(dir, "prompt.md");
  writeFileSync(promptPath, "# Prompt\n\nReview this repo carefully.");

  const invocation = await buildProviderInvocation({
    provider: "codex",
    model: "gpt-5.4",
    mode: "review",
    promptPath,
  });

  assert.ok(invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!invocation.args.includes("--full-auto"));
  const input = buildProviderInput(invocation, "User message");
  assert.match(input, /Review this repo carefully/);
  assert.match(input, /User message/);
});

test("ProviderOutputCollector reads codex final output from the output file", async () => {
  const invocation = await buildProviderInvocation({
    provider: "codex",
    model: "gpt-5.4",
    mode: "print",
  });
  writeFileSync(invocation.outputFilePath!, "final codex output\n");

  const collector = new ProviderOutputCollector(invocation, false);
  collector.handleStdout(Buffer.from("streamed progress\n"));

  assert.equal(await collector.finalize(), "final codex output\n");
  await collector.cleanup();
});

test("ProviderOutputCollector preserves raw codex jsonl stdout for transcripts", async () => {
  const invocation = await buildProviderInvocation({
    provider: "codex",
    model: "gpt-5.4",
    mode: "print",
  });
  const collector = new ProviderOutputCollector(invocation, false);
  const eventLine = JSON.stringify({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "streamed text" }],
  }) + "\n";

  collector.handleStdout(Buffer.from(eventLine));

  assert.equal(collector.getStdout(), eventLine);
  await collector.cleanup();
});

test("ProviderOutputCollector extracts Claude assistant text from stream-json output", async () => {
  const invocation = await buildProviderInvocation({
    provider: "claude",
    model: "claude-sonnet-4-6",
    mode: "print",
    maxTurns: 10,
  });
  const collector = new ProviderOutputCollector(invocation, true);

  const streamed = collector.handleStdout(
    Buffer.from(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello from claude" }] },
      }) + "\n",
    ),
  );

  assert.equal(streamed, "hello from claude");
  assert.equal(await collector.finalize(), "hello from claude");
  await collector.cleanup();
});

test("ProviderOutputCollector requests early abort after repeated Claude api retries", async () => {
  const invocation = await buildProviderInvocation({
    provider: "claude",
    model: "claude-sonnet-4-6",
    mode: "print",
    maxTurns: 10,
  });
  const collector = new ProviderOutputCollector(invocation, false);

  collector.handleStdout(
    Buffer.from(
      [
        '{"type":"system","subtype":"api_retry","attempt":1}',
        '{"type":"system","subtype":"api_retry","attempt":2}',
        '{"type":"system","subtype":"api_retry","attempt":3}',
      ].join("\n") + "\n",
    ),
  );

  assert.equal(collector.shouldAbortForProviderFailure(), true);
  await collector.cleanup();
});

test("ProviderOutputCollector marks Claude max-turn exhaustion as retryable", async () => {
  const invocation = await buildProviderInvocation({
    provider: "claude",
    model: "claude-sonnet-4-6",
    mode: "print",
    maxTurns: 10,
  });
  const collector = new ProviderOutputCollector(invocation, false);

  collector.handleStdout(
    Buffer.from(
      '{"type":"result","subtype":"error_max_turns","num_turns":51}\n',
    ),
  );

  assert.equal(collector.shouldRetryForMaxTurns(), true);
  await collector.cleanup();
});
