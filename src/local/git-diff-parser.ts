import type { FilePatch } from "../state/backend.js";

/**
 * Splits full `git diff` output into per-file FilePatch objects.
 * Each patch contains everything from the first @@ hunk header onward,
 * matching the format returned by GitHub's pulls.listFiles() API.
 */
export function parseGitDiffToFilePatches(diffOutput: string): FilePatch[] {
  if (!diffOutput.trim()) return [];

  const files: FilePatch[] = [];

  // Split on "diff --git " boundaries
  const chunks = diffOutput.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    // First line: "a/path b/path"
    const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;
    const filename = headerMatch[2];

    // Find the first @@ hunk header — everything from there is the patch
    const firstHunk = chunk.indexOf("@@");
    if (firstHunk === -1) {
      // Binary file, rename-only, or mode change — no patch content
      files.push({ filename, patch: undefined });
      continue;
    }

    const patch = chunk.slice(firstHunk).trimEnd();
    files.push({ filename, patch });
  }

  return files;
}
