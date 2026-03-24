# Understand ironsha's two-pass review: architecture first, then detailed

## Search Metadata
- Topics: architecture review, code review, two-pass review, ironsha review passes, ARCHITECTURE.md conformance, detailed review
- Applies: structuring PRs for review, understanding ironsha feedback, architecture conformance, code quality checks

## Lesson
- Ironsha runs two sequential review passes — if Pass 1 finds issues, Pass 2 is skipped entirely
- **Pass 1 — Architecture Review** checks:
  - Does the change fit the existing architecture per `ARCHITECTURE.md`?
  - Are new modules/layers in the right place?
  - Is the data flow correct? Any inappropriate coupling?
  - Are dependencies pointing in the right direction?
  - Does `ARCHITECTURE.md` need updating?
- **Pass 2 — Detailed Code Review** (only if Pass 1 passes) checks:
  - Linter compliance
  - Correctness: logic errors, null safety, edge cases
  - Performance: unnecessary allocations, N+1 queries
  - Memory management: retain cycles, leaks, uncancelled subscriptions
  - Error handling: missing or inadequate
  - Security: injection, hardcoded secrets, insecure transport
  - Testing: are new code paths tested?
- Fix architecture issues first — detailed review won't run until architecture passes

---
Learned: 2026-03-14
