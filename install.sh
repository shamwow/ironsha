#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- CLI binary ---
echo "Building ironsha CLI..."
(cd "$SCRIPT_DIR" && npm install --silent && npm run build)
echo "Linking ironsha globally..."
(cd "$SCRIPT_DIR" && npm link)
echo "Installed ironsha CLI (ironsha build, ironsha state)"

# --- Commands ---
CLAUDE_CMD_DIR="${HOME}/.claude/commands"
mkdir -p "$CLAUDE_CMD_DIR"
for cmd in learn save load; do
  ln -sf "$SCRIPT_DIR/commands/$cmd.md" "$CLAUDE_CMD_DIR/$cmd.md"
  echo "Installed /$cmd → $CLAUDE_CMD_DIR/$cmd.md (symlink)"
done

echo ""
echo "Done. Available:"
echo "  CLI:      ironsha build, ironsha state"
echo "  Commands: /learn, /save, /load"
