import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { config, resolveProviderModel } from "../config.js";
import { logger } from "../logger.js";
import { clonePR, pruneCheckouts } from "../checkout/repo-manager.js";
import { buildDiffableLines } from "../github/diff-lines.js";
import { validateComments } from "../github/comment-validator.js";
import { makeFooter } from "../shared/footer.js";
import { buildPromptFile } from "../prompts/prompt-builder.js";
import { runBuildAndTests } from "./build-runner.js";
import { runAgent, type AgentRunner } from "./agent-runner.js";
import { detectPlatform } from "./platform-detector.js";
import { parseArchitectureResult, parseDetailedResult } from "./result-parser.js";
import type { StateBackend } from "../state/backend.js";
import { GitHubStateBackend } from "../state/github-backend.js";
import type {
  PRInfo,
  MergedReviewResult,
  ReviewComment,
  ThreadResponse,
} from "./types.js";

function mergeResults(
  archResult: ReturnType<typeof parseArchitectureResult>,
  detailResult: ReturnType<typeof parseDetailedResult>,
): MergedReviewResult {
  // Combine comments, dedup by file+line proximity
  const allComments: ReviewComment[] = [
    ...archResult.architecture_comments,
    ...detailResult.detail_comments,
  ];

  const deduped: ReviewComment[] = [];
  for (const comment of allComments) {
    const isDuplicate = deduped.some(
      (existing) =>
        existing.path === comment.path &&
        existing.line !== null &&
        comment.line !== null &&
        Math.abs(existing.line - comment.line) <= 2 &&
        existing.body === comment.body,
    );
    if (!isDuplicate) {
      deduped.push(comment);
    }
  }

  // Merge thread responses — architecture pass takes precedence
  const threadMap = new Map<string, ThreadResponse>();
  for (const tr of detailResult.thread_responses) {
    threadMap.set(tr.thread_id, tr);
  }
  for (const tr of archResult.thread_responses) {
    threadMap.set(tr.thread_id, tr); // overwrites detail pass
  }

  const summaryParts = [archResult.summary, detailResult.summary].filter(
    Boolean,
  );

  return {
    comments: deduped,
    thread_responses: Array.from(threadMap.values()),
    architecture_update_needed: archResult.architecture_update_needed,
    summary: summaryParts.join("\n\n") || "Review complete.",
  };
}

export interface ReviewPipelineOptions {
  /** Pre-existing checkout path — skip clonePR when provided. */
  checkoutPath?: string;
  /** When true, do not configure the GitHub MCP server for the agent. */
  skipMcpGithub?: boolean;
}

/**
 * Backend-agnostic review pipeline core.
 * All state operations go through the StateBackend interface.
 */
