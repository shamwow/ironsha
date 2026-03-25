import { execFile, execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalStateBackend } from "./state-backend.js";
import { makeFooter } from "../shared/footer.js";
import { config } from "../config.js";
import type { PRInfo } from "../review/types.js";
import type { BotLabel } from "./types.js";

const VALID_LABELS: readonly string[] = [
  "bot-review-needed", "bot-changes-needed",
  "human-review-needed", "bot-human-intervention",
];

const execFileAsync = promisify(execFile);

/**
 * Resolve a (possibly prefix-based) comment ID to the full UUID by scanning
 * all reviews in the given backend state.  Returns `undefined` when no match
 * is found.  If multiple comments share the same prefix, returns the first
 * match — callers typically paste IDs from CLI output so collisions are rare.
 */
function resolveCommentId(
  backend: LocalStateBackend,
  partialId: string,
): string | undefined {
  const trimmed = partialId.trim();
  const state = backend.getState();
  for (const review of state.reviews) {
    for (const comment of review.comments) {
      if (comment.id === trimmed || comment.id.startsWith(trimmed)) {
        return comment.id;
      }
    }
  }
  return undefined;
}

const USAGE = `Usage: ironsha-state <command> [args]

Commands:
  init [--checkout-path <path>] [--base-branch <branch>]
      Initialize local state for the current git repo/branch

  show
      Print the full local state JSON

  label
      Print the current label

  label set <label>
      Set the label (bot-review-needed, bot-changes-needed, etc.)

  description set --body <text>
      Set the PR description (summary, test plan, media)

  reviews
      List all reviews with their inline comments

  review post --json <json>
      Post a review from JSON: { comments: [{path,line,body}], summary, event }

  resolve <comment-id>
      Mark a comment as resolved (add rocket + thumbs-up reactions)

  reply <comment-id> --body <text>
      Post a reply to a review comment thread

  unresolved
      Show unresolved thread count

  threads
      Print formatted thread state (same view the agent gets)

  diff
      List changed files (via git diff against base branch)

  publish
      Push branch and create GitHub PR with all local review history

Options:
  --checkout-path <path>   Path to the git checkout (default: cwd)
  --base-branch <branch>   Base branch name (default: main)
  --state-dir <path>       State directory (default: <checkout>/.ironsha)
`;

function parseArgs(argv: string[]): {
  command: string;
  subcommand?: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const args = argv.slice(2); // skip node + script
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    // Note: flag values starting with "--" are misclassified as positional args
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  return {
    command: positional[0] ?? "",
    subcommand: positional[1],
    positional: positional.slice(1),
    flags,
  };
}

async function inferPRInfo(
  checkoutPath: string,
  baseBranch: string,
): Promise<PRInfo> {
  const { stdout: branchOut } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: checkoutPath },
  );
  const branch = branchOut.trim();

  let owner = "local";
  let repo = "unknown";
  try {
    const { stdout: remoteOut } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: checkoutPath },
    );
    const remoteUrl = remoteOut.trim();
    const match = remoteUrl.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      owner = match[1];
      repo = match[2];
    }
  } catch {
    // No remote — use defaults
  }

  return { owner, repo, number: 0, branch, baseBranch, title: "" };
}

