import type { ArchitecturePassResult, DetailedPassResult } from "./types.js";

function extractJsonFromOutput(raw: string): unknown | null {
  // Some providers wrap the final JSON inside an outer JSON envelope.
  // Try to parse the whole thing as JSON first.
  try {
    const outer = JSON.parse(raw);
    // The result text is in outer.result
    const resultText =
      typeof outer === "string"
        ? outer
        : typeof outer.result === "string"
          ? outer.result
          : JSON.stringify(outer);
    return extractJsonFromText(resultText);
  } catch {
    // Fall through to text extraction
  }

  return extractJsonFromText(raw);
}

function extractJsonFromText(text: string): unknown | null {
  // Try to find a ```json ... ``` block
  const jsonBlockMatch = text.match(/```json\s*\n([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch {
      // continue
    }
  }

  // Try to find a raw JSON object (first { to last })
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }

  return null;
}

export function parseArchitectureResult(raw: string): ArchitecturePassResult {
  const data = extractJsonFromOutput(raw) as Record<string, unknown> | null;

  if (!data) {
    console.warn("Failed to parse architecture pass output");
    return {
      architecture_comments: [],
      architecture_update_needed: { needed: false },
      thread_responses: [],
    };
  }

  return {
    architecture_comments: Array.isArray(data.architecture_comments)
      ? data.architecture_comments
      : Array.isArray(data.new_comments)
        ? data.new_comments
        : [],
    architecture_update_needed:
      typeof data.architecture_update_needed === "object" &&
      data.architecture_update_needed !== null
        ? (data.architecture_update_needed as { needed: boolean; reason?: string })
        : { needed: false },
    thread_responses: Array.isArray(data.thread_responses)
      ? data.thread_responses
      : [],
    summary:
      typeof data.summary === "string" ? data.summary : undefined,
  };
}

export function parseDetailedResult(raw: string): DetailedPassResult {
  const data = extractJsonFromOutput(raw) as Record<string, unknown> | null;

  if (!data) {
    console.warn("Failed to parse detailed pass output");
    return {
      detail_comments: [],
      thread_responses: [],
    };
  }

  return {
    detail_comments: Array.isArray(data.detail_comments)
      ? data.detail_comments
      : Array.isArray(data.new_comments)
        ? data.new_comments
        : [],
    thread_responses: Array.isArray(data.thread_responses)
      ? data.thread_responses
      : [],
    summary:
      typeof data.summary === "string" ? data.summary : undefined,
  };
}
