import { logger } from "../logger.js";
import type { ReviewComment } from "../review/types.js";

interface ValidationResult {
  comments: ReviewComment[];
  adjustedCount: number;
}

/**
 * Validate review comments against the PR diff to prevent
 * "Line could not be resolved" errors from GitHub's API.
 *
 * Comments on lines not in the diff are either snapped to the
 * nearest valid line (within 5 lines) or converted to general comments.
 */
export function validateComments(
  comments: ReviewComment[],
  diffableLines: Map<string, Set<number>>,
): ValidationResult {
  const validated: ReviewComment[] = [];
  let adjustedCount = 0;

  for (const comment of comments) {
    // General comments pass through unchanged
    if (comment.path === null || comment.line === null) {
      validated.push(comment);
      continue;
    }

    const validLines = diffableLines.get(comment.path);

    // File not in diff at all — convert to general comment
    if (!validLines) {
      logger.info(
        { path: comment.path, line: comment.line },
        "Comment file not in diff, converting to general comment",
      );
      validated.push({
        path: null,
        line: null,
        body: `**${comment.path}:${comment.line}**\n\n${comment.body}`,
      });
      adjustedCount++;
      continue;
    }

    // Line is in the diff — keep as-is
    if (validLines.has(comment.line)) {
      validated.push(comment);
      continue;
    }

    // Try to snap to nearest valid line within 5 lines
    const nearest = findNearestLine(validLines, comment.line, 5);
    if (nearest !== null) {
      logger.info(
        { path: comment.path, originalLine: comment.line, snappedLine: nearest },
        "Snapped comment to nearest diff line",
      );
      validated.push({ ...comment, line: nearest });
      adjustedCount++;
    } else {
      // No nearby line — convert to general comment
      logger.info(
        { path: comment.path, line: comment.line },
        "Comment line not in diff, converting to general comment",
      );
      validated.push({
        path: null,
        line: null,
        body: `**${comment.path}:${comment.line}**\n\n${comment.body}`,
      });
      adjustedCount++;
    }
  }

  return { comments: validated, adjustedCount };
}

function findNearestLine(
  validLines: Set<number>,
  target: number,
  maxDistance: number,
): number | null {
  let best: number | null = null;
  let bestDist = maxDistance + 1;

  for (const line of validLines) {
    const dist = Math.abs(line - target);
    if (dist <= maxDistance && dist < bestDist) {
      best = line;
      bestDist = dist;
    }
  }

  return best;
}
