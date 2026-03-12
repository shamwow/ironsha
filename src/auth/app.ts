import { App } from "@octokit/app";
import type { AppConfig } from "../config.js";

let cachedBotLogin: string | undefined;

export function createApp(config: AppConfig): App {
  return new App({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
    webhooks: { secret: config.GITHUB_WEBHOOK_SECRET },
  });
}

export async function getInstallationToken(
  app: App,
  installationId: number,
): Promise<string> {
  const octokit = await app.getInstallationOctokit(installationId);
  const { token } = (await octokit.auth({
    type: "installation",
  })) as { token: string };
  return token;
}

export async function getBotLogin(app: App): Promise<string> {
  if (cachedBotLogin) return cachedBotLogin;
  const response = await app.octokit.request("GET /app");
  const slug = (response.data as { slug?: string }).slug;
  cachedBotLogin = `${slug}[bot]`;
  return cachedBotLogin;
}
