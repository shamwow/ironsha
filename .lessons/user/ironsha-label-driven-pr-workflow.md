# Use the correct GitHub labels for the ironsha review cycle

## Search Metadata
- Topics: GitHub labels, PR workflow, bot-review-needed, bot-changes-needed, human-review-needed, bot-human-intervention, review cycle, ironsha
- Applies: opening pull requests, triggering code review, responding to review feedback, PR label management

## Instructions

- After opening a PR against main, apply `bot-review-needed` to start review.
- After addressing all review comments, re-apply `bot-review-needed` to trigger another cycle.
- Do not manually apply `bot-changes-needed` or `human-review-needed` — ironsha sets those.
- After 5 review cycles without resolution, apply `bot-human-intervention` and stop.

---
Learned: 2026-03-14