export async function runReviewPipelineCore(
  pr: PRInfo,
  backend: StateBackend,
  agentRunner: AgentRunner = runAgent,
  options: ReviewPipelineOptions = {},
): Promise<void> {
  const log = logger.child({
    pr: `${pr.owner}/${pr.repo}#${pr.number}`,
  });

  let checkoutPath: string | undefined = options.checkoutPath;
  let reviewId: string | undefined;

  try {
    // 1. Clone PR branch (skip if checkoutPath provided)
    if (!checkoutPath) {
      log.info("Cloning PR branch");
      checkoutPath = await clonePR({
        owner: pr.owner,
        repo: pr.repo,
        branch: pr.branch,
        prNumber: pr.number,
        token: config.GITHUB_TOKEN,
        workDir: config.WORK_DIR,
      });
      log.info({ checkoutPath }, "Cloned successfully");
    }

    // 2. Run build + tests
    log.info("Running build and tests");
    const buildResult = await runBuildAndTests(checkoutPath);

    if (!buildResult.success) {
      log.warn("Build/tests failed, posting failure comment");
      await backend.postGeneralComment(
        pr,
        `## Build/Test Failure\n\n\`\`\`\n${buildResult.output}\n\`\`\`` + makeFooter(randomUUID(), undefined, "reviewer"),
      );
      await backend.setLabel(pr, "bot-changes-needed");
      return;
    }
    log.info("Build and tests passed");

    // 3. Detect platform
    const files = await backend.listChangedFiles(pr);
    const detectedPlatform = detectPlatform(files.map((f) => f.filename));

    if (!detectedPlatform) {
      log.warn("Could not detect platform from changed files");
      await backend.postGeneralComment(
        pr,
        "Could not detect project platform from changed files. Skipping review." + makeFooter(randomUUID(), undefined, "reviewer"),
      );
      await backend.setLabel(pr, "bot-changes-needed");
      return;
    }
    log.info({ platform: detectedPlatform }, "Detected platform");

    // 4. Build prompt files and MCP config
    const provider = "claude" as const;
    const model = resolveProviderModel(provider);
    const archPromptPath = buildPromptFile({
      pass: "architecture-pass",
      provider,
      model,
      platform: detectedPlatform,
    });
    const detailPromptPath = buildPromptFile({
      pass: "detailed-pass",
      provider,
      model,
      platform: detectedPlatform,
    });

    // Pre-fetch resolved thread IDs
    const resolvedThreadIds = await backend.fetchResolvedThreadIds(pr);

    const resolvedLine = resolvedThreadIds.size > 0
      ? `Already-resolved thread IDs (skip these): ${[...resolvedThreadIds].join(", ")}`
      : `No threads are currently marked as resolved.`;

    const threadContext = await backend.formatThreadStateForAgent(pr);

    const userMessage = [
      `Review PR #${pr.number} in ${pr.owner}/${pr.repo}.`,
      `Title: ${pr.title}`,
      `Branch: ${pr.branch}`,
      resolvedLine,
      threadContext,
      `Read the diff with: git diff origin/${pr.baseBranch}...HEAD`,
    ].join("\n");

    // Generate a single review ID for this pipeline run
    reviewId = randomUUID();
    log.info({ reviewId }, "Generated review ID");

    // 5. Pass 1: Architecture review
    log.info("Running architecture review pass");
    const archRaw = await agentRunner({
      provider,
      checkoutPath,
      promptPath: archPromptPath,
      userMessage,
      githubToken: config.GITHUB_TOKEN,
      maxTurns: config.MAX_REVIEW_TURNS,
      timeoutMs: config.REVIEW_TIMEOUT_MS,
      reviewId,
      pass: "architecture",
      skipMcpGithub: options.skipMcpGithub,
    });
    const archResult = parseArchitectureResult(archRaw);
    log.info(
      {
        comments: archResult.architecture_comments.length,
        threads: archResult.thread_responses.length,
        reviewId,
      },
      "Architecture pass complete",
    );

    // 6. Check if architecture pass found issues
    const archHasIssues = archResult.architecture_comments.length > 0 ||
      archResult.thread_responses.some((tr) => !tr.resolved);

    let merged: MergedReviewResult;
    if (archHasIssues) {
      log.info("Architecture pass found issues, skipping detailed review");
      merged = {
        comments: archResult.architecture_comments,
        thread_responses: archResult.thread_responses,
        architecture_update_needed: archResult.architecture_update_needed,
        summary: archResult.summary ?? "Architecture review found issues.",
      };
    } else {
      // Pass 2: Detailed review
      log.info("Running detailed review pass");
      const detailRaw = await agentRunner({
        provider,
        checkoutPath,
        promptPath: detailPromptPath,
        userMessage,
        githubToken: config.GITHUB_TOKEN,
        maxTurns: config.MAX_REVIEW_TURNS,
        timeoutMs: config.REVIEW_TIMEOUT_MS,
        reviewId,
        pass: "detailed",
        skipMcpGithub: options.skipMcpGithub,
      });
      const detailResult = parseDetailedResult(detailRaw);
      log.info(
        {
          comments: detailResult.detail_comments.length,
          threads: detailResult.thread_responses.length,
          reviewId,
        },
        "Detailed pass complete",
      );

      merged = mergeResults(archResult, detailResult);
    }

    // 8. Post results
    // Add resolved reactions on resolved threads
    for (const tr of merged.thread_responses) {
      if (tr.resolved) {
        try {
          await backend.addResolvedReactions(pr, tr.thread_id);
        } catch (err) {
          log.warn({ threadId: tr.thread_id, err }, "Failed to add resolved reactions");
        }
      }
    }

    // Post feedback on unresolved threads
    for (const tr of merged.thread_responses) {
      if (!tr.resolved && tr.response) {
        const footer = makeFooter(randomUUID(), reviewId, "reviewer");
        try {
          await backend.replyToThread(pr, tr.thread_id, tr.response + footer);
        } catch (err) {
          log.warn({ threadId: tr.thread_id, err }, "Failed to post thread response");
        }
      }
    }

    // Validate comment lines against the PR diff
    const diffableLines = buildDiffableLines(files.map((f) => ({ filename: f.filename, patch: f.patch })));
    const { comments: validatedComments, adjustedCount } = validateComments(merged.comments, diffableLines);
    if (adjustedCount > 0) {
      log.info({ adjustedCount }, "Adjusted comments with invalid diff lines");
    }
    merged.comments = validatedComments;

    // Post new review comments
    if (merged.comments.length > 0) {
      const commentsWithFooter = merged.comments.map((c) => ({
        ...c,
        body: c.body + makeFooter(randomUUID(), reviewId, "reviewer"),
      }));
      await backend.postReview(
        pr,
        commentsWithFooter,
        merged.summary + makeFooter(randomUUID(), reviewId, "reviewer"),
        "REQUEST_CHANGES",
      );
    }

    // Post architecture update request if needed
    if (merged.architecture_update_needed.needed) {
      await backend.postGeneralComment(
        pr,
        `## ARCHITECTURE.md Update Needed\n\n${merged.architecture_update_needed.reason ?? "This PR changes the project architecture. Please update ARCHITECTURE.md."}` + makeFooter(randomUUID(), reviewId, "reviewer"),
      );
    }

    // 9. Determine outcome and swap labels
    let hasUnresolved = merged.thread_responses.some((tr) => !tr.resolved);
    const hasNewComments = merged.comments.length > 0;

    // Safety check: verify the agent didn't miss unresolved threads
    if (!hasUnresolved && !hasNewComments) {
      const unresolvedOnPR = await backend.fetchUnresolvedThreadCount(pr);
      if (unresolvedOnPR > 0) {
        log.warn(
          { unresolvedOnPR },
          "Agent returned no unresolved threads but PR still has unresolved bot comments — blocking LGTM",
        );
        hasUnresolved = true;
      }
    }

    if (hasUnresolved || hasNewComments) {
      log.info("Review has unresolved items, requesting changes");
      await backend.setLabel(pr, "bot-changes-needed");
    } else {
      log.info("Review passed, marking for human review");
      if (merged.comments.length === 0) {
        await backend.postGeneralComment(
          pr,
          `LGTM! All review comments have been addressed.` + makeFooter(randomUUID(), reviewId, "reviewer"),
        );
      }
      await backend.setLabel(pr, "human-review-needed");
    }

    // 10. Prune old checkouts (only when we cloned)
    if (!options.checkoutPath) {
      await pruneCheckouts(config.WORK_DIR, 30);
    }
  } catch (err) {
    log.error({ err }, "Review pipeline failed");
    try {
      await backend.postGeneralComment(
        pr,
        `## Ironsha Error\n\nThe review pipeline encountered an error. Please check the bot logs.\n\n\`\`\`\n${String(err)}\n\`\`\`` + makeFooter(randomUUID(), reviewId, "reviewer"),
      );
      await backend.setLabel(pr, "bot-changes-needed");
    } catch (postErr) {
      log.error({ postErr }, "Failed to post error comment");
    }
  }
}

/**
 * Existing signature preserved for backward compatibility.
 * Creates a GitHubStateBackend and delegates to the core.
 */
export async function runReviewPipeline(
  octokit: Octokit,
  pr: PRInfo,
  agentRunner: AgentRunner = runAgent,
): Promise<void> {
  const backend = new GitHubStateBackend(octokit);
  await runReviewPipelineCore(pr, backend, agentRunner);
}
