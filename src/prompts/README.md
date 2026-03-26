# Prompt Naming

Prompt templates in this directory follow these naming rules:

- Step-specific prompts use `{step}-{name}.md`
- Shared prompts use `{name}.md`

Examples:

- `plan-plan.md`
- `plan-review.md`
- `implement-implement.md`
- `code-review-base.md`
- `code-review-review.md`
- `qa-review-fix.md`
- `ci-fix.md`

Use a step-specific name when the prompt is tied directly to one workflow step and may need step-local context or instructions. Use a shared name when the prompt is intentionally reusable across steps.
