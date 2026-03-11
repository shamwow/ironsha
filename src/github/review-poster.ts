import { Octokit } from "@octokit/rest";
import { logger } from "../logger.js";
import type { ReviewComment } from "../review/types.js";

export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  comments: ReviewComment[],
  summary: string,
  event: "COMMENT" | "REQUEST_CHANGES" = "COMMENT",
): Promise<void> {
  const inlineComments = comments.filter(
    (c): c is ReviewComment & { path: string; line: number } =>
      c.path !== null && c.line !== null,
  );
  const generalComments = comments.filter((c) => c.path === null);

  // Post inline comments as a PR review
  if (inlineComments.length > 0 || summary) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: summary,
        event,
        comments: inlineComments.map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
        })),
      });
    } catch (err: any) {
      // If REQUEST_CHANGES failed because the bot owns the PR, retry
      // the same batch as a plain COMMENT instead of splitting.
      if (
        event === "REQUEST_CHANGES" &&
        err?.status === 422 &&
        String(err?.message).includes("Can not request changes on your own pull request")
      ) {
        logger.info("Cannot REQUEST_CHANGES on own PR, falling back to COMMENT");
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          body: summary,
          event: "COMMENT",
          comments: inlineComments.map((c) => ({
            path: c.path,
            line: c.line,
            body: c.body,
          })),
        });
        // Fall through to post general comments below
      } else {
        // If the batch fails (e.g. "Line could not be resolved"), retry
        // comments individually so one bad line doesn't kill them all
        logger.warn({ err }, "Batch review failed, retrying comments individually");

        // Post summary as a standalone review with no inline comments
        if (summary) {
          await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: prNumber,
            body: summary,
            event: "COMMENT",
            comments: [],
          });
        }

        // Try each inline comment as a single-comment review
        for (const c of inlineComments) {
          try {
            await octokit.rest.pulls.createReview({
              owner,
              repo,
              pull_number: prNumber,
              body: "",
              event: "COMMENT",
              comments: [{ path: c.path, line: c.line, body: c.body }],
            });
          } catch (innerErr) {
            // This specific comment has an unresolvable line — post as general comment instead
            logger.warn(
              { path: c.path, line: c.line, err: innerErr },
              "Inline comment failed, falling back to general comment",
            );
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: prNumber,
              body: `**${c.path}:${c.line}**\n\n${c.body}`,
            });
          }
        }
      }
    }
  }

  // Post general comments separately
  for (const comment of generalComments) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: comment.body,
    });
  }
}