async function publishToGitHub(
  backend: LocalStateBackend,
  pr: PRInfo,
  checkoutPath: string,
): Promise<void> {
  const state = backend.getState();

  // GITHUB_TOKEN is used for review comments, reactions, and labels (bot account).
  // PR creation, editing, and viewing use the default gh auth (developer account).
  const ghToken = config.GITHUB_TOKEN;
  if (!ghToken) {
    console.warn(
      "WARNING: GITHUB_TOKEN is not set. Review comments will use default gh auth, " +
      "which may post as the wrong account. Set GITHUB_TOKEN to the bot token.",
    );
  }
  const botEnv = ghToken
    ? { env: { ...process.env, GH_TOKEN: ghToken } }
    : {};

  // 1. Push branch (uses git's own auth — SSH keys or credential helpers, not GH_TOKEN)
  console.log("Pushing branch...");
  try {
    execSync(`git push -u origin HEAD`, { cwd: checkoutPath, stdio: "pipe" });
  } catch {
    execSync(`git push origin HEAD`, { cwd: checkoutPath, stdio: "pipe" });
  }

  // 2. Create or find existing PR
  console.log("Creating/finding PR...");
  let prUrl: string;
  let prNumber: number;
  try {
    const existing = execSync(
      `gh pr view --json number,url --jq '.number'`,
      { cwd: checkoutPath, encoding: "utf-8" },
    ).trim();
    prNumber = parseInt(existing, 10);
    prUrl = execSync(
      `gh pr view --json url --jq '.url'`,
      { cwd: checkoutPath, encoding: "utf-8" },
    ).trim();
    console.log(`Found existing PR #${prNumber}: ${prUrl}`);

    // Update description if set
    if (state.description) {
      execFileSync(
        "gh", ["pr", "edit", String(prNumber), "--body", state.description],
        { cwd: checkoutPath, stdio: "pipe" },
      );
    }
  } catch {
    // No existing PR — create one
    const title = state.pr.title || `${pr.branch}`;
    const body = state.description || "";
    const result = execFileSync(
      "gh", ["pr", "create", "--title", title, "--body", body, "--base", pr.baseBranch],
      { cwd: checkoutPath, encoding: "utf-8" },
    ).toString().trim();
    prUrl = result;
    // Extract PR number from URL
    const numMatch = prUrl.match(/\/pull\/(\d+)/);
    prNumber = numMatch ? parseInt(numMatch[1], 10) : 0;
    console.log(`Created PR #${prNumber}: ${prUrl}`);
  }

  // 3. Post all reviews with inline comments
  for (const review of state.reviews) {
    console.log(`Posting review ${review.id.slice(0, 8)} (${review.event})...`);

    if (review.comments.length > 0) {
      // Build the review payload with footers
      const comments = review.comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body + makeFooter(c.id, review.id, "reviewer"),
      }));
      const summaryBody = review.body
        ? review.body + makeFooter(review.id, review.id, "reviewer")
        : "";
      const payload = JSON.stringify({
        body: summaryBody,
        event: review.event,
        comments,
      });
      try {
        execSync(
          `gh api repos/${pr.owner}/${pr.repo}/pulls/${prNumber}/reviews --input -`,
          { cwd: checkoutPath, input: payload, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
        );
      } catch {
        // If batch fails, post summary + comments individually
        console.error(`  Batch review failed, posting individually...`);
        if (review.body) {
          const summaryPayload = JSON.stringify({
            body: summaryBody,
            event: "COMMENT",
            comments: [],
          });
          try {
            execSync(
              `gh api repos/${pr.owner}/${pr.repo}/pulls/${prNumber}/reviews --input -`,
              { cwd: checkoutPath, input: summaryPayload, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
            );
          } catch { /* skip */ }
        }
        for (const c of comments) {
          try {
            const singlePayload = JSON.stringify({
              body: "",
              event: "COMMENT",
              comments: [c],
            });
            execSync(
              `gh api repos/${pr.owner}/${pr.repo}/pulls/${prNumber}/reviews --input -`,
              { cwd: checkoutPath, input: singlePayload, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
            );
          } catch {
            // Fall back to issue comment
            const fallbackPayload = JSON.stringify({
              body: `**${c.path}:${c.line}**\n\n${c.body}`,
            });
            execSync(
              `gh api repos/${pr.owner}/${pr.repo}/issues/${prNumber}/comments --input -`,
              { cwd: checkoutPath, input: fallbackPayload, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
            );
          }
        }
      }
    } else if (review.body) {
      // Summary-only review
      const payload = JSON.stringify({
        body: review.body + makeFooter(review.id, review.id, "reviewer"),
        event: "COMMENT",
        comments: [],
      });
      execSync(
        `gh api repos/${pr.owner}/${pr.repo}/pulls/${prNumber}/reviews --input -`,
        { cwd: checkoutPath, input: payload, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
      );
    }

    // Post thread replies
    for (const comment of review.comments) {
      for (const reply of comment.replies) {
        console.log(`  Posting reply to ${comment.id.slice(0, 8)}...`);
        const replyBody = `> Re: ${comment.path}:${comment.line}\n\n${reply.body}` +
          makeFooter(comment.id, undefined, "writer");
        const fallbackPayload = JSON.stringify({ body: replyBody });
        execSync(
          `gh api repos/${pr.owner}/${pr.repo}/issues/${prNumber}/comments --input -`,
          { cwd: checkoutPath, input: fallbackPayload, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
        );
      }
    }
  }

  // 4. Post resolved reactions on PR review comments.
  // Note: replies above go to issue comments (different API), so their footer
  // tags won't appear in the PR review comments fetched here — no collision risk.
  const resolvedIds = await backend.fetchResolvedThreadIds(pr);
  if (resolvedIds.size > 0) {
    console.log(`Posting reactions for ${resolvedIds.size} resolved comment(s)...`);
    let ghComments: Array<{ id: number; path: string; line: number | null; body: string }> = [];
    try {
      const commentsJson = execSync(
        `gh api repos/${pr.owner}/${pr.repo}/pulls/${prNumber}/comments --paginate`,
        { cwd: checkoutPath, encoding: "utf-8", ...botEnv },
      );
      // --paginate concatenates JSON arrays: [...][...] — merge into one array
      const raw = commentsJson.trim();
      ghComments = JSON.parse(raw.replace(/\]\s*\[/g, ","));
    } catch {
      console.error("  Could not fetch PR comments for reaction matching.");
    }

    for (const review of state.reviews) {
      for (const comment of review.comments) {
        if (!resolvedIds.has(comment.id)) continue;

        // Match by thread:: tag embedded in the comment footer
        const match = ghComments.find(
          (gc) => gc.body.includes(`thread::${comment.id}`),
        );
        if (!match) {
          console.error(`  Could not match comment ${comment.id.slice(0, 8)} to GitHub.`);
          continue;
        }

        for (const reaction of ["rocket", "+1"] as const) {
          try {
            execSync(
              `gh api repos/${pr.owner}/${pr.repo}/pulls/comments/${match.id}/reactions --input -`,
              {
                cwd: checkoutPath,
                input: JSON.stringify({ content: reaction }),
                stdio: ["pipe", "pipe", "pipe"],
                ...botEnv,
              },
            );
          } catch { /* reaction may already exist */ }
        }
        console.log(`  Reacted on ${comment.path}:${comment.line}`);
      }
    }
  }

  // 5. Set label
  console.log(`Setting label: ${state.label}`);
  const botLabels = [
    "bot-review-needed", "bot-changes-needed",
    "human-review-needed", "bot-human-intervention",
  ];
  for (const label of botLabels) {
    try {
      execSync(
        `gh api repos/${pr.owner}/${pr.repo}/issues/${prNumber}/labels/${label} -X DELETE`,
        { cwd: checkoutPath, stdio: ["pipe", "pipe", "pipe"], ...botEnv },
      );
    } catch { /* label not present */ }
  }
  execSync(
    `gh api repos/${pr.owner}/${pr.repo}/issues/${prNumber}/labels --input -`,
    {
      cwd: checkoutPath,
      input: JSON.stringify({ labels: [state.label] }),
      stdio: ["pipe", "pipe", "pipe"],
      ...botEnv,
    },
  );

  console.log(`\nPublished: ${prUrl}`);
}

async function main(): Promise<void> {
  const { command, subcommand, positional, flags } = parseArgs(process.argv);
  const checkoutPath = flags["checkout-path"] ?? process.cwd();
  const baseBranch = flags["base-branch"] ?? "main";
  const stateDir = flags["state-dir"] ?? join(checkoutPath, ".ironsha");

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  const pr = await inferPRInfo(checkoutPath, baseBranch);
  const backend = new LocalStateBackend(checkoutPath, pr, stateDir);
  await backend.load();

  switch (command) {
    case "init": {
      const state = backend.getState();
      await backend.setLabel(pr, state.label);
      console.log(`Initialized state at ${stateDir}`);
      console.log(`  Branch: ${pr.branch}`);
      console.log(`  Base:   ${pr.baseBranch}`);
      console.log(`  Label:  ${state.label}`);
      break;
    }

    case "show": {
      console.log(JSON.stringify(backend.getState(), null, 2));
      break;
    }

    case "label": {
      if (subcommand === "set") {
        const label = positional[1];
        if (!label) {
          console.error("Usage: ironsha-state label set <label>");
          process.exit(1);
        }
        if (!VALID_LABELS.includes(label)) {
          console.error(`Invalid label: ${label}`);
          console.error(`Valid labels: ${VALID_LABELS.join(", ")}`);
          process.exit(1);
        }
        await backend.setLabel(pr, label);
        console.log(`Label set to: ${label}`);
      } else {
        console.log(backend.getLabel());
      }
      break;
    }

    case "description": {
      if (subcommand === "set") {
        const body = flags["body"];
        if (!body) {
          // Read from stdin if no --body flag
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          const stdinBody = Buffer.concat(chunks).toString("utf-8").trim();
          if (!stdinBody) {
            console.error("Usage: ironsha-state description set --body <text>");
            console.error("  Or pipe: echo 'description' | ironsha-state description set");
            process.exit(1);
          }
          await backend.setDescription(stdinBody);
          console.log("Description set.");
        } else {
          await backend.setDescription(body);
          console.log("Description set.");
        }
      } else {
        const state = backend.getState();
        console.log(state.description ?? "(no description)");
      }
      break;
    }

    case "reviews":
    case "review": {
      if (command === "reviews" || subcommand !== "post") {
        // Display reviews
        const state = backend.getState();
        if (state.reviews.length === 0) {
          console.log("No reviews.");
          break;
        }
        for (const review of state.reviews) {
          console.log(`\n## Review ${review.id.slice(0, 8)} (${review.event})`);
          console.log(`   ${review.createdAt}`);
          if (review.body) {
            console.log(`   Summary: ${review.body.slice(0, 100)}...`);
          }
          for (const comment of review.comments) {
            const resolved = comment.reactions.some((r) => r.content === "rocket") &&
              comment.reactions.some((r) => r.content === "+1");
            const status = resolved ? "RESOLVED" : "UNRESOLVED";
            console.log(`\n   [${status}] ${comment.path}:${comment.line} (${comment.id.slice(0, 8)})`);
            console.log(`   ${comment.body}`);
            for (const reply of comment.replies) {
              console.log(`     ↳ ${reply.body}`);
            }
          }
        }
        break;
      }

      if (subcommand === "post") {
        const jsonStr = flags["json"];
        if (!jsonStr) {
          console.error("Usage: ironsha-state review post --json '<json>'");
          process.exit(1);
        }
        let data: {
          comments: Array<{ path: string; line: number; body: string }>;
          summary: string;
          event?: "COMMENT" | "REQUEST_CHANGES";
        };
        try {
          data = JSON.parse(jsonStr);
        } catch {
          console.error("Invalid JSON. Expected: { comments: [{path,line,body}], summary, event }");
          process.exit(1);
        }
        const comments = (data.comments ?? []).map((c) => ({
          path: c.path,
          line: c.line,
          body: c.body,
        }));
        const event = data.event ?? (comments.length > 0 ? "REQUEST_CHANGES" : "COMMENT");
        await backend.postReview(pr, comments, data.summary ?? "", event);

        // Set label based on outcome
        if (comments.length > 0) {
          await backend.setLabel(pr, "bot-changes-needed");
          console.log(`Posted review with ${comments.length} comment(s). Label: bot-changes-needed`);
        } else {
          // Check for unresolved threads before approving
          const unresolved = await backend.fetchUnresolvedThreadCount(pr);
          if (unresolved > 0) {
            await backend.setLabel(pr, "bot-changes-needed");
            console.log(`Posted clean review but ${unresolved} unresolved thread(s) remain. Label: bot-changes-needed`);
          } else {
            await backend.setLabel(pr, "human-review-needed");
            console.log(`Posted clean review. Label: human-review-needed`);
          }
        }
      }
      break;
    }

    case "resolve": {
      const commentId = subcommand;
      if (!commentId) {
        console.error("Usage: ironsha-state resolve <comment-id>");
        process.exit(1);
      }
      const fullId = resolveCommentId(backend, commentId);
      if (!fullId) {
        console.error(`Comment not found: ${commentId}`);
        process.exit(1);
      }
      await backend.addResolvedReactions(pr, fullId);
      console.log(`Resolved: ${fullId.slice(0, 8)}`);
      break;
    }

    case "reply": {
      const commentId = subcommand;
      if (!commentId) {
        console.error("Usage: ironsha-state reply <comment-id> --body <text>");
        process.exit(1);
      }
      const replyBody = flags["body"];
      if (!replyBody) {
        console.error("Usage: ironsha-state reply <comment-id> --body <text>");
        process.exit(1);
      }
      const fullId = resolveCommentId(backend, commentId);
      if (!fullId) {
        console.error(`Comment not found: ${commentId}`);
        process.exit(1);
      }
      await backend.replyToThread(pr, fullId, replyBody);
      console.log(`Reply posted to: ${fullId.slice(0, 8)}`);
      break;
    }

    case "unresolved": {
      const count = await backend.fetchUnresolvedThreadCount(pr);
      const resolved = await backend.fetchResolvedThreadIds(pr);
      console.log(`Unresolved: ${count}`);
      console.log(`Resolved:   ${resolved.size}`);
      break;
    }

    case "threads": {
      const formatted = await backend.formatThreadStateForAgent(pr);
      console.log(formatted);
      break;
    }

    case "diff": {
      const files = await backend.listChangedFiles(pr);
      if (files.length === 0) {
        console.log("No changed files.");
        break;
      }
      for (const f of files) {
        console.log(f.filename);
      }
      break;
    }

    case "publish": {
      await publishToGitHub(backend, pr, checkoutPath);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
