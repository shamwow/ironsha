import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalStateBackend } from "./state-backend.js";
import type { PRInfo } from "../review/types.js";
import type { BotLabel } from "./types.js";

const execFileAsync = promisify(execFile);

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

  reviews
      List all reviews with their inline comments

  resolve <comment-id>
      Mark a comment as resolved (add rocket + thumbs-up reactions)

  unresolved
      Show unresolved thread count

  threads
      Print formatted thread state (same view the agent gets)

  diff
      List changed files (via git diff against base branch)

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
  // Get current branch
  const { stdout: branchOut } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: checkoutPath },
  );
  const branch = branchOut.trim();

  // Get owner/repo from origin remote
  let owner = "local";
  let repo = "unknown";
  try {
    const { stdout: remoteOut } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: checkoutPath },
    );
    const remoteUrl = remoteOut.trim();
    // Parse github.com/owner/repo or github.com:owner/repo
    const match = remoteUrl.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (match) {
      owner = match[1];
      repo = match[2];
    }
  } catch {
    // No remote — use defaults
  }

  return {
    owner,
    repo,
    number: 0,
    branch,
    baseBranch,
    title: "",
  };
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
      // load() already creates initial state if file doesn't exist
      // Just persist it to disk by setting the current label
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
        await backend.setLabel(pr, label);
        console.log(`Label set to: ${label}`);
      } else {
        console.log(backend.getLabel());
      }
      break;
    }

    case "reviews": {
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

    case "resolve": {
      const commentId = subcommand;
      if (!commentId) {
        console.error("Usage: ironsha-state resolve <comment-id>");
        process.exit(1);
      }
      // Support short IDs — find full UUID match
      const state = backend.getState();
      let fullId: string | undefined;
      for (const review of state.reviews) {
        for (const comment of review.comments) {
          if (comment.id === commentId || comment.id.startsWith(commentId)) {
            fullId = comment.id;
            break;
          }
        }
        if (fullId) break;
      }
      if (!fullId) {
        console.error(`Comment not found: ${commentId}`);
        process.exit(1);
      }
      await backend.addResolvedReactions(pr, fullId);
      console.log(`Resolved: ${fullId.slice(0, 8)}`);
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
