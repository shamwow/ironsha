import { Octokit } from "@octokit/rest";
import type { ReviewComment, PRInfo } from "../review/types.js";
import type { StateBackend, FilePatch } from "./backend.js";
import { postReview } from "../github/review-poster.js";
import {
  addResolvedReactions,
  addResolvedReactionsToGeneralComment,
  fetchResolvedThreadIds,
  fetchUnresolvedThreadCount,
  postGeneralComment,
} from "../github/comments.js";
import { setLabel } from "../github/labeler.js";
import { logger } from "../logger.js";

export class GitHubStateBackend implements StateBackend {
  private octokit: Octokit;
  private cachedBotLogin: string | null = null;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  async getBotLogin(): Promise<string> {
    if (this.cachedBotLogin) return this.cachedBotLogin;
    const { data: botUser } = await this.octokit.rest.users.getAuthenticated();
    this.cachedBotLogin = botUser.login;
    return botUser.login;
  }

  async listChangedFiles(pr: PRInfo): Promise<FilePatch[]> {
    const { data: files } = await this.octokit.rest.pulls.listFiles({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    return files.map((f) => ({ filename: f.filename, patch: f.patch }));
  }

  async postReview(
    pr: PRInfo,
    comments: ReviewComment[],
    summary: string,
    event: "COMMENT" | "REQUEST_CHANGES",
  ): Promise<void> {
    await postReview(
      this.octokit,
      pr.owner,
      pr.repo,
      pr.number,
      comments,
      summary,
      event,
    );
  }

  async postGeneralComment(pr: PRInfo, body: string): Promise<void> {
    await postGeneralComment(
      this.octokit,
      pr.owner,
      pr.repo,
      pr.number,
      body,
    );
  }

  async replyToThread(
    pr: PRInfo,
    threadId: string,
    body: string,
  ): Promise<void> {
    const commentId = Number(threadId);
    if (Number.isNaN(commentId)) {
      logger.debug(
        { threadId },
        "Skipping reply — thread_id is not a numeric comment ID",
      );
      return;
    }
    await this.octokit.rest.pulls.createReplyForReviewComment({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      comment_id: commentId,
      body,
    });
  }

  async addResolvedReactions(
    pr: PRInfo,
    commentId: string,
  ): Promise<void> {
    const numericId = Number(commentId);
    if (Number.isNaN(numericId)) {
      logger.debug(
        { commentId },
        "Skipping reaction — commentId is not a numeric ID",
      );
      return;
    }
    try {
      await addResolvedReactions(
        this.octokit,
        pr.owner,
        pr.repo,
        numericId,
        "review_comment",
      );
    } catch (err: any) {
      if (err?.status === 404) {
        logger.info(
          { commentId },
          "Inline reaction 404, falling back to general comment",
        );
        try {
          await addResolvedReactionsToGeneralComment(
            this.octokit,
            pr.owner,
            pr.repo,
            pr.number,
            commentId,
          );
        } catch (fallbackErr) {
          logger.warn(
            { commentId, err: fallbackErr },
            "Failed to add resolved reactions to general comment",
          );
        }
      } else {
        logger.warn({ commentId, err }, "Failed to add resolved reactions");
      }
    }
  }

  async fetchResolvedThreadIds(pr: PRInfo): Promise<Set<string>> {
    const botLogin = await this.getBotLogin();
    return fetchResolvedThreadIds(
      this.octokit,
      pr.owner,
      pr.repo,
      pr.number,
      botLogin,
    );
  }

  async fetchUnresolvedThreadCount(pr: PRInfo): Promise<number> {
    const botLogin = await this.getBotLogin();
    return fetchUnresolvedThreadCount(
      this.octokit,
      pr.owner,
      pr.repo,
      pr.number,
      botLogin,
    );
  }

  async setLabel(pr: PRInfo, label: string): Promise<void> {
    await setLabel(this.octokit, pr.owner, pr.repo, pr.number, label);
  }

  async formatThreadStateForAgent(_pr: PRInfo): Promise<string> {
    return "Use the GitHub MCP tools to read PR comments and threads.";
  }
}
