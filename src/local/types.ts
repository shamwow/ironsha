import type { PRInfo } from "../review/types.js";

export type StatusLabel =
  | "bot-review-needed"
  | "bot-changes-needed"
  | "bot-human-intervention";

export type PassLabel =
  | "agent-code-review-passed"
  | "agent-qa-review-passed";

export type BotLabel = StatusLabel | PassLabel;

export interface LocalReaction {
  content: "rocket" | "+1";
  author: string;
  createdAt: string;
}

export interface LocalCommentReply {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface LocalReviewComment {
  id: string;
  path: string | null;
  line: number | null;
  body: string;
  author: string;
  reactions: LocalReaction[];
  replies: LocalCommentReply[];
  createdAt: string;
}

export interface LocalReview {
  id: string;
  phase: "code" | "qa";
  event: "REQUEST_CHANGES" | "APPROVE";
  author: string;
  comments: LocalReviewComment[];
  createdAt: string;
}

export interface LocalPRState {
  version: 1;
  pr: PRInfo;
  label: StatusLabel;
  passLabels: PassLabel[];
  checkoutPath: string;
  description?: string;
  reviews: LocalReview[];
  createdAt: string;
  updatedAt: string;
}
