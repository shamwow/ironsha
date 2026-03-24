# Follow ironsha PR best practices: focused, tested, architecture-aware

## Search Metadata
- Topics: PR best practices, focused PRs, testing gaps, ARCHITECTURE.md updates, linter, ironsha compatibility, code review
- Applies: creating pull requests, structuring changes for review, preparing code for ironsha

## Lesson
- Keep PRs focused — one logical change per PR; ironsha reviews the full `git diff main...HEAD`
- Update `ARCHITECTURE.md` if the change introduces new modules, layers, or alters data flow
- Include tests for new code paths — ironsha checks for testing gaps
- Don't rely on formatting fixes — ironsha defers to the project's linter for style and focuses on substantive issues
- Keep build/test commands in `AGENTS.md`, `CLAUDE.md`, or `README.md` up to date — ironsha uses them as-is

---
Learned: 2026-03-14
