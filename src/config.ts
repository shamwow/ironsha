export type AgentProvider = "claude";

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
    CLAUDE_MODEL: optionalEnvFrom("CLAUDE_MODEL", "claude-opus-4-6", env),
    MAX_REVIEW_TURNS: optionalNumericEnvFrom("MAX_REVIEW_TURNS", 30, env),
    POLL_INTERVAL_MS: optionalNumericEnvFrom("POLL_INTERVAL_MS", 120_000, env),
    REVIEW_TIMEOUT_MS: optionalNumericEnvFrom("REVIEW_TIMEOUT_MS", 600_000, env),
    WORK_DIR: optionalEnvFrom("WORK_DIR", "/tmp/ironsha", env),
    TRANSCRIPT_DIR: optionalEnvFrom(
      "TRANSCRIPT_DIR",
      "/tmp/ironsha/transcripts",
      env,
    ),
    LOG_LEVEL: optionalEnvFrom("LOG_LEVEL", "info", env),
  } as const;
}

export type AppConfig = ReturnType<typeof readConfig>;

export function resolveProviderModel(
  _provider: AgentProvider,
  appConfig: AppConfig = config,
): string {
  return appConfig.CLAUDE_MODEL;
}

export const config = readConfig();
