#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_AGENT_DIR="${HOME}/.claude/agents"

# Install agents as symlinks
mkdir -p "$CLAUDE_AGENT_DIR"
for agent in implement plan; do
  ln -sf "$SCRIPT_DIR/.claude/agents/$agent.md" "$CLAUDE_AGENT_DIR/$agent.md"
  echo "Installed $agent agent → $CLAUDE_AGENT_DIR/$agent.md (symlink)"
done

echo ""
echo "Done. Available agents: implement, plan"
