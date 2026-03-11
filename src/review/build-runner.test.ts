import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const { collectBuildAndTestCommands } = await import("./build-runner.js");

test("collectBuildAndTestCommands reads AGENTS, CLAUDE, and README without duplicates", () => {
  const commands = collectBuildAndTestCommands([
    [
      "## Build",
      "```bash",
      "npm run build",
      "npm test",
      "```",
    ].join("\n"),
    [
      "## Test",
      "```bash",
      "npm test",
      "npm run lint",
      "```",
    ].join("\n"),
    [
      "## Quick Reference",
      "$ npm run lint",
      "$ npm run e2e",
    ].join("\n"),
  ]);

  assert.deepEqual(commands, [
    "npm run build",
    "npm test",
    "npm run lint",
    "npm run e2e",
  ]);
});

test("collectBuildAndTestCommands ignores missing documents", () => {
  const commands = collectBuildAndTestCommands([null, undefined, ""]);
  assert.deepEqual(commands, []);
});
