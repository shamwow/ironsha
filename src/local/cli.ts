import { execFile, execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { LocalStateBackend } from "./state-backend.js";
import { makeFooter } from "../shared/footer.js";
import { buildDiffableLines } from "../github/diff-lines.js";
import { validateComments } from "../github/comment-validator.js";
import { config } from "../config.js";
import type { PRInfo } from "../review/types.js";
import type { BotLabel, PassLabel } from "./types.js";
import type { ReviewPhase } from "../state/backend.js";

const VALID_LABELS: readonly string[] = [
  "bot-review-needed", "bot-changes-needed",
  "bot-human-intervention", "agent-code-review-passed",
  "agent-qa-review-passed",
];

/** Pass labels are excluded — they can only be set by automated review phases. */
const DIRECTLY_SETTABLE_LABELS: readonly string[] = [
  "bot-review-needed", "bot-changes-needed", "bot-human-intervention",
];

const REQUIRED_PASS_LABELS: readonly PassLabel[] = [
  "agent-code-review-passed",
  "agent-qa-review-passed",
];

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const PR_MEDIA_BRANCH = "pr-media";
const PR_MEDIA_PREFIX = "pr-media";

function passLabelForPhase(phase: string | undefined): PassLabel {
  return phase === "qa" ? "agent-qa-review-passed" : "agent-code-review-passed";
}

function reviewerFooterRole(phase: ReviewPhase | undefined): "code-reviewer" | "qa-reviewer" {
  return phase === "qa" ? "qa-reviewer" : "code-reviewer";
}

function parseReviewPhase(value: string | undefined): ReviewPhase | undefined {
  if (!value) return undefined;
  if (value === "code" || value === "qa") return value;
  return undefined;
}

const execFileAsync = promisify(execFile);

function isExternalUrl(target: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(target) || target.startsWith("#");
}

function trimLocalPrefix(target: string): string {
  return target.replace(/^[.][/\\]+/, "").replace(/^[/\\]+/, "");
}

function fileExtension(target: string): string {
  const clean = target.split(/[?#]/, 1)[0];
  const ext = clean.includes(".") ? clean.slice(clean.lastIndexOf(".") + 1) : "";
  return ext.toLowerCase();
}

function buildBlobUrl(pr: PRInfo, relativePath: string, raw: boolean, branch = pr.branch): string {
  const normalized = trimLocalPrefix(relativePath).split("\\").join("/");
  const encodedPath = normalized.split("/").map(encodeURIComponent).join("/");
  const base = `https://github.com/${pr.owner}/${pr.repo}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
  return raw ? `${base}?raw=true` : base;
}

function mediaBranchPath(pr: PRInfo, relativePath: string): string {
  return join(PR_MEDIA_PREFIX, pr.branch, trimLocalPrefix(relativePath)).split("\\").join("/");
}

function isMediaPath(target: string): boolean {
  return MEDIA_EXTENSIONS.has(fileExtension(target));
}

export function rewriteMediaReferencesForGithub(body: string, pr: PRInfo): string {
  const rewriteImage = (_match: string, alt: string, target: string): string => {
    if (isExternalUrl(target)) {
      return `![${alt}](${target})`;
    }
    const ext = fileExtension(target);
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return `![${alt}](${target})`;
    }
    return `![${alt}](${buildBlobUrl(pr, mediaBranchPath(pr, target), true, PR_MEDIA_BRANCH)})`;
  };

  const rewriteLink = (_match: string, label: string, target: string): string => {
    if (isExternalUrl(target)) {
      return `[${label}](${target})`;
    }
    if (!isMediaPath(target)) {
      return `[${label}](${target})`;
    }
    return `[${label}](${buildBlobUrl(pr, mediaBranchPath(pr, target), IMAGE_EXTENSIONS.has(fileExtension(target)), PR_MEDIA_BRANCH)})`;
  };

  return body
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, rewriteImage)
    .replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, rewriteLink);
}

function extractReferencedMediaPaths(body: string): string[] {
  const targets = new Set<string>();
  const pattern = /(?:!\[[^\]]*\]|\[[^\]]+\])\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1];
    if (isExternalUrl(target)) continue;
    if (!isMediaPath(target)) continue;
    targets.add(trimLocalPrefix(target));
  }
  return [...targets];
}

function syncMediaArtifactsToMediaBranch(
  checkoutPath: string,
  pr: PRInfo,
  body: string,
): void {
  const mediaPaths = extractReferencedMediaPaths(body);
  if (mediaPaths.length === 0) return;

  const remoteUrl = execFileSync(
    "git",
    ["remote", "get-url", "origin"],
    { cwd: checkoutPath, encoding: "utf8", stdio: "pipe" },
  ).trim();
  const tempRepo = mkdtempSync(join(tmpdir(), "ironsha-pr-media-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: tempRepo,
      encoding: "utf8",
      stdio: "pipe",
    }).toString();

  try {
    git(["init", "-q"]);
    git(["remote", "add", "origin", remoteUrl]);

    try {
      git(["fetch", "origin", PR_MEDIA_BRANCH]);
      git(["checkout", "-B", PR_MEDIA_BRANCH, "FETCH_HEAD"]);
    } catch {
      git(["checkout", "--orphan", PR_MEDIA_BRANCH]);
    }

    try {
      const userName = execFileSync("git", ["config", "user.name"], {
        cwd: checkoutPath,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      if (userName) git(["config", "user.name", userName]);
    } catch {
      git(["config", "user.name", "ironsha"]);
    }
    try {
      const userEmail = execFileSync("git", ["config", "user.email"], {
        cwd: checkoutPath,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      if (userEmail) git(["config", "user.email", userEmail]);
    } catch {
      git(["config", "user.email", "ironsha@example.com"]);
    }

    for (const relativePath of mediaPaths) {
      const sourcePath = join(checkoutPath, relativePath);
      if (!existsSync(sourcePath)) {
        throw new Error(`Referenced media artifact does not exist: ${relativePath}`);
      }
      const destinationPath = join(tempRepo, mediaBranchPath(pr, relativePath));
      mkdirSync(dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }

    git(["add", ...mediaPaths.map((relativePath) => mediaBranchPath(pr, relativePath))]);
    const status = git(["status", "--short"]).trim();
    if (!status) return;
    git(["commit", "-m", `Sync PR media artifacts from ${pr.branch}`]);
    git(["push", "-u", "origin", PR_MEDIA_BRANCH]);
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
}

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

  pass-labels
      Print the earned pass labels

  label set <label>
      Set the label (bot-review-needed, bot-changes-needed, etc.)

  description set --body <text>
      Set the PR description (summary, test plan, media)

  reviews
      List all reviews with their inline comments

  review post --phase <code|qa> --json <json>
      Post a review from JSON: { comments: [{path,line,body}], summary, event }

  resolve <comment-id>
      Mark a comment as resolved (add rocket + thumbs-up reactions)

  reply <comment-id> --body <text>
      Post a reply to a review comment thread

  unresolved [--phase <code|qa>]
      Show unresolved thread count

  threads [--phase <code|qa>]
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
  const runGit = (
    args: string[],
    options?: { encoding?: BufferEncoding },
  ): string =>
    execFileSync("git", args, {
      cwd: checkoutPath,
      stdio: "pipe",
      ...(options?.encoding ? { encoding: options.encoding } : {}),
    }).toString();

  const runGh = (
    args: string[],
    envOptions: { env: NodeJS.ProcessEnv },
    options?: { input?: string; encoding?: BufferEncoding },
  ): string =>
    execFileSync("gh", args, {
      cwd: checkoutPath,
      stdio: ["pipe", "pipe", "pipe"],
      ...envOptions,
      ...(options?.input ? { input: options.input } : {}),
      ...(options?.encoding ? { encoding: options.encoding } : {}),
    }).toString();

  const repoPath = `repos/${pr.owner}/${pr.repo}`;
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
  const botEnv = {
    env: ghToken
      ? { ...process.env, GH_TOKEN: ghToken }
      : process.env,
  };
  // Strip token env vars so gh falls back to `gh auth login` for PR operations.
  // dotenv loads GITHUB_TOKEN into process.env, which gh would otherwise pick up.
  const { GITHUB_TOKEN: _gt, GH_TOKEN: _ght, ...cleanProcessEnv } = process.env;
  const devEnv = { env: cleanProcessEnv };

  // 1. Push branch (uses git's own auth — SSH keys or credential helpers, not GH_TOKEN)
  console.log("Pushing branch...");
  try {
    runGit(["push", "-u", "origin", "HEAD"]);
  } catch {
    runGit(["push", "origin", "HEAD"]);
  }
  syncMediaArtifactsToMediaBranch(checkoutPath, pr, state.description || "");

  // 2. Create or find existing PR
  console.log("Creating/finding PR...");
  let prUrl: string;
  let prNumber: number;
  try {
    const existing = runGh(
      ["pr", "view", "--json", "number,url", "--jq", ".number"],
      devEnv,
      { encoding: "utf-8" },
    ).trim();
    prNumber = parseInt(existing, 10);
    prUrl = runGh(
      ["pr", "view", "--json", "url", "--jq", ".url"],
      devEnv,
      { encoding: "utf-8" },
    ).trim();
    console.log(`Found existing PR #${prNumber}: ${prUrl}`);

    // Update description if set
    if (state.description || state.pr.title) {
      const githubDescription = rewriteMediaReferencesForGithub(state.description || "", pr);
      const title = state.pr.title || pr.branch;
      execFileSync(
        "gh", ["pr", "edit", String(prNumber), "--title", title, "--body", githubDescription],
        { cwd: checkoutPath, stdio: "pipe", ...devEnv },
      );
    }
  } catch {
    // No existing PR — create one
    const title = state.pr.title || `${pr.branch}`;
    const body = rewriteMediaReferencesForGithub(state.description || "", pr);
    const result = runGh(
      ["pr", "create", "--title", title, "--body", body, "--base", pr.baseBranch],
      devEnv,
      { encoding: "utf-8" },
    ).trim();
    prUrl = result;
    // Extract PR number from URL
    const numMatch = prUrl.match(/\/pull\/(\d+)/);
    prNumber = numMatch ? parseInt(numMatch[1], 10) : 0;
    console.log(`Created PR #${prNumber}: ${prUrl}`);
  }

  // 3. Fetch PR diff for comment validation
  let diffableLines = new Map<string, Set<number>>();
  let headSha = "";
  try {
    const filesJson = runGh(
      ["api", `${repoPath}/pulls/${prNumber}/files`, "--paginate"],
      devEnv,
      { encoding: "utf-8" },
    );
    const raw = filesJson.trim();
    const files: Array<{ filename: string; patch?: string }> = JSON.parse(
      raw.replace(/\]\s*\[/g, ","),
    );
    diffableLines = buildDiffableLines(files);
  } catch {
    console.error("  Could not fetch PR files for comment validation.");
  }
  try {
    headSha = runGh(
      ["api", `${repoPath}/pulls/${prNumber}`, "--jq", ".head.sha"],
      devEnv,
      { encoding: "utf-8" },
    ).trim();
  } catch {
    console.error("  Could not fetch PR head SHA for inline comments.");
  }

  // 4. Post all reviews with inline comments
  const deferredSummaryReviews: typeof state.reviews = [];
  for (const review of state.reviews) {
    console.log(`Posting review ${review.id.slice(0, 8)} (${review.event})...`);
    const footerRole = reviewerFooterRole(review.phase);

    if (review.comments.length > 0) {
      // Build the review payload with footers, validating against diff
      const rawComments = review.comments.map((c) => ({
        path: c.path as string | null,
        line: c.line as number | null,
        body: c.body + makeFooter(c.id, review.id, footerRole),
      }));
      const { comments: validatedComments, adjustedCount } = validateComments(rawComments, diffableLines);
      if (adjustedCount > 0) {
        console.log(`  Adjusted ${adjustedCount} comment(s) with invalid diff lines`);
      }
      // Separate inline and general comments
      const inlineComments = validatedComments.filter((c) => c.path !== null && c.line !== null);
      const generalComments = validatedComments.filter((c) => c.path === null || c.line === null);
      const summaryBody = review.body
        ? review.body + makeFooter(review.id, review.id, footerRole)
        : "";
      if (review.body) {
        const summaryPayload = JSON.stringify({
          body: summaryBody,
          event: review.event,
          comments: [],
        });
        try {
          runGh(
            ["api", `${repoPath}/pulls/${prNumber}/reviews`, "--input", "-"],
            botEnv,
            { input: summaryPayload },
          );
        } catch {
          console.error(`  Failed to post review summary ${review.id.slice(0, 8)}, continuing with comments...`);
        }
      }
      for (const c of inlineComments) {
        try {
          if (!headSha) {
            throw new Error("Missing PR head SHA");
          }
          const inlinePayload = JSON.stringify({
            body: c.body,
            commit_id: headSha,
            path: c.path!,
            line: c.line!,
            side: "RIGHT",
          });
          runGh(
            ["api", `${repoPath}/pulls/${prNumber}/comments`, "--input", "-"],
            botEnv,
            { input: inlinePayload },
          );
        } catch {
          const fallbackPayload = JSON.stringify({
            body: `**${c.path}:${c.line}**\n\n${c.body}`,
          });
          runGh(
            ["api", `${repoPath}/issues/${prNumber}/comments`, "--input", "-"],
            botEnv,
            { input: fallbackPayload },
          );
        }
      }

      // Post general comments (converted from invalid inline positions by the validator)
      for (const gc of generalComments) {
        const gcPayload = JSON.stringify({
          body: gc.body,
          event: "COMMENT",
          comments: [],
        });
        try {
          runGh(
            ["api", `${repoPath}/pulls/${prNumber}/reviews`, "--input", "-"],
            botEnv,
            { input: gcPayload },
          );
        } catch { /* skip */ }
      }
    } else if (review.body) {
      deferredSummaryReviews.push(review);
    }

  }

  // 5. Fetch all GitHub PR review comments and issue comments for matching local → GitHub IDs.
  // Used for replies and resolved reactions.
  let ghComments: Array<{ id: number; path: string; line: number | null; body: string }> = [];
  let ghIssueComments: Array<{ id: number; body: string }> = [];
  try {
    const commentsJson = runGh(
      ["api", `${repoPath}/pulls/${prNumber}/comments`, "--paginate"],
      devEnv,
      { encoding: "utf-8" },
    );
    // --paginate concatenates JSON arrays: [...][...] — merge into one array
    const raw = commentsJson.trim();
    ghComments = JSON.parse(raw.replace(/\]\s*\[/g, ","));
  } catch {
    console.error("  Could not fetch PR comments for thread matching.");
  }
  try {
    const issueCommentsJson = runGh(
      ["api", `${repoPath}/issues/${prNumber}/comments`, "--paginate"],
      devEnv,
      { encoding: "utf-8" },
    );
    const raw = issueCommentsJson.trim();
    ghIssueComments = JSON.parse(raw.replace(/\]\s*\[/g, ","));
  } catch {
    console.error("  Could not fetch issue comments for thread matching.");
  }

  // 6. Post thread replies as the developer (writer role)
  for (const review of state.reviews) {
    for (const comment of review.comments) {
      for (const reply of comment.replies) {
        console.log(`  Posting reply to ${comment.id.slice(0, 8)}...`);
        const replyBody = reply.body + makeFooter(comment.id, undefined, "writer");

        // Find the GitHub comment ID via thread:: tag to post an inline reply
        const match = ghComments.find(
          (gc) => gc.body.includes(`thread::${comment.id}`),
        );
        if (match) {
          try {
            runGh(
              ["api", `${repoPath}/pulls/${prNumber}/comments/${match.id}/replies`, "--input", "-"],
              devEnv,
              { input: JSON.stringify({ body: replyBody }) },
            );
            continue;
          } catch { /* fall through to issue comment */ }
        }

        // Fallback or general thread: post as top-level issue comment with context
        const context = comment.path !== null && comment.line !== null
          ? `${comment.path}:${comment.line}`
          : "general";
        const fallbackBody = `> Re: ${context}\n\n${replyBody}`;
        runGh(
          ["api", `${repoPath}/issues/${prNumber}/comments`, "--input", "-"],
          devEnv,
          { input: JSON.stringify({ body: fallbackBody }) },
        );
      }
    }
  }

  // 7. Post resolved reactions
  const resolvedIds = await backend.fetchResolvedThreadIds(pr);
  if (resolvedIds.size > 0) {
    console.log(`Posting reactions for ${resolvedIds.size} resolved comment(s)...`);
    for (const review of state.reviews) {
      for (const comment of review.comments) {
        if (!resolvedIds.has(comment.id)) continue;

        const match = ghComments.find(
          (gc) => gc.body.includes(`thread::${comment.id}`),
        );
        if (match) {
          for (const reaction of ["rocket", "+1"] as const) {
            try {
              runGh(
                ["api", `${repoPath}/pulls/comments/${match.id}/reactions`, "--input", "-"],
                botEnv,
                { input: JSON.stringify({ content: reaction }) },
              );
            } catch { /* reaction may already exist */ }
          }
          console.log(`  Reacted on ${comment.path ?? "general"}:${comment.line ?? "-"}`);
          continue;
        }

        const issueMatch = ghIssueComments.find(
          (gc) => gc.body.includes(`thread::${comment.id}`),
        );
        if (issueMatch) {
          for (const reaction of ["rocket", "+1"] as const) {
            try {
              runGh(
                ["api", `${repoPath}/issues/comments/${issueMatch.id}/reactions`, "--input", "-"],
                botEnv,
                { input: JSON.stringify({ content: reaction }) },
              );
            } catch { /* reaction may already exist */ }
          }
          console.log(`  Reacted on fallback/general thread ${comment.id.slice(0, 8)}`);
          continue;
        }

        console.error(`  Could not match comment ${comment.id.slice(0, 8)} to GitHub.`);
      }
    }
  }

  // 8. Post deferred summary-only reviews after replies/reactions so the timeline reads naturally.
  for (const review of deferredSummaryReviews) {
      const footerRole = reviewerFooterRole(review.phase);
      // Summary-only review (preserves APPROVE/COMMENT/REQUEST_CHANGES from local state)
      const payload = JSON.stringify({
        body: review.body + makeFooter(review.id, review.id, footerRole),
        event: review.event,
        comments: [],
      });
      try {
        runGh(
          ["api", `${repoPath}/pulls/${prNumber}/reviews`, "--input", "-"],
          botEnv,
          { input: payload },
        );
      } catch {
        // APPROVE with body can fail if the review was already submitted; try as COMMENT
        const fallbackPayload = JSON.stringify({
          body: review.body + makeFooter(review.id, review.id, footerRole),
          event: "COMMENT",
          comments: [],
        });
        try {
          runGh(
            ["api", `${repoPath}/pulls/${prNumber}/reviews`, "--input", "-"],
            botEnv,
            { input: fallbackPayload },
          );
        } catch {
          console.error(`  Failed to post review ${review.id.slice(0, 8)}, skipping.`);
        }
      }
    }

  // 9. Set label
  console.log(`Setting labels: ${[state.label, ...state.passLabels].join(", ")}`);
  const botLabels = [
    "bot-review-needed", "bot-changes-needed",
    "bot-human-intervention", "agent-code-review-passed",
    "agent-qa-review-passed",
  ];
  for (const label of botLabels) {
    try {
      runGh(
        ["api", `${repoPath}/issues/${prNumber}/labels/${label}`, "-X", "DELETE"],
        botEnv,
      );
    } catch { /* label not present */ }
  }
  const labelsToApply = new Set<string>(state.passLabels);
  if (state.label !== "bot-review-needed" || labelsToApply.size === 0) {
    labelsToApply.add(state.label);
  }
  runGh(
    ["api", `${repoPath}/issues/${prNumber}/labels`, "--input", "-"],
    botEnv,
    { input: JSON.stringify({ labels: Array.from(labelsToApply) }) },
  );

  if (REQUIRED_PASS_LABELS.every((label) => state.passLabels.includes(label))) {
    if (!ghToken) {
      throw new Error(
        "GITHUB_TOKEN is required to submit the final approval review after code review and QA both pass.",
      );
    }
    const appliedLabels = JSON.parse(
      runGh(
        ["api", `${repoPath}/issues/${prNumber}/labels`],
        botEnv,
        { encoding: "utf-8" },
      ),
    ) as Array<{ name: string }>;
    const applied = new Set(appliedLabels.map((entry) => entry.name));
    if (!REQUIRED_PASS_LABELS.every((label) => applied.has(label))) {
      throw new Error("Refusing to submit final approval review before both pass labels are present on the PR.");
    }

    runGh(
      ["api", `${repoPath}/pulls/${prNumber}/reviews`, "--input", "-"],
      botEnv,
      {
        input: JSON.stringify({
          body: "Automated code review and QA review passed.",
          event: "APPROVE",
          comments: [],
        }),
      },
    );
  }

  console.log(`\nPublished: ${prUrl}`);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const { command, subcommand, positional, flags } = parseArgs(argv);
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

    case "pass-labels": {
      console.log(JSON.stringify(backend.getPassLabels()));
      break;
    }

    case "label": {
      if (subcommand === "set") {
        const label = positional[1];
        if (!label) {
          console.error("Usage: ironsha-state label set <label>");
          process.exit(1);
        }
        if (!DIRECTLY_SETTABLE_LABELS.includes(label)) {
          if (label === "agent-code-review-passed" || label === "agent-qa-review-passed") {
            console.error(`Cannot set ${label} directly — it is set automatically by automated review phases when they pass.`);
          } else {
            console.error(`Invalid label: ${label}`);
            console.error(`Valid labels: ${DIRECTLY_SETTABLE_LABELS.join(", ")}`);
          }
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
        const title = flags["title"];
        if (!body) {
          // Read from stdin if no --body flag
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk);
          }
          const stdinBody = Buffer.concat(chunks).toString("utf-8").trim();
          if (!stdinBody) {
            console.error("Usage: ironsha-state description set [--title <text>] --body <text>");
            console.error("  Or pipe: echo 'description' | ironsha-state description set");
            process.exit(1);
          }
          if (title) {
            await backend.setTitle(title);
          }
          await backend.setDescription(stdinBody);
          console.log("Description set.");
        } else {
          if (title) {
            await backend.setTitle(title);
          }
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
        const phase = flags["phase"];
        if (!jsonStr) {
          console.error("Usage: ironsha-state review post --phase <code|qa> --json '<json>'");
          process.exit(1);
        }
        if (phase !== "code" && phase !== "qa") {
          console.error("Usage: ironsha-state review post --phase <code|qa> --json '<json>'");
          process.exit(1);
        }
        let data: {
          comments: Array<{ path: string | null; line: number | null; body: string }>;
          summary: string;
          event?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
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

        // Determine event: if explicit, use it; otherwise infer from comments + unresolved state
        let event = data.event;
        let unresolvedCount: number | undefined;
        if (!event) {
          if (comments.length > 0) {
            event = "REQUEST_CHANGES";
          } else {
            unresolvedCount = await backend.fetchUnresolvedThreadCount(pr, phase);
            event = unresolvedCount > 0 ? "COMMENT" : "APPROVE";
          }
        }
        const passLabel = passLabelForPhase(phase);
        const persistedEvent = event === "APPROVE" ? "COMMENT" : event;
        await backend.postReview(pr, comments, data.summary ?? "", persistedEvent, phase);

        // Set label based on outcome (reuse cached unresolved count)
        if (comments.length > 0) {
          await backend.removePassLabel(pr, passLabel);
          await backend.setLabel(pr, "bot-changes-needed");
          console.log(`Posted review with ${comments.length} comment(s). Label: bot-changes-needed`);
        } else {
          unresolvedCount ??= await backend.fetchUnresolvedThreadCount(pr, phase);
          if (event !== "APPROVE" || unresolvedCount > 0) {
            await backend.removePassLabel(pr, passLabel);
            await backend.setLabel(pr, "bot-changes-needed");
            console.log(`Posted clean review but ${unresolvedCount} unresolved thread(s) remain. Label: bot-changes-needed`);
          } else {
            await backend.addPassLabel(pr, passLabel);
            await backend.setLabel(pr, "bot-review-needed");
            console.log(`Approved. Pass label: ${passLabel}`);
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
      const phase = parseReviewPhase(flags["phase"]);
      if (flags["phase"] && !phase) {
        console.error("Usage: ironsha-state unresolved [--phase <code|qa>]");
        process.exit(1);
      }
      const count = await backend.fetchUnresolvedThreadCount(pr, phase);
      const resolved = await backend.fetchResolvedThreadIds(pr, phase);
      console.log(`Unresolved: ${count}`);
      console.log(`Resolved:   ${resolved.size}`);
      break;
    }

    case "threads": {
      const phase = parseReviewPhase(flags["phase"]);
      if (flags["phase"] && !phase) {
        console.error("Usage: ironsha-state threads [--phase <code|qa>]");
        process.exit(1);
      }
      const formatted = await backend.formatThreadStateForAgent(pr, phase);
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

// Allow direct execution
if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
