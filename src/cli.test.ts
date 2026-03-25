import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const { formatSubprocessFailure } = await import("./cli.js");

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
