import type { WriteResult } from "./types.js";

function extractJsonFromOutput(raw: string): unknown | null {
  // Some providers wrap the final JSON inside an outer JSON envelope.
  // Try to parse the whole thing as JSON first.
  try {
    const outer = JSON.parse(raw);
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

export function parseWriteResult(raw: string): WriteResult {
  const data = extractJsonFromOutput(raw) as Record<string, unknown> | null;

  if (!data) {
    return {
      threads_addressed: [],
      build_passed: false,
      summary: "Failed to parse code-fix output.",
    };
  }

  return {
    threads_addressed: Array.isArray(data.threads_addressed)
      ? data.threads_addressed
      : [],
    build_passed:
      typeof data.build_passed === "boolean" ? data.build_passed : false,
    summary:
      typeof data.summary === "string" ? data.summary : "Code fix complete.",
  };
}
