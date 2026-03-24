#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"

nohup tsx src/index.ts &

echo $! > "$LOG_DIR/ironsha.pid"
echo "Started (pid $!, logs: $LOG_DIR/)"
