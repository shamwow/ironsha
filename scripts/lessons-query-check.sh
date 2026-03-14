#!/usr/bin/env bash
# Stop hook: remind to run qmd query for lessons if appropriate.
# Only fires once per turn — if stop_hook_active is true, we're already re-running.

INPUT=$(cat)

if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

cat <<'EOF'
{"decision":"block","reason":"If you haven't already, run a single structured qmd query for relevant lessons before responding. Use six vec: lines in one call: vec: <task specifically>, vec: <general type of task>, vec: <specific workflow>, vec: <generalized workflow>, vec: <specific process>, vec: <generalized process>. Avoid hyphens in queries. If you already ran qmd queries this turn, proceed normally. Don't check for lessons in any other way, always run qmd unless you have already ran it."}
EOF
exit 2
