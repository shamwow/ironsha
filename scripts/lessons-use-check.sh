#!/usr/bin/env bash
# Stop hook: ensure Claude incorporates qmd lesson results into its response.
# Uses a temp marker to only fire once per turn (after the qmd query hook passes).

INPUT=$(cat)
REVISION_MARKER="/tmp/.ironsha-revision-requested"

# If revision was already requested and is recent, pass through
if [ -f "$REVISION_MARKER" ]; then
  MARKER_TIME=$(cat "$REVISION_MARKER" 2>/dev/null || echo 0)
  CURRENT_TIME=$(date +%s)
  if [ $((CURRENT_TIME - MARKER_TIME)) -lt 300 ]; then
    rm -f "$REVISION_MARKER"
    exit 0
  fi
  rm -f "$REVISION_MARKER"
fi

# On retry (stop_hook_active), the qmd query hook already passed — now request revision
if echo "$INPUT" | grep -q '"stop_hook_active":true'; then
  date +%s > "$REVISION_MARKER"
  cat <<'EOF'
{"decision":"block","reason":"Spin up an agent to check if each lesson returned changed the response."}
EOF
  exit 2
fi

# First invocation — let the qmd query hook handle this phase
exit 0
