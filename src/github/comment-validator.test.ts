import assert from "node:assert/strict";
import test from "node:test";

// Set env before importing logger (which imports config)
process.env.GITHUB_TOKEN ??= "test-token";

const { validateComments } = await import("./comment-validator.js");

const diffableLines = new Map<string, Set<number>>([
  ["src/foo.ts", new Set([10, 11, 12, 13, 14, 20, 21, 22])],
  ["src/bar.ts", new Set([5, 6, 7])],
]);

test("passes through comments on valid diff lines", () => {
  const comments = [
    { path: "src/foo.ts", line: 12, body: "issue here" },
  ];
  const { comments: result, adjustedCount } = validateComments(comments, diffableLines);
  assert.equal(adjustedCount, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "src/foo.ts");
  assert.equal(result[0].line, 12);
});

test("passes through general comments unchanged", () => {
  const comments = [
    { path: null, line: null, body: "general feedback" },
  ];
  const { comments: result, adjustedCount } = validateComments(comments, diffableLines);
  assert.equal(adjustedCount, 0);
  assert.equal(result[0].body, "general feedback");
});

test("snaps to nearest valid line within 5 lines", () => {
  const comments = [
    { path: "src/foo.ts", line: 16, body: "close to line 14" },
  ];
  const { comments: result, adjustedCount } = validateComments(comments, diffableLines);
  assert.equal(adjustedCount, 1);
  assert.equal(result[0].path, "src/foo.ts");
  assert.equal(result[0].line, 14); // snapped from 16 to nearest valid: 14
});

test("converts to general comment when line is too far from diff", () => {
  const comments = [
    { path: "src/foo.ts", line: 100, body: "way off" },
  ];
  const { comments: result, adjustedCount } = validateComments(comments, diffableLines);
  assert.equal(adjustedCount, 1);
  assert.equal(result[0].path, null);
  assert.equal(result[0].line, null);
  assert.ok(result[0].body.includes("**src/foo.ts:100**"));
  assert.ok(result[0].body.includes("way off"));
});

test("converts to general comment when file is not in diff", () => {
  const comments = [
    { path: "src/unknown.ts", line: 5, body: "not in diff" },
  ];
  const { comments: result, adjustedCount } = validateComments(comments, diffableLines);
  assert.equal(adjustedCount, 1);
  assert.equal(result[0].path, null);
  assert.equal(result[0].line, null);
  assert.ok(result[0].body.includes("**src/unknown.ts:5**"));
});

test("handles mixed valid and invalid comments", () => {
  const comments = [
    { path: "src/foo.ts", line: 10, body: "valid" },
    { path: "src/foo.ts", line: 50, body: "invalid" },
    { path: null, line: null, body: "general" },
    { path: "src/bar.ts", line: 6, body: "also valid" },
    { path: "nope.ts", line: 1, body: "file not in diff" },
  ];
  const { comments: result, adjustedCount } = validateComments(comments, diffableLines);
  assert.equal(adjustedCount, 2);
  assert.equal(result[0].path, "src/foo.ts");
  assert.equal(result[1].path, null); // converted
  assert.equal(result[2].path, null); // was already general
  assert.equal(result[3].path, "src/bar.ts");
  assert.equal(result[4].path, null); // converted
});
