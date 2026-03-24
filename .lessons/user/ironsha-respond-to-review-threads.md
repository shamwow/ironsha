# Address every ironsha review thread by fixing or justifying

## Search Metadata
- Topics: review comments, thread tracking, thread::uuid, responding to review, bot-changes-needed, unresolved threads, ironsha
- Applies: responding to ironsha review feedback, fixing review comments, re-requesting review

## Lesson
- Every ironsha comment (inline and general) contains a role prefix (`reviewer` or `writer`) and a `thread::{uuid}` tag for tracking
- When `bot-changes-needed` is applied, you MUST address every unresolved comment thread — ironsha will reject the PR if any are left unaddressed
- For each thread, either:
  - Fix the issue in a new commit and reply explaining the fix, OR
  - Justify why no change is needed with a clear explanation (ironsha evaluates justifications on the next cycle)
- NEVER add rocket/thumbs-up reactions to bot comments — ironsha uses these reactions to mark threads as resolved
- After addressing all threads, re-apply `bot-review-needed` to trigger another review cycle

---
Learned: 2026-03-14
