#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Commands ---
CLAUDE_CMD_DIR="${HOME}/.claude/commands"
mkdir -p "$CLAUDE_CMD_DIR"
for cmd in learn save load ironsha-local; do
  ln -sf "$SCRIPT_DIR/commands/$cmd.md" "$CLAUDE_CMD_DIR/$cmd.md"
  echo "Installed /$cmd → $CLAUDE_CMD_DIR/$cmd.md (symlink)"
done

# --- Stop hooks ---
CLAUDE_SCRIPT_DIR="${HOME}/.claude/scripts"
mkdir -p "$CLAUDE_SCRIPT_DIR"
ln -sf "$SCRIPT_DIR/scripts/lessons-query-check.sh" "$CLAUDE_SCRIPT_DIR/lessons-query-check.sh"
echo "Installed lessons-query-check.sh → $CLAUDE_SCRIPT_DIR/lessons-query-check.sh (symlink)"
ln -sf "$SCRIPT_DIR/scripts/lessons-use-check.sh" "$CLAUDE_SCRIPT_DIR/lessons-use-check.sh"
echo "Installed lessons-use-check.sh → $CLAUDE_SCRIPT_DIR/lessons-use-check.sh (symlink)"
# Clean up old hook names
rm -f "$CLAUDE_SCRIPT_DIR/stop-hook.sh" "$CLAUDE_SCRIPT_DIR/revision-hook.sh"

# --- qmd (lesson search) ---
if command -v qmd &>/dev/null; then
  LESSONS_DIR="$SCRIPT_DIR/.lessons"
  if [ -d "$LESSONS_DIR" ]; then
    # Add the .lessons directory as a qmd collection (idempotent — removes first if exists)
    qmd collection remove lessons 2>/dev/null || true
    qmd collection add "$LESSONS_DIR" --name lessons 2>/dev/null || \
      qmd collection add "$LESSONS_DIR" 2>/dev/null || true
    # Build embeddings so vec: queries work
    qmd embed 2>/dev/null || true
    echo "Indexed .lessons/ into qmd collection 'lessons'"
  else
    echo "Warning: .lessons/ directory not found — skipping qmd setup"
  fi
else
  echo "Warning: qmd not found — lesson search will not work. Install qmd and re-run."
fi

# Add Stop hooks to enforce lesson lookup and revision
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
QUERY_HOOK_CMD="${CLAUDE_SCRIPT_DIR}/lessons-query-check.sh"
USE_HOOK_CMD="${CLAUDE_SCRIPT_DIR}/lessons-use-check.sh"

if command -v jq &>/dev/null; then
  # Create settings.json if it doesn't exist
  [ -f "$CLAUDE_SETTINGS" ] || echo '{}' > "$CLAUDE_SETTINGS"

  # Remove any existing lesson-related Stop hooks, then add both
  TMPFILE=$(mktemp)
  jq --arg query_cmd "$QUERY_HOOK_CMD" --arg use_cmd "$USE_HOOK_CMD" '
    .hooks //= {} |
    .hooks.Stop //= [] |
    .hooks.Stop = [.hooks.Stop[] | select(.hooks | all(
      ((.command // "" | contains("stop-hook")) or (.command // "" | contains("revision-hook")) or (.command // "" | contains("lessons-query-check")) or (.command // "" | contains("lessons-use-check")) or (.command // "" | contains("pr-review-check")) or (.prompt // "" | contains("qmd query"))) | not
    ))] |
    .hooks.Stop += [
      {
        "hooks": [{
          "type": "command",
          "command": $query_cmd
        }]
      },
      {
        "hooks": [{
          "type": "command",
          "command": $use_cmd
        }]
      }
    ]
  ' "$CLAUDE_SETTINGS" > "$TMPFILE" && mv "$TMPFILE" "$CLAUDE_SETTINGS"
  echo "Installed Stop hooks for lesson lookup and revision in $CLAUDE_SETTINGS"
else
  echo "Warning: jq not found — could not install Stop hooks. Install jq and re-run, or manually add the hooks to $CLAUDE_SETTINGS"
fi

echo ""
echo "Done. Available:"
echo "  Commands: /learn, /save, /load, /ironsha-local"
echo "  Lessons:  qmd query (searches .lessons/)"
