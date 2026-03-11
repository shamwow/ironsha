# Ironsha — Multi-Platform PR Reviewer

## Context

`ironsha` is a polling daemon that drives a label-based PR review loop between GitHub and a code-capable LLM CLI. It supports four project families:

- iOS (SwiftUI)
- Android (Kotlin/Compose)
- Go webservers
- React webapps

The runtime now supports two interchangeable agent providers:

- Claude Code (`LLM_PROVIDER=claude`)
- Codex (`LLM_PROVIDER=codex`)

The poller, GitHub interactions, result parsing, and label lifecycle are shared. Provider-specific behavior is isolated to a single runner adapter.

## File Structure

```text
ironsha/
├── src/
│   ├── index.ts                   # Boot config, logger, and poller
│   ├── poller.ts                  # Poll GitHub for labeled PRs
│   ├── config.ts                  # Env parsing and provider selection
│   ├── logger.ts                  # Pino logger
│   ├── checkout/
│   │   └── repo-manager.ts        # Clone/prune checkout dirs
│   ├── github/
│   │   ├── comments.ts            # Comment/thread helpers
│   │   ├── labeler.ts             # Label mutation helpers
│   │   └── review-poster.ts       # Pull-request review posting
│   ├── review/
│   │   ├── agent-runner.ts        # Provider adapter for Claude/Codex
│   │   ├── build-runner.ts        # Build/test discovery and execution
│   │   ├── pipeline.ts            # Review orchestration
│   │   ├── platform-detector.ts   # Diff-based platform detection
│   │   ├── result-parser.ts       # Parse review-pass JSON output
│   │   └── types.ts               # Review pipeline types
│   ├── prompts/
│   │   ├── prompt-builder.ts      # Prompt registry + provider/model prompt assembly
│   │   └── *.md                   # Prompt fragments
│   ├── writer/
│   │   ├── ci-handler.ts          # bot-ci-pending handler
│   │   ├── ci-monitor.ts          # Check-run and status polling
│   │   ├── git-ops.ts             # Merge/push helpers
│   │   ├── pipeline.ts            # Code-fix orchestration
│   │   ├── result-parser.ts       # Parse code-fix JSON output
│   │   └── types.ts               # Write pipeline types
│   └── guides/                    # Platform-specific review guides
├── README.md
├── CONTRIBUTING.md
└── .env.example
```

## Runtime Model

### Poller

Every poll cycle:

1. List repos accessible to the configured GitHub token.
2. Find open PRs labeled `bot-review-needed`, `bot-changes-needed`, or `bot-ci-pending`.
3. Dispatch each PR to the matching pipeline while deduplicating in-flight work with an in-memory set.

### Shared Pipelines

The two agent-driven pipelines are:

- Review pipeline: clone -> build/test gate -> architecture pass -> (if no issues) detailed pass -> post review (REQUEST_CHANGES) -> swap labels
- Write pipeline: clone -> fetch base -> resolve merge conflicts -> code-fix pass -> build/test gate -> commit/push -> swap labels

Both pipelines depend on the same runner contract:

```ts
runAgent({
  provider,
  checkoutPath,
  promptPath,
  userMessage,
  githubToken,
  maxTurns,
  timeoutMs,
  reviewId,
  pass,
})
```

Everything outside that call is provider-agnostic.

## Provider Adapter

### Claude path

Claude preserves the existing behavior:

```bash
claude --print \
  --output-format json \
  --model {CLAUDE_MODEL} \
  --max-turns {MAX_REVIEW_TURNS} \
  --thinking enabled \
  --append-system-prompt-file {promptPath} \
  --mcp-config {tempMcpConfigPath} \
  --dangerously-skip-permissions
```

Details:

- The combined prompt is passed as an appended system prompt file.
- A temporary GitHub MCP config file is written per invocation.
- `maxTurns` is enforced through Claude’s native CLI flag.

### Codex path

Codex runs non-interactively through `codex exec`:

