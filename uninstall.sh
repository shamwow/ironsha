#!/usr/bin/env bash
set -euo pipefail

# --- Commands ---
for cmd in learn save load ironsha-local; do
  rm -f "${HOME}/.claude/commands/$cmd.md"
  echo "Removed /$cmd command"
done

# --- Stop hooks ---
rm -f "${HOME}/.claude/scripts/lessons-query-check.sh"
rm -f "${HOME}/.claude/scripts/lessons-use-check.sh"
rm -f "${HOME}/.claude/scripts/stop-hook.sh"
rm -f "${HOME}/.claude/scripts/revision-hook.sh"
rm -f /tmp/.ironsha-revision-requested
echo "Removed stop hooks"

# Remove Stop hook entries from settings.json
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
if [ -f "$CLAUDE_SETTINGS" ] && command -v jq &>/dev/null; then
  TMPFILE=$(mktemp)
  jq '
    if .hooks?.Stop then
      .hooks.Stop = [.hooks.Stop[] | select(.hooks | all(
        ((.command // "" | contains("stop-hook")) or (.command // "" | contains("revision-hook")) or (.command // "" | contains("lessons-query-check")) or (.command // "" | contains("lessons-use-check")) or (.prompt // "" | contains("qmd query"))) | not
      ))] |
      if .hooks.Stop == [] then del(.hooks.Stop) else . end |
      if .hooks == {} then del(.hooks) else . end
    else . end
  ' "$CLAUDE_SETTINGS" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_SETTINGS"
  echo "Removed Stop hooks from $CLAUDE_SETTINGS"
fi

echo ""
echo "Done. All ironsha components uninstalled."
