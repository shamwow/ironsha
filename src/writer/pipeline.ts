import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { config, resolveProviderModel } from "../config.js";
import { logger } from "../logger.js";
import { clonePR, pruneCheckouts } from "../checkout/repo-manager.js";
import { setLabel } from "../github/labeler.js";
import { fetchResolvedThreadIds, postGeneralComment } from "../github/comments.js";
import { buildPromptFile } from "../prompts/prompt-builder.js";
import { makeFooter } from "../shared/footer.js";
import { runBuildAndTests } from "../review/build-runner.js";
import { runAgent } from "../review/agent-runner.js";
import { detectPlatform } from "../review/platform-detector.js";
import type { PRInfo } from "../review/types.js";
import { hasChanges, commitAndPush, fetchBase, hasMergeConflicts, mergeBase } from "./git-ops.js";
import { parseWriteResult } from "./result-parser.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function countReviewCycles(comments: Array<{ body?: string }>): number {
  const reviewIds = new Set<string>();
  for (const comment of comments) {
    if (!comment.body) continue;
    const matches = comment.body.matchAll(/review::([a-f0-9-]+)/g);
    for (const match of matches) {
      reviewIds.add(match[1]);
    }
  }
  return reviewIds.size;
}

export async function runWritePipeline(
  octokit: Octokit,
  pr: PRInfo,
): Promise<void> {
  const log = logger.child({
    pr: `${pr.owner}/${pr.repo}#${pr.number}`,
  });

  let checkoutPath: string | undefined;

  try {
    const provider = config.LLM_PROVIDER;
    const model = resolveProviderModel(provider);

    // 1. Check cycle limit
    log.info("Checking review cycle count");
    const allComments = await octokit.paginate(
      octokit.rest.issues.listComments,
      {
        owner: pr.owner,
        repo: pr.repo,
        issue_number: pr.number,
        per_page: 100,
      },
    );
    const cycleCount = countReviewCycles(allComments);
    log.info({ cycleCount, max: config.MAX_REVIEW_CYCLES }, "Review cycle count");

    if (cycleCount >= config.MAX_REVIEW_CYCLES) {
      log.warn("Max review cycles reached, requesting human intervention");
      await postGeneralComment(
        octokit,
        pr.owner,
        pr.repo,
        pr.number,
        `## Human Intervention Needed\n\nThis PR has gone through ${cycleCount} review cycles without passing. Handing off to a human reviewer.` + makeFooter(randomUUID()),
      );
      await setLabel(octokit, pr.owner, pr.repo, pr.number, "bot-human-intervention");
      return;
    }

    // 2. Clone PR branch
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

    // 3. Fetch base and resolve merge conflicts
    log.info({ baseBranch: pr.baseBranch }, "Fetching base branch");
    await fetchBase(checkoutPath, pr.baseBranch);

    const conflictCheck = await hasMergeConflicts(checkoutPath, pr.baseBranch);
    if (conflictCheck.hasConflicts) {
      log.info(
        { conflictFiles: conflictCheck.conflictFiles },
        "Merge conflicts detected, attempting resolution",
      );

      // Start the real merge — leaves conflict markers in working tree
      const mergeResult = await mergeBase(checkoutPath, pr.baseBranch);
      if (mergeResult.success) {
        log.info("Merge completed without conflicts (race condition — conflicts resolved upstream)");
      } else {
        // Invoke the selected agent to resolve conflicts
        const conflictPromptPath = buildPromptFile({
          pass: "merge-conflict",
          provider,
          model,
        });
        const conflictId = randomUUID();

        const conflictMessage = [
          `Resolve merge conflicts in this repository.`,
          `Conflicted files: ${conflictCheck.conflictFiles.join(", ")}`,
          `Base branch: ${pr.baseBranch}`,
          `PR branch: ${pr.branch}`,
        ].join("\n");

        log.info({ conflictId, provider: config.LLM_PROVIDER }, "Invoking agent for merge conflict resolution");
        await runAgent({
          provider,
          checkoutPath,
          promptPath: conflictPromptPath,
          userMessage: conflictMessage,
          githubToken: config.GITHUB_TOKEN,
          maxTurns: config.MAX_WRITE_TURNS,
          timeoutMs: config.MERGE_CONFLICT_TIMEOUT_MS,
          reviewId: conflictId,
          pass: "merge-conflict",
        });

        // Verify no conflict markers remain
        try {
          const { stdout: grepOut } = await execFileAsync(
            "git",
            ["grep", "-l", "<<<<<<<"],
            { cwd: checkoutPath },
          );
          if (grepOut.trim().length > 0) {
            const remainingFiles = grepOut.trim();
            log.error({ remainingFiles }, "Conflict markers remain after resolution attempt");
            await postGeneralComment(
              octokit,
              pr.owner,
              pr.repo,
              pr.number,
              `## Merge Conflict Resolution Failed\n\nConflict markers still present in:\n\`\`\`\n${remainingFiles}\n\`\`\`\n\nPlease resolve conflicts manually.` +
                makeFooter(randomUUID()),
            );
            // Abort the merge
            try {
              await execFileAsync("git", ["merge", "--abort"], { cwd: checkoutPath });
            } catch {
              // May not be in a merge state if Claude already committed
            }
            return;
          }
        } catch {
          // git grep exits with code 1 when no matches found — this is the success case
        }

        // Complete the merge commit
        await execFileAsync("git", ["add", "-A"], { cwd: checkoutPath });
        await execFileAsync(
          "git",
          ["commit", "--no-edit"],
          { cwd: checkoutPath },
        );
        log.info("Merge conflict resolution completed successfully");
      }
    } else {
      log.info("No merge conflicts detected");
    }

    // 4. Detect platform
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    const detectedPlatform = detectPlatform(files.map((f) => f.filename));

    if (!detectedPlatform) {
      log.warn("Could not detect platform from changed files");
      await postGeneralComment(
        octokit,
        pr.owner,
        pr.repo,
        pr.number,
        "Could not detect project platform from changed files. Skipping code fix." + makeFooter(randomUUID()),
      );
      return;
    }
    log.info({ platform: detectedPlatform }, "Detected platform");

    // 5. Build prompt and MCP config
    const promptPath = buildPromptFile({
      pass: "code-fix",
      provider,
      model,
      platform: detectedPlatform,
    });

    // Pre-fetch resolved thread IDs
    const { data: botUser } = await octokit.rest.users.getAuthenticated();
    const resolvedThreadIds = await fetchResolvedThreadIds(
      octokit, pr.owner, pr.repo, pr.number, botUser.login,
    );

    const resolvedLine = resolvedThreadIds.size > 0
      ? `Already-resolved thread IDs (skip these): ${[...resolvedThreadIds].join(", ")}`
      : `No threads are currently marked as resolved.`;

    const userMessage = [
      `Fix review comments on PR #${pr.number} in ${pr.owner}/${pr.repo}.`,
      `Title: ${pr.title}`,
      `Branch: ${pr.branch}`,
      resolvedLine,
      `Use the GitHub MCP tools to read PR review comments and threads.`,
      `Read the diff with: git diff origin/main...HEAD`,
    ].join("\n");

    const writeId = randomUUID();
    log.info({ writeId }, "Starting code-fix pass");

    // 6. Invoke the selected agent
    const raw = await runAgent({
      provider,
      checkoutPath,
      promptPath,
      userMessage,
      githubToken: config.GITHUB_TOKEN,
      maxTurns: config.MAX_WRITE_TURNS,
      timeoutMs: config.WRITE_TIMEOUT_MS,
      reviewId: writeId,
      pass: "code-fix",
    });

    // 7. Parse result
    const result = parseWriteResult(raw);
    log.info(
      {
        threadsAddressed: result.threads_addressed.length,
        buildPassed: result.build_passed,
        writeId,
      },
      "Code-fix pass complete",
    );

    // 8. Check for changes
    const changed = await hasChanges(checkoutPath);

    if (!changed) {
      log.info("No code changes were made");
      await postGeneralComment(
        octokit,
        pr.owner,
        pr.repo,
        pr.number,
        "Could not address review comments automatically. No code changes were made." + makeFooter(randomUUID()),
      );
      return;
    }

    // 9. Run build/tests as safety net
    log.info("Running build and tests on changes");
    const buildResult = await runBuildAndTests(checkoutPath);

    if (!buildResult.success) {
      log.warn("Build/tests failed after code changes");
      await postGeneralComment(
        octokit,
        pr.owner,
        pr.repo,
        pr.number,
        `## Build/Test Failure After Code Fix\n\nThe code changes caused build/test failures:\n\n\`\`\`\n${buildResult.output}\n\`\`\`` + makeFooter(randomUUID()),
      );
      // Keep bot-changes-needed label
      return;
    }
    log.info("Build and tests passed");

    // 10. Commit and push
    const commitMsg = `bot: address review comments\n\n${result.summary}`;
    await commitAndPush(
      checkoutPath,
      commitMsg,
      config.GITHUB_TOKEN,
      pr.owner,
      pr.repo,
    );
    log.info("Committed and pushed changes");

    // 11. Post thread replies for addressed comments
    for (const thread of result.threads_addressed) {
      const footer = makeFooter(randomUUID());
      const body = `**Addressed:** ${thread.explanation}${footer}`;
      try {
        await octokit.rest.pulls.createReplyForReviewComment({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          comment_id: Number(thread.thread_id),
          body,
        });
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          log.info({ threadId: thread.thread_id }, "Inline reply 404, falling back to general comment");
          try {
            await postGeneralComment(
              octokit,
              pr.owner,
              pr.repo,
              pr.number,
              `**Addressed** (thread::${thread.thread_id}): ${thread.explanation}${footer}`,
            );
          } catch (fallbackErr) {
            log.warn({ threadId: thread.thread_id, err: fallbackErr }, "Failed to post thread reply fallback");
          }
        } else {
          log.warn({ threadId: thread.thread_id, err }, "Failed to post thread reply");
        }
      }
    }

    // 12. Post summary and swap label to bot-ci-pending
    await postGeneralComment(
      octokit,
      pr.owner,
      pr.repo,
      pr.number,
      `## Code Fix Summary\n\n${result.summary}\n\nAddressed ${result.threads_addressed.length} review thread(s). Waiting for CI to pass before re-review.` + makeFooter(randomUUID()),
    );
    await setLabel(octokit, pr.owner, pr.repo, pr.number, "bot-ci-pending");
    log.info("Swapped label to bot-ci-pending");

    // 13. Prune old checkouts
    await pruneCheckouts(config.WORK_DIR, 30);
  } catch (err) {
    log.error({ err }, "Write pipeline failed");
    try {
      await postGeneralComment(
        octokit,
        pr.owner,
        pr.repo,
        pr.number,
        `## Write Bot Error\n\nThe code-fix pipeline encountered an error. Please check the bot logs.\n\n\`\`\`\n${String(err)}\n\`\`\`` + makeFooter(randomUUID()),
      );
    } catch (postErr) {
      log.error({ postErr }, "Failed to post error comment");
    }
  }
}