```bash
codex --dangerously-bypass-approvals-and-sandbox exec \
  --ephemeral \
  --output-last-message {outputPath} \
  -c 'developer_instructions="..."' \
  -c 'project_doc_fallback_filenames=["AGENTS.md","CLAUDE.md"]' \
  -c 'mcp_servers.github.enabled=true' \
  -c 'mcp_servers.github.required=true' \
  -c 'mcp_servers.github.command="npx"' \
  -c 'mcp_servers.github.args=["-y","@github/mcp-server"]' \
  -c 'mcp_servers.github.env_vars=["GITHUB_PERSONAL_ACCESS_TOKEN"]' \
  [--model {CODEX_MODEL}]
```

Details:

- The resolved prompt stack is injected through Codex `developer_instructions`.
- GitHub MCP is configured through per-process config overrides instead of a temp config file.
- `GITHUB_PERSONAL_ACCESS_TOKEN` is passed in the Codex process environment and whitelisted for the GitHub MCP server.
- Codex does not expose a native `max-turns` flag, so timeout remains the hard execution cap for Codex runs.

## Prompt and Instruction Model

Prompt assembly is centralized in `src/prompts/prompt-builder.ts`.

The builder resolves a prompt template from a code registry:

- default template per pass
- optional provider-level override
- optional exact provider/model override

Matching precedence is:

1. exact `provider + model`
2. `provider` default
3. built-in pass default

The registry is the place to change prompt stacks for a provider/model pair. No pipeline code changes are required when adjusting prompt composition.

Default prompt templates are:

```text
architecture-pass -> base.md + architecture-pass.md + platform guide
detailed-pass     -> base.md + detailed-pass.md + platform guide
code-fix          -> code-fix.md + platform guide
merge-conflict    -> merge-conflict.md
```

For example, a model-specific override can append an extra fragment such as `codex-detailed.md` for `provider=codex, model=gpt-5-codex` while leaving every other pass and provider on the default stack.

Prompt expectations:

- Output must still be a single JSON object matching the existing parser contract.
- The agent is told to read project instructions from `AGENTS.md` and `CLAUDE.md` when present.
- The agent uses GitHub MCP to inspect review threads on demand instead of receiving the full thread state in the prompt.
- If `CODEX_MODEL` is unset, prompt selection for Codex falls back to the provider-level default because there is no exact model string to match.

## Build/Test Gate

Before any review or post-fix push, the bot runs project commands discovered from repository docs in this order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `README.md`

Command extraction behavior:

- Read fenced shell blocks or `$ ...` lines from build/test-like sections.
- Preserve first-seen order across files.
- Deduplicate exact command strings so overlapping docs do not run the same command twice.

If build/tests fail before review:

- Post the failure output to the PR.
- Apply `bot-changes-needed`.
- Skip all agent review passes.

## Review/Write Output Contract

The providers share the same JSON result shapes.

Review passes return:

```json
{
  "summary": "Overall assessment",
  "new_comments": [],
  "thread_responses": []
}
```

Write pass returns:

```json
{
  "threads_addressed": [],
  "build_passed": true,
  "summary": "What changed"
}
```

The parsers are intentionally tolerant:

- Accept a raw JSON object
- Accept a fenced ```json block
- Accept a provider envelope that stores the final text in a top-level `result` field

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
- `bot-ci-pending`
- `human-review-needed`
- `bot-human-intervention`

Lifecycle:

```text
bot-review-needed
  -> review pipeline (posts with REQUEST_CHANGES event when issues are found)
  -> human-review-needed | bot-changes-needed

bot-changes-needed
  -> write pipeline
  -> bot-ci-pending | bot-human-intervention

bot-ci-pending
  -> CI handler
  -> bot-review-needed | bot-changes-needed
```

## Design Constraints

- Provider selection is process-wide via `LLM_PROVIDER`.
- The selected provider is used for architecture review, detailed review, code-fix, and merge-conflict resolution.
- GitHub remains the single source of truth for PR state, labels, comments, and resolved-thread reactions.
- The runner adapter is the only place that should know about provider-specific CLI flags, MCP wiring, or auth semantics.
