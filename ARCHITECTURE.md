# Ironsha — Multi-Platform PR Reviewer

## Context

`ironsha` is a local-first PR review toolkit that drives a label-based review loop using a code-capable LLM CLI. The review workflow runs entirely against local state (JSON files in `.ironsha/`) and publishes to GitHub only at the end. It supports four project families:

- iOS (SwiftUI)
- Android (Kotlin/Compose)
- Go webservers
- React webapps

The runtime uses Claude Code as the agent provider.

## File Structure

```text
ironsha/
├── src/
│   ├── config.ts                  # Env parsing and provider selection
│   ├── logger.ts                  # Pino logger
│   ├── local/
│   │   ├── cli.ts                 # Local state management CLI
│   │   ├── state-backend.ts       # File-based StateBackend implementation
│   │   ├── types.ts               # Local state data structures
│   │   └── git-diff-parser.ts     # Parse git diff into file patches
│   ├── state/
│   │   └── backend.ts             # StateBackend interface
│   ├── review/
│   │   ├── agent-runner.ts        # Claude Code agent runner
│   │   ├── build-runner.ts        # Build/test discovery and execution
│   │   ├── pipeline.ts            # Review orchestration (backend-agnostic)
│   │   ├── platform-detector.ts   # Diff-based platform detection
│   │   ├── result-parser.ts       # Parse review-pass JSON output
│   │   └── types.ts               # Review pipeline types
│   ├── github/
│   │   ├── diff-lines.ts          # Parse PR diffs for valid comment lines
│   │   └── comment-validator.ts   # Validate comments against diff
│   ├── prompts/
│   │   ├── prompt-builder.ts      # Prompt registry + model prompt assembly
│   │   └── *.md                   # Prompt fragments
│   ├── shared/
│   │   └── footer.ts              # Thread/review UUID footer tags
│   └── guides/                    # Platform-specific review guides
├── README.md
└── .env.example
```

## Runtime Model

### Local Review Pipeline

The review pipeline (`src/review/pipeline.ts`) is backend-agnostic. All state operations go through the `StateBackend` interface (`src/state/backend.ts`). The `LocalStateBackend` stores state as JSON files in `.ironsha/`.

Pipeline steps:
1. Run build + tests (discovered from `AGENTS.md`, `CLAUDE.md`, or `README.md`)
2. Detect platform from changed file extensions
3. Architecture review pass (Claude Code agent)
4. If no architecture issues: detailed review pass
5. Post review results to local state
6. Set label based on outcome

### Local State CLI

The CLI (`npm run state`) manages all local PR state:

- `init` — create state file for current branch
- `review post --json <json>` — store review with inline comments
- `resolve <comment-id>` — mark thread as resolved (rocket + thumbs-up reactions)
- `threads` — format thread state for the agent
- `publish` — push branch, create GitHub PR, post all review history

State is stored in `.ironsha/{owner}-{repo}-{branch}.json`.

## Agent Runner

The runner invokes Claude Code non-interactively:

```bash
claude --print \
  --output-format json \
  --model {CLAUDE_MODEL} \
  --max-turns {MAX_REVIEW_TURNS} \
  --thinking enabled \
  --append-system-prompt-file {promptPath} \
  --dangerously-skip-permissions
```

Details:

- The combined prompt is passed as an appended system prompt file.
- `maxTurns` is enforced through Claude's native CLI flag.
- MCP GitHub config is omitted in local mode (`skipMcpGithub: true`).

## Prompt and Instruction Model

Prompt assembly is centralized in `src/prompts/prompt-builder.ts`.

The builder resolves a prompt template from a code registry:

- default template per pass
- optional model-specific override

Matching precedence is:

1. exact model match
2. provider default
3. built-in pass default

Default prompt templates are:

```text
architecture-pass -> base.md + architecture-pass.md + platform guide
detailed-pass     -> base.md + detailed-pass.md + platform guide
code-fix          -> code-fix.md + platform guide
```

