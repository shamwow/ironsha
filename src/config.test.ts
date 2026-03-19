import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const { readConfig, resolveProviderModel } = await import("./config.js");

test("readConfig defaults", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
  } as NodeJS.ProcessEnv);

  assert.equal(appConfig.CLAUDE_MODEL, "claude-opus-4-6");
});

test("resolveProviderModel returns the configured Claude model", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
    CLAUDE_MODEL: "claude-sonnet-4-6",
  } as NodeJS.ProcessEnv);

  assert.equal(resolveProviderModel("claude", appConfig), "claude-sonnet-4-6");
});
