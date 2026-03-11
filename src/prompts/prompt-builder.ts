import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../config.js";
import type { Platform } from "../review/types.js";

export type PromptPass =
  | "architecture-pass"
  | "detailed-pass"
  | "code-fix"
  | "merge-conflict";

interface PromptTemplate {
  promptFiles: string[];
  includeGuide: boolean;
}

interface PromptVariant {
  provider: AgentProvider;
  model?: string;
  templates: Partial<Record<PromptPass, PromptTemplate>>;
}

interface ResolvePromptTemplateOptions {
  pass: PromptPass;
  provider: AgentProvider;
  model?: string;
}

interface BuildPromptFileOptions extends ResolvePromptTemplateOptions {
  platform?: Platform;
}

const DEFAULT_PROMPT_TEMPLATES: Record<PromptPass, PromptTemplate> = {
  "architecture-pass": {
    promptFiles: ["base.md", "architecture-pass.md"],
    includeGuide: true,
  },
  "detailed-pass": {
    promptFiles: ["base.md", "detailed-pass.md"],
    includeGuide: true,
  },
  "code-fix": {
    promptFiles: ["code-fix.md"],
    includeGuide: true,
  },
  "merge-conflict": {
    promptFiles: ["merge-conflict.md"],
    includeGuide: false,
  },
};

// Update this registry to customize prompt stacks for a provider or an exact provider/model pair.
export const PROMPT_VARIANTS: PromptVariant[] = [
  {
    provider: "claude",
    templates: {},
  },
  {
    provider: "codex",
    templates: {},
  },
  // Example model-specific override:
  // {
  //   provider: "codex",
  //   model: "gpt-5-codex",
  //   templates: {
  //     "detailed-pass": {
  //       promptFiles: ["base.md", "detailed-pass.md", "codex-detailed.md"],
  //       includeGuide: true,
  //     },
  //   },
  // },
];

function variantSpecificity(variant: PromptVariant, model?: string): number {
  if (variant.model === undefined) return 1;
  return variant.model === model ? 2 : 0;
}

function resolveTemplateFromVariants(
  variants: PromptVariant[],
  options: ResolvePromptTemplateOptions,
): PromptTemplate | null {
  const matches = variants
    .map((variant, index) => ({
      variant,
      index,
      specificity: variant.provider === options.provider
        ? variantSpecificity(variant, options.model)
        : 0,
    }))
    .filter((entry) => entry.specificity > 0)
    .sort((a, b) => {
      if (b.specificity !== a.specificity) {
        return b.specificity - a.specificity;
      }
      return b.index - a.index;
    });

  for (const match of matches) {
    const template = match.variant.templates[options.pass];
    if (template) {
      return template;
    }
  }

  return null;
}

export function resolvePromptTemplate(
  options: ResolvePromptTemplateOptions,
  variants: PromptVariant[] = PROMPT_VARIANTS,
): PromptTemplate {
  return resolveTemplateFromVariants(variants, options)
    ?? DEFAULT_PROMPT_TEMPLATES[options.pass];
}

function safeFileSegment(value: string | undefined): string {
  if (!value) return "default";
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function buildPromptFile(options: BuildPromptFileOptions): string {
  const template = resolvePromptTemplate(options);
  const promptsDir = import.meta.dirname;
  const guidesDir = join(import.meta.dirname, "..", "guides");

  const layers = template.promptFiles.map((file) =>
    readFileSync(join(promptsDir, file), "utf-8")
  );

  if (template.includeGuide) {
    if (!options.platform) {
      throw new Error(`Prompt pass ${options.pass} requires a platform guide`);
    }
    layers.push(
      readFileSync(
        join(guidesDir, `${options.platform.toUpperCase()}_CODE_REVIEW.md`),
        "utf-8",
      ),
    );
  }

  const combined = layers.join("\n\n---\n\n");
  const tempDir = join(tmpdir(), "review-bot-prompts");
  mkdirSync(tempDir, { recursive: true });

  const tempPath = join(
    tempDir,
    `${options.pass}-${options.provider}-${safeFileSegment(options.model)}-${Date.now()}.md`,
  );
  writeFileSync(tempPath, combined);
  return tempPath;
}
