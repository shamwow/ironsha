#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"

nohup npx tsx src/index.ts > "$LOG_DIR/nohup.out" 2>&1 &

echo $! > "$LOG_DIR/ironsha.pid"
echo "Started (pid $!, logs: $LOG_DIR/)"
