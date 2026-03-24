#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-./logs}"

if [ -f "$LOG_DIR/ironsha.pid" ]; then
  kill "$(cat "$LOG_DIR/ironsha.pid")" 2>/dev/null && echo "Stopped" || echo "Not running"
  rm -f "$LOG_DIR/ironsha.pid"
else
  echo "Not running"
fi