Prompt expectations:

- Output must still be a single JSON object matching the existing parser contract.
- The agent is told to read project instructions from `AGENTS.md` and `CLAUDE.md` when present.
- In local mode, thread state is provided inline instead of via GitHub MCP.

## Build/Test Gate

Before any review, the bot runs project commands discovered from repository docs in this order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `README.md`

Command extraction behavior:

- Read fenced shell blocks or `$ ...` lines from build/test-like sections.
- Preserve first-seen order across files.
- Deduplicate exact command strings so overlapping docs do not run the same command twice.

If build/tests fail before review:

- Post the failure output to local state.
- Apply `bot-changes-needed` label.
- Skip all agent review passes.

## Review Output Contract

Review passes return:

```json
{
  "summary": "Overall assessment",
  "new_comments": [],
  "thread_responses": []
}
```

The parsers are intentionally tolerant:

- Accept a raw JSON object
- Accept a fenced ```json block
- Accept an envelope that stores the final text in a top-level `result` field

## Transcripts

Each agent invocation writes artifacts under `TRANSCRIPT_DIR`:

- `{reviewId}-{pass}.json` — final captured agent message
- `{reviewId}-{pass}.stderr.log` — stderr when present
- `{reviewId}-{pass}.meta.json` — provider, resolved model, command, pass, timestamp

Transcript pruning keeps the most recent 30 invocation groups, not 30 individual files.

## Label Lifecycle

Primary labels:

- `bot-review-needed`
- `bot-changes-needed`
- `human-review-needed`
- `bot-human-intervention`

Lifecycle:

```text
bot-review-needed
  -> review pipeline (posts with REQUEST_CHANGES event when issues are found)
  -> human-review-needed | bot-changes-needed

bot-changes-needed
  -> fix agent addresses comments
  -> bot-review-needed (loops back)

After max cycles:
  -> bot-human-intervention
```

## Design Constraints

- Local state (`.ironsha/` JSON files) is the source of truth during the review loop.
- GitHub is only touched at publish time (branch push, PR creation, comment posting).
- The runner adapter is the only place that should know about CLI flags, MCP wiring, or auth semantics.

## Contributing — LLM Compatibility Guide

This section describes what a code-submitting LLM must do to participate in the ironsha workflow.

### Supported Platforms

| Stack | Detected by |
|---|---|
| iOS (SwiftUI) | `*.swift` |
| Android (Kotlin/Compose) | `*.kt`, `*.kts` |
| Go webservers | `*.go` |
| React webapps | `*.tsx`, `*.ts`, `*.jsx` |

### Required Project Files

#### `AGENTS.md`, `CLAUDE.md`, or `README.md`
Must document the project's **build and test commands**. The ironsha runs these before reviewing. If they fail, the PR is rejected immediately with no code review.

#### `ARCHITECTURE.md`
Documents the project's architecture. The ironsha reads this during the architecture review pass and checks that PRs conform to it.

### What the Ironsha Checks

The bot runs up to two sequential review passes. If Pass 1 finds issues, Pass 2 is skipped.

**Pass 1 — Architecture Review**
- Does the change fit the existing architecture per `ARCHITECTURE.md`?
- Are new modules/layers in the right place?
- Is the data flow correct? Any inappropriate coupling?
- Does `ARCHITECTURE.md` need updating?

**Pass 2 — Detailed Code Review** *(only runs if Pass 1 finds no issues)*
- Correctness: logic errors, null safety, edge cases
- Performance: unnecessary allocations, N+1 queries
- Memory management: retain cycles, leaks
- Error handling
- Security
- Testing: are new code paths tested?

### PR Best Practices

- **Keep PRs focused** — one logical change per PR.
- **Update `ARCHITECTURE.md`** if your change introduces new modules or alters data flow.
- **Include tests** for new code paths.
- **Keep build/test commands in `AGENTS.md`, `CLAUDE.md`, or `README.md` up to date**.
