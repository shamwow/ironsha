# ironsha

A webhook-driven daemon that reviews pull requests using either Claude Code or Codex. Supports iOS (SwiftUI), Android (Kotlin/Compose), Go webservers, and React webapps.

## Prerequisites

- Node.js 18+
- A GitHub App (see [Setup](#setup))
- One provider CLI installed, depending on `LLM_PROVIDER`:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` on `PATH`)
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex` on `PATH`)

## Setup

### 1. Create a GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set the following permissions:
   - **Repository permissions:**
     - Pull requests: Read & write
     - Issues: Read & write
     - Checks: Read
     - Contents: Read
3. Subscribe to these webhook events:
   - `pull_request`
   - `check_suite`
4. Generate a private key and download the `.pem` file
5. Note your **App ID** from the app settings page
6. Set a **Webhook secret** (a random string you generate)

### 2. Install the App

Install the GitHub App on the repositories (or organization) you want ironsha to review.

### 3. Configure the environment

```bash
npm install
cp .env.example .env
```

Fill in your `.env`:
```bash
# Required
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=/path/to/private-key.pem
GITHUB_WEBHOOK_SECRET=your_secret

# Provider selection
LLM_PROVIDER=claude

# Claude auth (only needed when LLM_PROVIDER=claude)
ANTHROPIC_API_KEY=sk-ant-your_key_here
# Or run `claude login` and leave ANTHROPIC_API_KEY unset
```

### 4. Set the webhook URL

Point your GitHub App's webhook URL to your server (e.g., `https://your-server.com/api/github/webhooks`).

For local development, use [Smee](https://smee.io) — see [Local Development](#local-development).

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
| `GITHUB_APP_ID` | Yes | — | Numeric App ID from GitHub App settings |
| `GITHUB_APP_PRIVATE_KEY` | Yes | — | PEM string or path to `.pem` file |
| `GITHUB_WEBHOOK_SECRET` | Yes | — | Shared secret for webhook signature verification |
| `WEBHOOK_PORT` | No | `3000` | Port for the webhook HTTP server |
| `SMEE_URL` | No | — | Smee channel URL for local development |
| `TEST_GITHUB_TOKEN` | No | — | PAT for integration tests only |
| `LLM_PROVIDER` | No | `claude` | Which agent CLI to run: `claude` or `codex` |
| `ANTHROPIC_API_KEY` | No | — | Claude auth. Omit if using `claude login` |
| `CLAUDE_MODEL` | No | `claude-opus-4-6` | Model for Claude runs |
| `CODEX_MODEL` | No | — | Optional model override for Codex runs |
| `MAX_REVIEW_TURNS` | No | `30` | Max agentic turns per review pass. Used by Claude; Codex ignores it |
| `REVIEW_TIMEOUT_MS` | No | `600000` | Timeout per review agent invocation |
| `MAX_WRITE_TURNS` | No | `50` | Max agentic turns per code-fix pass. Used by Claude; Codex ignores it |
| `WRITE_TIMEOUT_MS` | No | `900000` | Timeout per code-fix agent invocation |
| `MAX_REVIEW_CYCLES` | No | `5` | Max review-fix cycles before requesting human intervention |
| `CI_POLL_TIMEOUT_MS` | No | `600000` | Timeout for CI checks before treating as failure |
| `MERGE_CONFLICT_TIMEOUT_MS` | No | `300000` | Timeout for merge-conflict resolution |
| `WORK_DIR` | No | `/tmp/ironsha` | Directory for cloning PR branches |
| `TRANSCRIPT_DIR` | No | `/tmp/ironsha/transcripts` | Directory for saved agent output, stderr, and per-run metadata |
| `LOG_LEVEL` | No | `info` | Log level (`debug`, `info`, `warn`, `error`) |

## Provider Notes

- `LLM_PROVIDER=claude` preserves the original behavior: `claude --print` with the existing JSON prompt contract.
- `LLM_PROVIDER=codex` runs `codex exec` non-interactively, injects the same review instructions through Codex developer instructions, and wires the GitHub MCP server per invocation.
- Codex reads `AGENTS.md` natively. ironsha also keeps `CLAUDE.md` as a fallback instruction filename for Codex runs.

## Project Requirements

Reviewed repositories should keep build and test commands in one or more of:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`

ironsha reads those files in that order, extracts build/test commands, and deduplicates exact command strings before running them.

## How it works

The bot runs as an HTTP server that receives GitHub webhook events. When a PR is labeled, the matching pipeline is dispatched.

**Review pipeline** (`bot-review-needed`):
1. Clone the PR branch into a temp directory.
2. Run the project's build and test commands from `AGENTS.md`, `CLAUDE.md`, or `README.md`.
3. If build/tests pass, run an architecture review pass. If no architecture issues are found, run a detailed review pass.
4. Post review with GitHub's "Request changes" status when issues are found, mark resolved threads with emoji reactions, and swap labels.

**Write pipeline** (`bot-changes-needed`):
1. Enforce the review-cycle limit.
2. Clone the PR branch, fetch base, and resolve merge conflicts through the selected provider.
3. Run one code-fix pass against unresolved review comments.
4. Run build/tests as a safety net.
5. If changes pass, commit, push, post thread replies, and swap to `bot-ci-pending`.

**CI handler** (`bot-ci-pending`):
1. Check GitHub Check Runs and Commit Statuses.
2. If CI passes: swap back to `bot-review-needed`.
3. If CI fails: post failure details and swap to `bot-changes-needed`.

The `check_suite.completed` webhook event replaces CI polling — GitHub notifies ironsha the moment CI finishes.

Every bot comment includes a `thread::{uuid}` footer tag, plus a `review::{uuid}` tag that identifies the review cycle which produced it.

## Local Development

For local development, use [Smee](https://smee.io) to forward webhooks to your machine:

1. Go to https://smee.io/new and copy the channel URL
2. Set `SMEE_URL` in your `.env` to the channel URL
3. Set your GitHub App's webhook URL to the same Smee channel URL
4. Run `npm run dev` — the Smee proxy starts automatically

The dev server uses `tsx --watch`, so source changes restart the bot automatically.

## Testing

- `npm run test` — compiles the project and runs the Node built-in test suite
- `npm run test:integration:mock_llm` — integration tests with mock LLM responses
- `npm run test:integration` — integration tests with real LLM (requires `TEST_GITHUB_TOKEN`)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the detailed design and [CONTRIBUTING.md](CONTRIBUTING.md) for the repository contract expected from submitting agents.
