import type { PRInfo } from "../review/types.js";

export type BotLabel =
  | "bot-review-needed"
  | "bot-changes-needed"
  | "human-review-needed"
  | "bot-human-intervention";

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
  path: string;
  line: number;
  body: string;
  author: string;
  reactions: LocalReaction[];
  replies: LocalCommentReply[];
  createdAt: string;
}

export interface LocalReview {
  id: string;
  body: string;
  event: "COMMENT" | "REQUEST_CHANGES";
  author: string;
  comments: LocalReviewComment[];
  createdAt: string;
}

export interface LocalPRState {
  version: 1;
  pr: PRInfo;
  label: BotLabel;
  checkoutPath: string;
  description?: string;
  reviews: LocalReview[];
  createdAt: string;
  updatedAt: string;
}
