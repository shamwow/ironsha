export type AgentProvider = "claude" | "codex";

function optionalProviderEnv(
  name: string,
  fallback: AgentProvider,
  env: NodeJS.ProcessEnv,
): AgentProvider {
  const value = env[name];
  if (!value) return fallback;
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new Error(
    `Environment variable ${name} must be one of: claude, codex. Got: "${value}"`,
  );
}

function optionalEnvFrom(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv,
): string {
  return env[name] ?? fallback;
}

function optionalNumericEnvFrom(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Environment variable ${name} must be a number, got: "${raw}"`,
    );
  }
  return parsed;
}

function requireEnvFrom(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    GITHUB_TOKEN: requireEnvFrom("GITHUB_TOKEN", env),
    ANTHROPIC_API_KEY: optionalEnvFrom("ANTHROPIC_API_KEY", "", env),
    LLM_PROVIDER: optionalProviderEnv("LLM_PROVIDER", "claude", env),
    CLAUDE_MODEL: optionalEnvFrom("CLAUDE_MODEL", "claude-opus-4-6", env),
    CODEX_MODEL: optionalEnvFrom("CODEX_MODEL", "", env),
    MAX_REVIEW_TURNS: optionalNumericEnvFrom("MAX_REVIEW_TURNS", 30, env),
    POLL_INTERVAL_MS: optionalNumericEnvFrom("POLL_INTERVAL_MS", 60_000, env),
    REVIEW_TIMEOUT_MS: optionalNumericEnvFrom("REVIEW_TIMEOUT_MS", 600_000, env),
    WORK_DIR: optionalEnvFrom("WORK_DIR", "/tmp/ironsha", env),
    TRANSCRIPT_DIR: optionalEnvFrom(
      "TRANSCRIPT_DIR",
      "/tmp/ironsha/transcripts",
      env,
    ),
    MAX_WRITE_TURNS: optionalNumericEnvFrom("MAX_WRITE_TURNS", 50, env),
    WRITE_TIMEOUT_MS: optionalNumericEnvFrom("WRITE_TIMEOUT_MS", 900_000, env),
    MAX_REVIEW_CYCLES: optionalNumericEnvFrom("MAX_REVIEW_CYCLES", 5, env),
    CI_POLL_TIMEOUT_MS: optionalNumericEnvFrom("CI_POLL_TIMEOUT_MS", 600_000, env),
    MERGE_CONFLICT_TIMEOUT_MS: optionalNumericEnvFrom(
      "MERGE_CONFLICT_TIMEOUT_MS",
      300_000,
      env,
    ),
    LOG_LEVEL: optionalEnvFrom("LOG_LEVEL", "info", env),
  } as const;
}

export type AppConfig = ReturnType<typeof readConfig>;

export function resolveProviderModel(
  provider: AgentProvider,
  appConfig: AppConfig = config,
): string | undefined {
  return provider === "claude"
    ? appConfig.CLAUDE_MODEL
    : appConfig.CODEX_MODEL || undefined;
}

export const config = readConfig();
