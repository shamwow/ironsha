import type { ReviewComment, PRInfo } from "../review/types.js";

export interface FilePatch {
  filename: string;
  patch?: string;
}

export interface StateBackend {
  getBotLogin(): Promise<string>;
  listChangedFiles(pr: PRInfo): Promise<FilePatch[]>;

  // Reviews (inline comments)
  postReview(
    pr: PRInfo,
    comments: ReviewComment[],
    summary: string,
    event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
  ): Promise<void>;
  replyToThread(pr: PRInfo, threadId: string, body: string): Promise<void>;

  // Operational messages (build failures, LGTM, errors)
  postGeneralComment(pr: PRInfo, body: string): Promise<void>;

  // Reactions / thread resolution
  addResolvedReactions(pr: PRInfo, commentId: string): Promise<void>;
  fetchResolvedThreadIds(pr: PRInfo): Promise<Set<string>>;
  fetchUnresolvedThreadCount(pr: PRInfo): Promise<number>;

  // Labels
  setLabel(pr: PRInfo, label: string): Promise<void>;

  // Agent context — how to tell the agent about existing threads
  formatThreadStateForAgent(pr: PRInfo): Promise<string>;
}
