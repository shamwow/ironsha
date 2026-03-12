import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { setLabel } from "../github/labeler.js";
import { postGeneralComment } from "../github/comments.js";
import { makeFooter } from "../shared/footer.js";
import type { PRInfo } from "../review/types.js";
import { checkCI } from "./ci-monitor.js";

export async function handleCIPending(
  octokit: Octokit,
  pr: PRInfo,
  opts: { githubToken: string; botLogin: string },
): Promise<void> {
  const log = logger.child({
    pr: `${pr.owner}/${pr.repo}#${pr.number}`,
  });

  const ciResult = await checkCI(octokit, pr.owner, pr.repo, pr.branch);
  log.info({ state: ciResult.state, summary: ciResult.summary }, "CI check result");

  if (ciResult.state === "passed") {
    await postGeneralComment(
      octokit,
      pr.owner,
      pr.repo,
      pr.number,
      `## CI Passed\n\n${ciResult.summary}\n\nProceeding to review.` +
        makeFooter(randomUUID()),
    );
    await setLabel(octokit, pr.owner, pr.repo, pr.number, "bot-review-needed");
    log.info("CI passed, swapped label to bot-review-needed");
    return;
  }

  if (ciResult.state === "failed") {
    const checkList = ciResult.failedChecks
      .map((c) => {
        const link = c.url ? ` — [details](${c.url})` : "";
        return `- **${c.name}**: ${c.conclusion}${link}`;
      })
      .join("\n");

    await postGeneralComment(
      octokit,
      pr.owner,
      pr.repo,
      pr.number,
      `## CI Failed\n\n${ciResult.summary}\n\n${checkList}\n\nSending back for fixes.` +
        makeFooter(randomUUID()),
    );
    await setLabel(
      octokit,
      pr.owner,
      pr.repo,
      pr.number,
      "bot-changes-needed",
    );
    log.info("CI failed, swapped label to bot-changes-needed");
    return;
  }

  // state === "pending" — check timeout
  const { data: commit } = await octokit.rest.repos.getCommit({
    owner: pr.owner,
    repo: pr.repo,
    ref: pr.branch,
  });

  const commitDate = commit.commit.committer?.date ?? commit.commit.author?.date;
  if (!commitDate) {
    log.warn("Could not determine commit date, skipping timeout check");
    return;
  }

  const elapsed = Date.now() - new Date(commitDate).getTime();

  if (elapsed > config.CI_POLL_TIMEOUT_MS) {
    await postGeneralComment(
      octokit,
      pr.owner,
      pr.repo,
      pr.number,
      `## CI Timeout\n\nCI has been pending for over ${Math.round(config.CI_POLL_TIMEOUT_MS / 60_000)} minutes since the last commit. Sending back for fixes.\n\n${ciResult.summary}` +
        makeFooter(randomUUID()),
    );
    await setLabel(
      octokit,
      pr.owner,
      pr.repo,
      pr.number,
      "bot-changes-needed",
    );
    log.info({ elapsedMs: elapsed }, "CI timed out, swapped label to bot-changes-needed");
    return;
  }

  log.debug(
    { elapsedMs: elapsed, timeoutMs: config.CI_POLL_TIMEOUT_MS },
    "CI still pending, will re-check next cycle",
  );
}
