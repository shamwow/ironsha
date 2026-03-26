import assert from "node:assert/strict";
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

  assert.match(prompt, /Playwright/i);
  assert.match(prompt, /open the app, navigate it into the correct product state/i);
  assert.match(prompt, /screenshots/i);
  assert.match(prompt, /capture a short video/i);
  assert.match(prompt, /include their exact file paths in your final summary/i);
});

test("buildImplementPrompt requires XcodeBuildMCP for iOS UI diffs", () => {
  const prompt = buildImplementPrompt("# Plan", "ios");

  assert.match(prompt, /XcodeBuildMCP/i);
  assert.match(prompt, /launch the app in the iOS simulator/i);
  assert.match(prompt, /screenshots/i);
  assert.match(prompt, /capture a short video/i);
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

test("buildQaReviewPrompt requires visual evidence validation for UI changes", () => {
  const prompt = buildQaReviewPrompt(
    "QA base prompt",
    "Cycle 1 review: REQUEST_CHANGES - Missing uploaded media URLs.",
    "No existing review threads.",
    "**Visual evidence**\n- artifacts/demo.mp4",
    "main",
  );

  assert.match(prompt, /## Previous Iterations/);
  assert.match(prompt, /Cycle 1 review: REQUEST_CHANGES - Missing uploaded media URLs\./);
  assert.match(prompt, /Visual evidence/i);
  assert.match(prompt, /video\/GIF/i);
  assert.match(prompt, /Playwright-driven visual evidence/i);
  assert.match(prompt, /XcodeBuildMCP-driven visual evidence/i);
  assert.match(prompt, /actually show the implemented feature/i);
  assert.match(prompt, /GitHub-hosted/i);
  assert.match(prompt, /load successfully from the PR or branch/i);
  assert.match(prompt, /render inline for screenshots where GitHub supports it instead of 404ing/i);
  assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
});

test("formatPreviousIterations returns a compact summary for prior loop cycles", () => {
  const formatted = formatPreviousIterations([
    {
      cycle: 1,
      reviewSummary: "Missing uploaded GitHub media URLs.",
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

  assert.match(formatted, /Cycle 1 review: REQUEST_CHANGES - Missing uploaded GitHub media URLs\./);
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
    "Cycle 1 review: REQUEST_CHANGES - Clarify task wording.",
    "### Thread thread-1 (UNRESOLVED)\n- Clarify the completed task wording.",
    "main",
  );

  assert.match(prompt, /## Previous Iterations/);
  assert.match(prompt, /Cycle 1 review: REQUEST_CHANGES - Clarify task wording\./);
  assert.match(prompt, /## Current Thread State/);
  assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
});
