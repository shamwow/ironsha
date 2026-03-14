#!/usr/bin/env bash
# Stop hook: if the assistant created or updated a PR, wait for review and respond.
# Only fires once per turn — if stop_hook_active is true, we're already re-running.

INPUT=$(cat)

if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

# Check if the assistant's turn involved PR creation or update
if echo "$INPUT" | grep -qE '(gh pr create|gh pr edit|gh pr ready|gh pr review|Created pull request|pull request.*created|/pull/[0-9])'; then
  cat <<'EOF'
{"decision":"block","reason":"You created or updated a PR. Wait for the review to finish — poll with `gh pr checks` and `gh pr view --json reviews,comments` until the review is complete. If the reviewer requests changes, address them, push, and wait again. Only proceed once the PR is approved or has no outstanding review comments."}
EOF
  exit 2
fi

exit 0
