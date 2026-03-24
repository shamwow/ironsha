# Ensure build and tests pass before requesting ironsha review

## Search Metadata
- Topics: build gate, test gate, CI, pre-review validation, ironsha, bot-review-needed, build failure
- Applies: submitting PRs for review, applying bot-review-needed label, debugging rejected PRs

## Lesson
- The ironsha runs the project's build and test commands BEFORE any code review — if they fail, the PR is rejected with no review
- On build/test failure: ironsha posts the failure output as a PR comment and labels the PR `bot-changes-needed`
- Build and test commands are read from `AGENTS.md`, `CLAUDE.md`, or `README.md` — keep these up to date
- ALWAYS verify your PR builds and passes tests locally before applying `bot-review-needed`
- NEVER apply `bot-review-needed` on a PR with known build or test failures — it wastes a review cycle

---
Learned: 2026-03-14
