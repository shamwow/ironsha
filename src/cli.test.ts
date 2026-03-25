import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const {
  buildImplementPrompt,
  buildPrDescriptionPrompt,
  formatSubprocessFailure,
} = await import("./cli.js");

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

test("buildImplementPrompt requires visual evidence handling for React UI diffs", () => {
  const prompt = buildImplementPrompt("# Plan", "react");

  assert.match(prompt, /capture visual evidence/i);
  assert.match(prompt, /screenshots/i);
  assert.match(prompt, /video or GIF/i);
  assert.match(prompt, /include their exact file paths in your final summary/i);
});

test("buildImplementPrompt omits visual evidence instructions for non-UI platforms", () => {
  const prompt = buildImplementPrompt("# Plan", "golang");

  assert.doesNotMatch(prompt, /Visual evidence/i);
  assert.doesNotMatch(prompt, /screenshots/i);
});

test("buildPrDescriptionPrompt requires a Visual evidence section for React and iOS diffs", () => {
  const reactPrompt = buildPrDescriptionPrompt("react");
  const iosPrompt = buildPrDescriptionPrompt("ios");

  assert.match(reactPrompt, /\*\*Visual evidence\*\*/);
  assert.match(reactPrompt, /Not applicable/);
  assert.match(iosPrompt, /\*\*Visual evidence\*\*/);
});

test("buildPrDescriptionPrompt does not require Visual evidence for non-UI platforms", () => {
  const prompt = buildPrDescriptionPrompt("golang");

  assert.doesNotMatch(prompt, /Visual evidence/i);
});
