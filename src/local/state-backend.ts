import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ReviewComment, PRInfo } from "../review/types.js";
import type { StateBackend, FilePatch, ReviewPhase } from "../state/backend.js";
import type {
  LocalPRState,
  LocalReview,
  LocalReviewComment,
  PassLabel,
} from "./types.js";
import { parseGitDiffToFilePatches } from "./git-diff-parser.js";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

const BOT_LOGIN = "ironsha-bot";

export class LocalStateBackend implements StateBackend {
  private state: LocalPRState;
  private statePath: string;

  constructor(checkoutPath: string, pr: PRInfo, stateDir: string) {
    const key = `${pr.owner}-${pr.repo}-${pr.branch}`;
    this.statePath = join(stateDir, `${key}.json`);
    const now = new Date().toISOString();
    this.state = {
      version: 1,
      pr,
      passLabels: [],
      checkoutPath,
      reviews: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Load existing state from disk if it exists. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      this.state = JSON.parse(raw) as LocalPRState;
    } catch {
      // File doesn't exist yet — use initial state
    }
  }

  getState(): LocalPRState {
    return this.state;
  }

  getPassLabels(): PassLabel[] {
    return [...this.state.passLabels];
  }

  async setDescription(description: string): Promise<void> {
    this.state.description = description;
    await this.persist();
  }

