# ironsha

Toolkit which sets up an opinionated agent powered coding workflow the way @shamwow likes it.

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` on `PATH`)
- A GitHub Personal Access Token with `repo` scope (only needed for `publish`)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Fill in your `.env`:
   ```bash
   # Claude auth
   ANTHROPIC_API_KEY=sk-ant-your_key_here
   # Or run `claude login` and leave ANTHROPIC_API_KEY unset

   # Optional — only needed for publishing to GitHub
   # GITHUB_TOKEN=ghp_your_token_here
   ```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | No | — | Claude auth. Omit if using `claude login` |
| `GITHUB_TOKEN` | No | — | GitHub PAT — only needed for `npm run state -- publish` |
| `CLAUDE_MODEL` | No | `claude-opus-4-6` | Model for Claude runs |
| `MAX_REVIEW_TURNS` | No | `30` | Max agentic turns per review pass |
| `REVIEW_TIMEOUT_MS` | No | `600000` | Timeout per review agent invocation |
| `TRANSCRIPT_DIR` | No | `/tmp/ironsha/transcripts` | Directory for saved agent output, stderr, and per-run metadata |
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |

## How it works

The review workflow runs entirely locally via the `/ironsha-local` Claude Code skill. No polling daemon or GitHub round-trips are needed during review.

**Local review loop:**
1. Plan and implement code changes locally.
2. Initialize local state: `npm run state -- init`
3. The review pipeline runs against the local checkout — build/test gate, architecture pass, detailed pass.
4. Review comments and labels are stored in `.ironsha/` JSON files.
5. If changes are requested, the fix agent addresses them and the review re-runs.
6. Once approved, publish everything to GitHub: `npm run state -- publish`

**Local state CLI** (`npm run state`):

| Command | Description |
|---|---|
| `init` | Initialize local state for current branch |
| `show` | Print full local state JSON |
| `label` / `label set <label>` | Get or set the current label |
| `description set --body <text>` | Set PR description |
| `review post --json <json>` | Post a review from JSON |
| `resolve <comment-id>` | Mark a comment as resolved |
| `threads` | Print formatted thread state |
| `unresolved` | Show unresolved thread count |
| `diff` | List changed files |
| `publish` | Push branch and create GitHub PR with all review history |

## Project Requirements

Reviewed repositories should keep build and test commands in one or more of:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`

ironsha reads those files in that order, extracts build/test commands, and deduplicates exact command strings before running them.

## Development Notes

- `npm run test` compiles the project and runs the Node built-in test suite against the compiled output.
- `npm run test:integration` runs the full integration test with real LLM calls.
- `npm run test:integration:mock_llm` runs integration tests with mock agent responses (faster).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed design.
