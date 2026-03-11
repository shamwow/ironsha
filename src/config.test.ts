import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_TOKEN ??= "test-token";

const { readConfig, resolveProviderModel } = await import("./config.js");

test("readConfig defaults to Claude and keeps Codex model optional", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
  } as NodeJS.ProcessEnv);

  assert.equal(appConfig.LLM_PROVIDER, "claude");
  assert.equal(appConfig.CLAUDE_MODEL, "claude-opus-4-6");
  assert.equal(appConfig.CODEX_MODEL, "");
});

test("readConfig accepts Codex provider settings", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
    LLM_PROVIDER: "codex",
    CODEX_MODEL: "gpt-5-codex",
  } as NodeJS.ProcessEnv);

  assert.equal(appConfig.LLM_PROVIDER, "codex");
  assert.equal(appConfig.CODEX_MODEL, "gpt-5-codex");
});

test("resolveProviderModel uses the configured model for each provider", () => {
  const appConfig = readConfig({
    GITHUB_TOKEN: "gh-token",
    LLM_PROVIDER: "codex",
    CLAUDE_MODEL: "claude-sonnet-4-6",
    CODEX_MODEL: "gpt-5-codex",
  } as NodeJS.ProcessEnv);

  assert.equal(resolveProviderModel("claude", appConfig), "claude-sonnet-4-6");
  assert.equal(resolveProviderModel("codex", appConfig), "gpt-5-codex");
});

test("readConfig validates LLM_PROVIDER", () => {
  assert.throws(
    () =>
      readConfig({
        GITHUB_TOKEN: "gh-token",
        LLM_PROVIDER: "not-a-provider",
      } as NodeJS.ProcessEnv),
    /must be one of: claude, codex/,
  );
});
