#!/usr/bin/env bash
# Stop hook: remind to run qmd query for lessons if appropriate.
# Only fires once per turn — if stop_hook_active is true, we're already re-running.

INPUT=$(cat)

if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  exit 0
fi

cat <<'EOF'
{"decision":"block","reason":"If you haven't already, run qmd query for relevant lessons before responding. Run six queries (all in parallel): (1) task specifically, (2) general type of task, (3) specific workflow, (4) generalized workflow, (5) specific process, (6) generalized process. If you already ran qmd queries this turn, proceed normally."}
EOF
exit 2