  async setTitle(title: string): Promise<void> {
    this.state.pr.title = title;
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const dir = dirname(this.statePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = this.statePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await rename(tmpPath, this.statePath);
  }

  async getBotLogin(): Promise<string> {
    return BOT_LOGIN;
  }

  async listChangedFiles(pr: PRInfo): Promise<FilePatch[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-color", `origin/${pr.baseBranch}...HEAD`],
      { cwd: this.state.checkoutPath, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseGitDiffToFilePatches(stdout);
  }

  async postReview(
    pr: PRInfo,
    comments: ReviewComment[],
    event: "REQUEST_CHANGES" | "APPROVE",
    phase: ReviewPhase = "code",
  ): Promise<void> {
    const now = new Date().toISOString();
    const persistedComments: LocalReviewComment[] = comments
      .map((c) => ({
        id: randomUUID(),
        path: c.path,
        line: c.line,
        body: c.body,
        author: BOT_LOGIN,
        reactions: [],
        replies: [],
        createdAt: now,
      }));

    const review: LocalReview = {
      id: randomUUID(),
      phase,
      event,
      author: BOT_LOGIN,
      comments: persistedComments,
      createdAt: now,
    };

    this.state.reviews.push(review);
    await this.persist();
  }

  async postGeneralComment(_pr: PRInfo, body: string): Promise<void> {
    // Operational messages — log only, not persisted in local state
    logger.info({ body: body.slice(0, 200) }, "Local general comment (not persisted)");
  }

  async replyToThread(
    _pr: PRInfo,
    threadId: string,
    body: string,
  ): Promise<void> {
    // Find the review comment by ID across all reviews
    for (const review of this.state.reviews) {
      const comment = review.comments.find((c) => c.id === threadId);
      if (comment) {
        comment.replies.push({
          id: randomUUID(),
          body,
          author: BOT_LOGIN,
          createdAt: new Date().toISOString(),
        });
        await this.persist();
        return;
      }
    }
    logger.warn({ threadId }, "Could not find comment to reply to");
  }

  async addResolvedReactions(
    _pr: PRInfo,
    commentId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const review of this.state.reviews) {
      const comment = review.comments.find((c) => c.id === commentId);
      if (comment) {
        // Only add if not already present
        const hasRocket = comment.reactions.some(
          (r) => r.content === "rocket" && r.author === BOT_LOGIN,
        );
        const hasThumbsUp = comment.reactions.some(
          (r) => r.content === "+1" && r.author === BOT_LOGIN,
        );
        if (!hasRocket) {
          comment.reactions.push({ content: "rocket", author: BOT_LOGIN, createdAt: now });
        }
        if (!hasThumbsUp) {
          comment.reactions.push({ content: "+1", author: BOT_LOGIN, createdAt: now });
        }
        await this.persist();
        return;
      }
    }
    logger.warn({ commentId }, "Could not find comment to add reactions to");
  }

  private getReviewPhase(review: LocalReview): ReviewPhase {
    return review.phase ?? "code";
  }

  private matchesPhase(review: LocalReview, phase?: ReviewPhase): boolean {
    return !phase || this.getReviewPhase(review) === phase;
  }

  async fetchResolvedThreadIds(_pr: PRInfo, phase?: ReviewPhase): Promise<Set<string>> {
    const resolved = new Set<string>();
    for (const review of this.state.reviews) {
      if (!this.matchesPhase(review, phase)) continue;
      for (const comment of review.comments) {
        if (comment.author !== BOT_LOGIN) continue;
        const hasRocket = comment.reactions.some(
          (r) => r.content === "rocket" && r.author === BOT_LOGIN,
        );
        const hasThumbsUp = comment.reactions.some(
          (r) => r.content === "+1" && r.author === BOT_LOGIN,
        );
        if (hasRocket && hasThumbsUp) {
          resolved.add(comment.id);
        }
      }
    }
    return resolved;
  }

  async fetchUnresolvedThreadCount(_pr: PRInfo, phase?: ReviewPhase): Promise<number> {
    const resolved = await this.fetchResolvedThreadIds(_pr, phase);
    let total = 0;
    for (const review of this.state.reviews) {
      if (!this.matchesPhase(review, phase)) continue;
      for (const comment of review.comments) {
        if (comment.author === BOT_LOGIN) total++;
      }
    }
    return total - resolved.size;
  }

  async addPassLabel(_pr: PRInfo, label: PassLabel): Promise<void> {
    if (!this.state.passLabels.includes(label)) {
      this.state.passLabels.push(label);
      await this.persist();
    }
  }

  async removePassLabel(_pr: PRInfo, label: PassLabel): Promise<void> {
    const next = this.state.passLabels.filter((entry) => entry !== label);
    if (next.length !== this.state.passLabels.length) {
      this.state.passLabels = next;
      await this.persist();
    }
  }

  hasPassLabel(label: PassLabel): boolean {
    return this.state.passLabels.includes(label);
  }

  async clearPassLabels(_pr: PRInfo): Promise<void> {
    if (this.state.passLabels.length > 0) {
      this.state.passLabels = [];
      await this.persist();
    }
  }

  async setPassLabels(_pr: PRInfo, labels: PassLabel[]): Promise<void> {
    this.state.passLabels = [...new Set(labels)];
    await this.persist();
  }

  async formatThreadStateForAgent(_pr: PRInfo, phase?: ReviewPhase): Promise<string> {
    const lines: string[] = [];

    const resolved = await this.fetchResolvedThreadIds(_pr, phase);
    for (const review of this.state.reviews) {
      if (!this.matchesPhase(review, phase)) continue;
      for (const comment of review.comments) {
        const status = resolved.has(comment.id) ? "RESOLVED" : "UNRESOLVED";
        const location = comment.path !== null && comment.line !== null
          ? `inline on ${comment.path}:${comment.line}`
          : "general comment";
        lines.push(`### Thread ${comment.id} (${status}) — ${location}`);
        lines.push(`> ${comment.body}`);

        if (comment.replies.length > 0) {
          for (const reply of comment.replies) {
            lines.push(`Reply: ${reply.body}`);
          }
        } else {
          lines.push("No replies yet.");
        }
        lines.push("");
      }
    }

    if (lines.length === 0) {
      return [
        "No existing review threads.",
        "",
        "Do NOT use GitHub MCP tools — all thread state is provided above.",
      ].join("\n");
    }

    return [
      "## Current review threads",
      "",
      ...lines,
      "---",
      "Address all UNRESOLVED threads above. Do NOT use GitHub MCP tools — all thread state is provided above.",
    ].join("\n");
  }
}
