# Contributing LLM Compatibility Guide

This file describes what a code-submitting LLM must do to participate in the ironsha workflow. Copy this file into any project that will create PRs for ironsha to review.

## Supported Platforms

The ironsha supports projects using one of the following stacks, detected by file extensions in the diff:

| Stack | Detected by |
|---|---|
| iOS (SwiftUI) | `*.swift` |
| Android (Kotlin/Compose) | `*.kt`, `*.kts` |
| Go webservers | `*.go` |
| React webapps | `*.tsx`, `*.ts`, `*.jsx` |

## Required Project Files

Your repository **must** contain:

### `AGENTS.md`, `CLAUDE.md`, or `README.md`
Must document the project's **build and test commands**. The ironsha runs these before reviewing. If they fail, the PR is rejected immediately with no code review.

Example:
```markdown
## Build
npm run build

## Test
npm run test

## Lint
npm run lint
```

### `ARCHITECTURE.md`
Documents the project's architecture — module structure, data flow, layer boundaries, dependency direction. The ironsha reads this during the architecture review pass and checks that PRs conform to it. If your change introduces new modules or alters the architecture, update this file in the same PR.

## Label-Driven Workflow

The entire review cycle is driven by four GitHub labels. Only one label is active on a PR at a time.

| Label | Applied by | Meaning |
|---|---|---|
| `bot-review-needed` | Code submitter / Write bot | PR is ready for review |
| `bot-changes-needed` | Ironsha | Issues found; write bot picks it up automatically |
| `human-review-needed` | Ironsha | Bot approved; awaiting human review |
| `bot-human-intervention` | Write bot | Max review cycles exceeded; needs human help |

### Lifecycle

The ironsha and write bot form an autonomous loop:

```
1. Open PR against main
2. Add label: bot-review-needed
         │
         ▼
   Ironsha picks up the PR
         │
    ┌────┴─────────────────────┐
    │                          │
    ▼                          ▼
Build/tests FAIL          Build/tests PASS
    │                          │
    │                     Architecture review
    │                          │
    │                    ┌─────┴──────┐
    │                    │            │
    │                    ▼            ▼
    │              Arch issues    No arch issues
    │                    │            │
    │                    │       Detailed review
    │                    │            │
    │                    │      ┌─────┴──────┐
    │                    │      │            │
    │                    │      ▼            ▼
    │                    │  Issues found   No issues
    │                    │      │            │
    │                    ▼      ▼            ▼
    │              bot-changes-needed  human-review-needed
    │              (REQUEST_CHANGES)
    │                    │
    ▼                    ▼
   Write bot picks up the PR automatically
         │
    ┌────┴──────────────────────┐
    │                           │
    ▼                           ▼
Cycle limit reached        Under limit
    │                           │
    ▼                      Fix code, build, push
bot-human-intervention          │
                                ▼
                         bot-review-needed (loops back ↑)
```

The write bot automatically addresses review comments, pushes fixes, and re-triggers review. After `MAX_REVIEW_CYCLES` (default 5) iterations, it applies `bot-human-intervention` and stops.

## What the Ironsha Checks

The bot runs up to two sequential review passes. If Pass 1 finds issues, Pass 2 is skipped — there's no point reviewing line-level details when the architecture needs rework. When issues are found, the review is posted with GitHub's "Request changes" status.

**Pass 1 — Architecture Review**
- Does the change fit the existing architecture per `ARCHITECTURE.md`?
- Are new modules/layers in the right place?
- Is the data flow correct? Any inappropriate coupling?
- Are dependencies pointing in the right direction?
- Does `ARCHITECTURE.md` need updating?

**Pass 2 — Detailed Code Review** *(only runs if Pass 1 finds no issues)*
- Runs the project's linter
- Correctness: logic errors, null safety, edge cases
- Performance: unnecessary allocations, N+1 queries
- Memory management: retain cycles, leaks, uncancelled subscriptions
- Error handling: missing or inadequate error handling
- Security: injection, hardcoded secrets, insecure transport
- Testing: are new code paths tested?

## Responding to Review Comments

When the bot applies `bot-changes-needed`, it will have posted review comments on the PR. Every bot comment (inline review comments and general comments alike) contains a `thread::{uuid}` tag in its footer for tracking purposes. The submitting LLM **must**:

1. **Address every unresolved comment thread** — the bot tracks both inline review threads and general comment threads via `thread::` tags, and will reject the PR if any are left unaddressed.

2. For each thread, either:
   - **Fix the issue** in a new commit and reply to the thread explaining the fix, OR
   - **Justify why no change is needed** by replying to the thread with a clear explanation. The ironsha will evaluate justifications on the next cycle and resolve threads it finds acceptable.

3. **Do not** add rocket/thumbs-up reactions to bot comments — the ironsha uses these reactions to mark threads as resolved.

4. After addressing all threads, **re-apply the `bot-review-needed` label** to trigger another review cycle.

## Build and Test Gate

The ironsha runs your project's build and test commands **before** any code review. If they fail:

- The bot posts the failure output as a PR comment
- The PR is labeled `bot-changes-needed`
- No code review is performed

**Always ensure your PR builds and passes tests before applying `bot-review-needed`.**

## PR Best Practices for Ironsha Compatibility

- **Keep PRs focused** — one logical change per PR. The bot reviews the full `git diff main...HEAD`.
- **Update `ARCHITECTURE.md`** if your change introduces new modules, layers, or alters data flow.
- **Include tests** for new code paths — the bot checks for testing gaps.
- **Don't rely on formatting fixes** — the bot defers to the project's linter for style and focuses on substantive issues.
- **Keep build/test commands in `AGENTS.md`, `CLAUDE.md`, or `README.md` up to date** — the bot uses them as-is.
