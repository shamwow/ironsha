import assert from "node:assert/strict";
import test from "node:test";
import { parsePatchLines, buildDiffableLines } from "./diff-lines.js";

test("parsePatchLines extracts added and context lines", () => {
  const patch = [
    "@@ -10,6 +10,8 @@ some context",
    " context line 10",
    " context line 11",
    "+added line 12",
    "+added line 13",
    " context line 14",
    " context line 15",
  ].join("\n");

  const lines = parsePatchLines(patch);
  assert.deepEqual(lines, new Set([10, 11, 12, 13, 14, 15]));
});

test("parsePatchLines handles removed lines without advancing new line number", () => {
  const patch = [
    "@@ -5,5 +5,4 @@ header",
    " context 5",
    "-removed 6",
    "-removed 7",
    "+added 6",
    " context 7",
  ].join("\n");

  const lines = parsePatchLines(patch);
  // new side: 5 (context), 6 (added), 7 (context)
  assert.deepEqual(lines, new Set([5, 6, 7]));
});

test("parsePatchLines handles multiple hunks", () => {
  const patch = [
    "@@ -1,3 +1,4 @@ first hunk",
    " line 1",
    "+added line 2",
    " line 3",
    " line 4",
    "@@ -20,3 +21,3 @@ second hunk",
    " line 21",
    "-old line 22",
    "+new line 22",
    " line 23",
  ].join("\n");

  const lines = parsePatchLines(patch);
  assert.deepEqual(lines, new Set([1, 2, 3, 4, 21, 22, 23]));
});

test("parsePatchLines returns empty set for empty patch", () => {
  assert.deepEqual(parsePatchLines(""), new Set());
});

test("buildDiffableLines maps files to their valid lines", () => {
  const files = [
    {
      filename: "src/foo.ts",
      patch: "@@ -1,2 +1,3 @@\n line1\n+line2\n line3",
    },
    {
      filename: "src/bar.ts",
      patch: "@@ -10,2 +10,2 @@\n context\n-old\n+new",
    },
    {
      filename: "binary.png",
      // no patch for binary files
    },
  ];

  const result = buildDiffableLines(files);
  assert.equal(result.size, 3);
  assert.deepEqual(result.get("src/foo.ts"), new Set([1, 2, 3]));
  assert.deepEqual(result.get("src/bar.ts"), new Set([10, 11]));
  assert.deepEqual(result.get("binary.png"), new Set());
});
