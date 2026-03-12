import assert from "node:assert/strict";
import test from "node:test";

process.env.GITHUB_APP_ID ??= "12345";
process.env.GITHUB_APP_PRIVATE_KEY ??= "test-key";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-secret";

const { readConfig, resolveProviderModel } = await import("./config.js");

const baseEnv = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "test-key",
  GITHUB_WEBHOOK_SECRET: "test-secret",
} as NodeJS.ProcessEnv;

test("readConfig defaults to Claude and keeps Codex model optional", () => {
  const appConfig = readConfig(baseEnv);

  assert.equal(appConfig.LLM_PROVIDER, "claude");
  assert.equal(appConfig.CLAUDE_MODEL, "claude-opus-4-6");
  assert.equal(appConfig.CODEX_MODEL, "");
});

test("readConfig accepts Codex provider settings", () => {
  const appConfig = readConfig({
    ...baseEnv,
    LLM_PROVIDER: "codex",
    CODEX_MODEL: "gpt-5-codex",
  } as NodeJS.ProcessEnv);

  assert.equal(appConfig.LLM_PROVIDER, "codex");
  assert.equal(appConfig.CODEX_MODEL, "gpt-5-codex");
});

test("resolveProviderModel uses the configured model for each provider", () => {
  const appConfig = readConfig({
    ...baseEnv,
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
        ...baseEnv,
        LLM_PROVIDER: "not-a-provider",
      } as NodeJS.ProcessEnv),
    /must be one of: claude, codex/,
  );
});

test("readConfig includes app credential fields", () => {
  const appConfig = readConfig(baseEnv);
  assert.equal(appConfig.GITHUB_APP_ID, "12345");
  assert.equal(appConfig.GITHUB_APP_PRIVATE_KEY, "test-key");
  assert.equal(appConfig.GITHUB_WEBHOOK_SECRET, "test-secret");
  assert.equal(appConfig.WEBHOOK_PORT, 3000);
});

test("readConfig throws when required app vars are missing", () => {
  assert.throws(
    () => readConfig({} as NodeJS.ProcessEnv),
    /Missing required environment variable/,
  );
});
