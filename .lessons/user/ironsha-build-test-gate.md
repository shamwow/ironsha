# Pass build and tests before requesting review

## Search Metadata
- Topics: build gate, test gate, CI, pre-review validation, ironsha, bot-review-needed, build failure
- Applies: submitting PRs for review, applying bot-review-needed label, debugging rejected PRs

## Instructions

- Run the project's build and test commands locally before applying `bot-review-needed`.
- Keep build/test commands in `AGENTS.md`, `CLAUDE.md`, or `README.md` up to date.
- Do not apply `bot-review-needed` on a PR with known build or test failures.

---
Learned: 2026-03-14
