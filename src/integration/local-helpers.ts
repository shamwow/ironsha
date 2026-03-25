import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PRInfo } from "../review/types.js";

const __compiledDir = dirname(fileURLToPath(import.meta.url));
const __fixturesDir = join(__compiledDir, "..", "..", "src", "integration", "fixtures");

export interface LocalTestFixture {
  checkoutPath: string;
  pr: PRInfo;
}

/**
 * Creates a local git repo in a tmpdir with a main branch and a feature branch
 * that has the ios-review.patch applied. No GitHub involved.
 */
export function createLocalTestRepo(runId: string): LocalTestFixture {
  const checkoutPath = mkdtempSync(join(tmpdir(), "ironsha-local-test-"));
  const patchPath = join(__fixturesDir, "ios-review.patch");
  const branch = `local-test/${runId}`;

  // Initialize a bare repo with a main branch
  execSync("git init", { cwd: checkoutPath, stdio: "pipe" });
  execSync('git config user.name "ironsha-test"', { cwd: checkoutPath, stdio: "pipe" });
  execSync('git config user.email "test@ironsha"', { cwd: checkoutPath, stdio: "pipe" });

  // Create an initial commit on main so we have a base
  execSync("git checkout -b main", { cwd: checkoutPath, stdio: "pipe" });
  execSync("touch .gitkeep", { cwd: checkoutPath, stdio: "pipe" });
  execSync("git add -A", { cwd: checkoutPath, stdio: "pipe" });
  execSync('git commit -m "initial commit"', { cwd: checkoutPath, stdio: "pipe" });

  // Create the feature branch
  execSync(`git checkout -b ${branch}`, { cwd: checkoutPath, stdio: "pipe" });

  // Apply the test fixture patch (may fail if the patch expects certain files to exist)
  // Fall back to creating synthetic changes if the patch doesn't apply cleanly
  try {
    execSync(`git apply ${patchPath}`, { cwd: checkoutPath, stdio: "pipe" });
  } catch {
    // Patch doesn't apply on empty repo — create synthetic Swift file changes
    const swiftDir = join(checkoutPath, "Zenith", "Views", "Dashboard");
    execSync(`mkdir -p "${swiftDir}"`, { cwd: checkoutPath, stdio: "pipe" });
    const swiftContent = Array.from({ length: 200 }, (_, i) =>
      `// Line ${i + 1}: DashboardView implementation`,
    ).join("\n");
    writeFileSync(
      join(swiftDir, "DashboardView.swift"),
      swiftContent,
    );
  }

  execSync("git add -A", { cwd: checkoutPath, stdio: "pipe" });
  execSync(`git commit -m "[${runId}] test fixture changes"`, {
    cwd: checkoutPath,
    stdio: "pipe",
  });

  // Set up "origin/main" so git diff origin/main...HEAD works
  // We do this by creating a local remote pointing to ourselves
  execSync(`git remote add origin ${checkoutPath}`, {
    cwd: checkoutPath,
    stdio: "pipe",
  });
  execSync("git fetch origin main", { cwd: checkoutPath, stdio: "pipe" });

  return {
    checkoutPath,
    pr: {
      owner: "local",
      repo: "test",
      number: 0,
      branch,
      baseBranch: "main",
      title: `[${runId}] Test local review`,
    },
  };
}

export function cleanupLocalTestRepo(fixture: LocalTestFixture): void {
  try {
    rmSync(fixture.checkoutPath, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
