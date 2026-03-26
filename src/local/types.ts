import type { PRInfo } from "../review/types.js";

export type PassLabel =
  | "code-review-passed"
  | "qa-review-passed";

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
  passLabels: PassLabel[];
  checkoutPath: string;
  description?: string;
  reviews: LocalReview[];
  createdAt: string;
  updatedAt: string;
}
