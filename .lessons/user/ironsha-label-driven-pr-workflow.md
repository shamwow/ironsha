# Use ironsha's label-driven PR workflow for review cycles

## Search Metadata
- Topics: GitHub labels, PR workflow, bot-review-needed, bot-changes-needed, human-review-needed, bot-human-intervention, review cycle, ironsha
- Applies: opening pull requests, triggering code review, responding to review feedback, PR label management

## Lesson
- The ironsha review cycle is driven by exactly four GitHub labels — only one is active on a PR at a time:
  - `bot-review-needed` — applied by the code submitter when the PR is ready for review
  - `bot-changes-needed` — applied by ironsha when issues are found (with REQUEST_CHANGES status)
  - `human-review-needed` — applied by ironsha when bot approves; awaiting human review
  - `bot-human-intervention` — applied by the write bot after MAX_REVIEW_CYCLES (default 5) iterations
- After opening a PR against main, apply `bot-review-needed` to start the cycle
- The ironsha and write bot form an autonomous loop: ironsha reviews → bot fixes → re-labels → ironsha reviews again
- After MAX_REVIEW_CYCLES (default 5), the write bot stops and applies `bot-human-intervention`
- NEVER manually apply `bot-changes-needed` or `human-review-needed` — those are set by the ironsha

---
Learned: 2026-03-14
