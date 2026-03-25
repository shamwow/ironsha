/**
 * Parse unified diff patches from GitHub PR files to determine
 * which (path, line) pairs are valid for inline review comments.
 */

interface PRFile {
  filename: string;
  patch?: string;
}

/**
 * Parse a unified diff patch string and return the set of new-side
 * line numbers that GitHub will accept for inline comments.
 * These are lines within diff hunks: added lines (+) and context lines.
 */
export function parsePatchLines(patch: string): Set<number> {
  const lines = patch.split("\n");
  const validLines = new Set<number>();
  let newLine = 0;

  for (const line of lines) {
    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (newLine === 0) continue; // Before first hunk

    if (line.startsWith("+")) {
      // Added line — valid for comments
      validLines.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // Removed line — no new-side line number, skip
    } else {
      // Context line — valid for comments
      validLines.add(newLine);
      newLine++;
    }
  }

  return validLines;
}

/**
 * Build a map of file path -> set of valid line numbers from PR file data.
 * Pass the result of octokit.rest.pulls.listFiles() directly.
 */
export function buildDiffableLines(files: PRFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();

  for (const file of files) {
    if (!file.patch) {
      // Binary file or too large — no valid lines
      map.set(file.filename, new Set());
      continue;
    }
    map.set(file.filename, parsePatchLines(file.patch));
  }

  return map;
}
