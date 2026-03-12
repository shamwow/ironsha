import { createServer, type Server } from "node:http";
import { App } from "@octokit/app";
import { createNodeMiddleware } from "@octokit/webhooks";
import { Octokit } from "@octokit/rest";
import { logger } from "../logger.js";
import { createApp, getInstallationToken, getBotLogin } from "../auth/app.js";
import { runReviewPipeline } from "../review/pipeline.js";
import { runWritePipeline } from "../writer/pipeline.js";
import { handleCIPending } from "../writer/ci-handler.js";
import type { PRInfo } from "../review/types.js";
import type { AppConfig } from "../config.js";

const processing = new Set<string>();

async function dispatchPipeline(
  app: App,
  installationId: number,
  pr: PRInfo,
  label: string,
): Promise<void> {
  const key = `${pr.owner}/${pr.repo}#${pr.number}`;
  if (processing.has(key)) {
    logger.debug({ key }, "Skipping PR already being processed");
    return;
  }

  processing.add(key);
  logger.info({ pr: key, title: pr.title, label }, "Starting pipeline");

  const run = async () => {
    const githubToken = await getInstallationToken(app, installationId);
    const octokit = new Octokit({ auth: githubToken });
    const botLogin = await getBotLogin(app);
    const opts = { githubToken, botLogin };

    if (label === "bot-review-needed") {
      await runReviewPipeline(octokit, pr, opts);
    } else if (label === "bot-changes-needed") {
      await runWritePipeline(octokit, pr, opts);
    } else if (label === "bot-ci-pending") {
      await handleCIPending(octokit, pr, opts);
    }
  };

  run()
    .catch((err) => {
      logger.error({ pr: key, err }, "Pipeline failed unexpectedly");
    })
    .finally(() => {
      processing.delete(key);
    });
}

export function startWebhookServer(config: AppConfig): Server {
  const app = createApp(config);

  app.webhooks.on("pull_request.labeled", async ({ payload }) => {
    const installationId = payload.installation?.id;
    if (!installationId) {
      logger.warn("pull_request.labeled event missing installation ID");
      return;
    }

    const labelName = payload.label?.name;
    if (
      labelName !== "bot-review-needed" &&
      labelName !== "bot-changes-needed" &&
      labelName !== "bot-ci-pending"
    ) {
      return;
    }

    const pr: PRInfo = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      number: payload.pull_request.number,
      branch: payload.pull_request.head.ref,
      baseBranch: payload.pull_request.base.ref,
      title: payload.pull_request.title,
    };

    await dispatchPipeline(app, installationId, pr, labelName);
  });

  app.webhooks.on("check_suite.completed", async ({ payload }) => {
    const installationId = payload.installation?.id;
    if (!installationId) return;

    const headSha = payload.check_suite.head_sha;
    const githubToken = await getInstallationToken(app, installationId);
    const octokit = new Octokit({ auth: githubToken });

    // Find open PRs for this head SHA
    for (const pullRequest of payload.check_suite.pull_requests) {
      const { data: pr } = await octokit.rest.pulls.get({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: pullRequest.number,
      });

      const labels = pr.labels.map((l: { name?: string }) => l.name);
      if (labels.includes("bot-ci-pending") && pr.head.sha === headSha) {
        const prInfo: PRInfo = {
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          number: pr.number,
          branch: pr.head.ref,
          baseBranch: pr.base.ref,
          title: pr.title,
        };

        await dispatchPipeline(app, installationId, prInfo, "bot-ci-pending");
      }
    }
  });

  app.webhooks.onError((error) => {
    logger.error({ err: error }, "Webhook error");
  });

  const middleware = createNodeMiddleware(app.webhooks);
  const server = createServer(middleware);

  server.listen(config.WEBHOOK_PORT, () => {
    logger.info({ port: config.WEBHOOK_PORT }, "Webhook server listening");
  });

  // Start Smee proxy for local development
  if (config.SMEE_URL) {
    import("smee-client").then(({ default: SmeeClient }) => {
      const smee = new SmeeClient({
        source: config.SMEE_URL,
        target: `http://localhost:${config.WEBHOOK_PORT}/api/github/webhooks`,
        logger: {
          info: (msg: string) => logger.info(msg),
          error: (msg: string) => logger.error(msg),
        },
      });
      smee.start();
      logger.info({ smeeUrl: config.SMEE_URL }, "Smee proxy started");
    }).catch((err) => {
      logger.error({ err }, "Failed to start Smee proxy");
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down webhook server");
    server.close();
    if (processing.size > 0) {
      logger.info(
        { count: processing.size },
        "Waiting for in-progress pipelines to complete",
      );
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}
