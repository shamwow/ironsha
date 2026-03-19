import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProvider } from "../config.js";
import {
  resolvePromptTemplate,
  type PromptPass,
} from "./prompt-builder.js";

interface TestVariant {
  provider: AgentProvider;
  model?: string;
  templates: Partial<Record<PromptPass, { promptFiles: string[]; includeGuide: boolean }>>;
}

test("resolvePromptTemplate returns the default stack when there is no override", () => {
  const template = resolvePromptTemplate({
    pass: "architecture-pass",
    provider: "claude",
    model: "claude-opus-4-6",
  });

  assert.deepEqual(template, {
    promptFiles: ["base.md", "architecture-pass.md"],
    includeGuide: true,
  });
});

test("resolvePromptTemplate prefers exact provider/model overrides over provider defaults", () => {
  const variants: TestVariant[] = [
    {
      provider: "claude",
      templates: {
        "detailed-pass": {
          promptFiles: ["base.md", "detailed-pass.md", "claude-default.md"],
          includeGuide: true,
        },
      },
    },
    {
      provider: "claude",
      model: "claude-opus-4-6",
      templates: {
        "detailed-pass": {
          promptFiles: ["base.md", "detailed-pass.md", "claude-opus.md"],
          includeGuide: true,
        },
      },
    },
  ];

  const template = resolvePromptTemplate(
    {
      pass: "detailed-pass",
      provider: "claude",
      model: "claude-opus-4-6",
    },
    variants,
  );

  assert.deepEqual(template, {
    promptFiles: ["base.md", "detailed-pass.md", "claude-opus.md"],
    includeGuide: true,
  });
});
