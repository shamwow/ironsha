import { Octokit } from "@octokit/rest";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runReviewPipeline } from "./review/pipeline.js";
import type { PRInfo } from "./review/types.js";

const processing = new Set<string>();

export async function pollForLabel(
  octokit: Octokit,
  label: string,
  handler: (octokit: Octokit, pr: PRInfo) => Promise<void>,
  titleFilter?: string,
): Promise<void> {
  logger.debug({ label }, "Polling for PRs with label (search API)");

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open label:${label}`,
    per_page: 30,
  });

  logger.debug({ matchCount: data.total_count, label }, "Search returned results");

  let items = data.items;

  if (titleFilter) {
    items = items.filter((item) => item.title.includes(titleFilter));
  }

  for (const item of items) {
    // Parse owner/repo from repository_url (https://api.github.com/repos/{owner}/{repo})
    const urlParts = item.repository_url.split("/");
    const owner = urlParts[urlParts.length - 2]!;
    const repo = urlParts[urlParts.length - 1]!;

    const key = `${owner}/${repo}#${item.number}`;
    if (processing.has(key)) {
      logger.debug({ key }, "Skipping PR already being processed");
      continue;
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: item.number,
    });

    const prInfo: PRInfo = {
      owner,
      repo,
      number: item.number,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      title: pr.title,
    };

    processing.add(key);
    logger.info({ pr: key, title: prInfo.title, label }, "Starting pipeline");

    // Run pipeline without awaiting — allows concurrent processing
    handler(octokit, prInfo)
      .catch((err) => {
        logger.error({ pr: key, err }, "Pipeline failed unexpectedly");
      })
      .finally(() => {
        processing.delete(key);
      });
  }
}

async function pollOnce(octokit: Octokit): Promise<void> {
  await pollForLabel(octokit, "bot-review-needed", runReviewPipeline);
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPoller(octokit: Octokit): void {
  logger.info(
    { intervalMs: config.POLL_INTERVAL_MS },
    "Starting poller",
  );

  // Run immediately on start
  pollOnce(octokit).catch((err) => {
    logger.error({ err }, "Initial poll failed");
  });

  intervalId = setInterval(() => {
    pollOnce(octokit).catch((err) => {
      logger.error({ err }, "Poll cycle failed");
    });
  }, config.POLL_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = () => {
    logger.info("Shutting down poller");
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    // Wait for in-progress reviews to complete
    if (processing.size > 0) {
      logger.info(
        { count: processing.size },
        "Waiting for in-progress reviews to complete",
      );
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
