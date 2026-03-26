import type { ReviewComment, PRInfo } from "../review/types.js";

export type ReviewPhase = "code" | "qa";

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
    event: "REQUEST_CHANGES" | "APPROVE",
    phase?: ReviewPhase,
  ): Promise<void>;
  replyToThread(pr: PRInfo, threadId: string, body: string): Promise<void>;

  // Operational messages (build failures, LGTM, errors)
  postGeneralComment(pr: PRInfo, body: string): Promise<void>;

  // Reactions / thread resolution
  addResolvedReactions(pr: PRInfo, commentId: string): Promise<void>;
  fetchResolvedThreadIds(pr: PRInfo, phase?: ReviewPhase): Promise<Set<string>>;
  fetchUnresolvedThreadCount(pr: PRInfo, phase?: ReviewPhase): Promise<number>;

  // Labels
  setLabel(pr: PRInfo, label: string): Promise<void>;

  // Agent context — how to tell the agent about existing threads
  formatThreadStateForAgent(pr: PRInfo, phase?: ReviewPhase): Promise<string>;
}
