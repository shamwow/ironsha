# ironsha

Toolkit which sets up an opinionated agent powered coding workflow the way @shamwow like it.

## Prerequisites

- Node.js 18+
- A GitHub Personal Access Token with `repo` and `read:org` scopes
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` on `PATH`)

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
   # Required
   GITHUB_TOKEN=ghp_your_token_here

   # Claude auth
   ANTHROPIC_API_KEY=sk-ant-your_key_here
   # Or run `claude login` and leave ANTHROPIC_API_KEY unset
   ```

The GitHub token must belong to the GitHub account that will post reviews. The bot polls all repos this account owns or collaborates on.

## Running

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | Yes | — | GitHub PAT with `repo` and `read:org` scopes |
| `ANTHROPIC_API_KEY` | No | — | Claude auth. Omit if using `claude login` |
| `CLAUDE_MODEL` | No | `claude-opus-4-6` | Model for Claude runs |
| `MAX_REVIEW_TURNS` | No | `30` | Max agentic turns per review pass |
| `POLL_INTERVAL_MS` | No | `60000` | Polling interval in milliseconds |
| `REVIEW_TIMEOUT_MS` | No | `600000` | Timeout per review agent invocation |
| `MAX_WRITE_TURNS` | No | `50` | Max agentic turns per code-fix pass |
| `WRITE_TIMEOUT_MS` | No | `900000` | Timeout per code-fix agent invocation |
| `MAX_REVIEW_CYCLES` | No | `5` | Max review-fix cycles before requesting human intervention |
| `CI_POLL_TIMEOUT_MS` | No | `600000` | Timeout for CI checks before treating as failure |
| `MERGE_CONFLICT_TIMEOUT_MS` | No | `300000` | Timeout for merge-conflict resolution |
| `WORK_DIR` | No | `/tmp/ironsha` | Directory for cloning PR branches |
| `TRANSCRIPT_DIR` | No | `/tmp/ironsha/transcripts` | Directory for saved agent output, stderr, and per-run metadata |
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |

## Project Requirements

Reviewed repositories should keep build and test commands in one or more of:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`

ironsha reads those files in that order, extracts build/test commands, and deduplicates exact command strings before running them.

## How it works

The bot polls GitHub every 60 seconds for open PRs with the `bot-review-needed`, `bot-changes-needed`, or `bot-ci-pending` label across all repos the token can access.

**Review pipeline** (`bot-review-needed`):
1. Clone the PR branch into a temp directory.
2. Run the project's build and test commands from `AGENTS.md`, `CLAUDE.md`, or `README.md`.
3. If build/tests pass, run an architecture review pass. If no architecture issues are found, run a detailed review pass.
4. Post review with GitHub's "Request changes" status when issues are found, mark resolved threads with emoji reactions, and swap labels.

**Write pipeline** (`bot-changes-needed`):
1. Enforce the review-cycle limit.
2. Clone the PR branch, fetch base, and resolve merge conflicts.
3. Run one code-fix pass — the agent reads unresolved review comments via GitHub MCP and writes code to address them.
4. Run build/tests as a safety net.
5. If changes pass, commit, push, post thread replies, and swap to `bot-ci-pending`.

**CI handler** (`bot-ci-pending`):
1. Check GitHub Check Runs and Commit Statuses.
2. If CI passes: swap back to `bot-review-needed`.
3. If CI fails: swap to `bot-changes-needed`.
4. If CI is pending: leave the PR alone until the next poll cycle.

Every bot comment includes a role prefix (`reviewer` or `writer`) followed by a `thread::{uuid}` footer tag, plus a `review::{uuid}` tag that identifies the review cycle which produced it.

## Development Notes

- Run ironsha outside a Claude Code session. Nested Claude sessions are blocked.
- `npm run dev` uses `tsx --watch`, so source changes restart the bot automatically.
- `npm run test` compiles the project and runs the Node built-in test suite against the compiled output.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed design and the "Contributing — LLM Compatibility Guide" section for the repository contract expected from submitting agents.
