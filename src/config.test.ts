import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const { readConfig, resolveProviderModel } = await import("./config.js");

test("readConfig defaults", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
  } as NodeJS.ProcessEnv);

  assert.equal(appConfig.CLAUDE_MODEL, "claude-opus-4-6");
  assert.equal(appConfig.CODEX_MODEL, "gpt-5.4");
  assert.equal(appConfig.REVIEW_PROVIDER, "claude");
});

test("resolveProviderModel returns the configured Claude model", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
    CLAUDE_MODEL: "claude-sonnet-4-6",
  } as NodeJS.ProcessEnv);

  assert.equal(resolveProviderModel("claude", appConfig), "claude-sonnet-4-6");
});

test("resolveProviderModel returns the configured Codex model", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
    CODEX_MODEL: "gpt-5.4",
  } as NodeJS.ProcessEnv);

  assert.equal(resolveProviderModel("codex", appConfig), "gpt-5.4");
});
