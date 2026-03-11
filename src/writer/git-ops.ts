import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

export async function hasChanges(checkoutPath: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: checkoutPath,
  });
  return stdout.trim().length > 0;
}

export async function fetchBase(
  checkoutPath: string,
  baseBranch: string,
): Promise<void> {
  await execFileAsync("git", ["fetch", "origin", baseBranch], {
    cwd: checkoutPath,
  });
}

export interface MergeConflictResult {
  hasConflicts: boolean;
  conflictFiles: string[];
}

export async function hasMergeConflicts(
  checkoutPath: string,
  baseBranch: string,
): Promise<MergeConflictResult> {
  try {
    await execFileAsync(
      "git",
      ["merge", "--no-commit", "--no-ff", `origin/${baseBranch}`],
      { cwd: checkoutPath },
    );
    // No conflicts — abort the merge to restore working tree
    await execFileAsync("git", ["merge", "--abort"], { cwd: checkoutPath });
    return { hasConflicts: false, conflictFiles: [] };
  } catch (err) {
    // Merge failed — likely conflicts. Get the list of conflicted files.
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: checkoutPath },
      );
      const conflictFiles = stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
      // Abort the dry-run merge
      await execFileAsync("git", ["merge", "--abort"], {
        cwd: checkoutPath,
      });
      if (conflictFiles.length > 0) {
        return { hasConflicts: true, conflictFiles };
      }
      // Merge failed for non-conflict reasons
      throw err;
    } catch (innerErr) {
      // Try to abort in case merge is still in progress
      try {
        await execFileAsync("git", ["merge", "--abort"], {
          cwd: checkoutPath,
        });
      } catch {
        // Ignore — merge may not be in progress
      }
      throw err;
    }
  }
}

export interface MergeResult {
  success: boolean;
  output: string;
}

export async function mergeBase(
  checkoutPath: string,
  baseBranch: string,
): Promise<MergeResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["merge", "--no-ff", `origin/${baseBranch}`],
      { cwd: checkoutPath },
    );
    return { success: true, output: stdout + stderr };
  } catch (err) {
    const output =
      err instanceof Error ? err.message : String(err);
    logger.info({ baseBranch }, "Merge has conflicts, leaving markers for resolution");
    return { success: false, output };
  }
}

export async function commitAndPush(
  checkoutPath: string,
  message: string,
  token: string,
  owner: string,
  repo: string,
): Promise<void> {
  await execFileAsync(
    "git",
    ["config", "user.name", "ironsha"],
    { cwd: checkoutPath },
  );
  await execFileAsync(
    "git",
    ["config", "user.email", "ironsha@noreply"],
    { cwd: checkoutPath },
  );
  await execFileAsync("git", ["add", "-A"], { cwd: checkoutPath });
  await execFileAsync("git", ["commit", "-m", message], {
    cwd: checkoutPath,
  });

  // Set the remote URL with token for auth
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await execFileAsync("git", ["remote", "set-url", "origin", remoteUrl], {
    cwd: checkoutPath,
  });
  await execFileAsync("git", ["push"], { cwd: checkoutPath });
}
