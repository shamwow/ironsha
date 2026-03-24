#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-./logs}"
mkdir -p "$LOG_DIR"

nohup tsx src/index.ts 2>&1 | npx pino-roll \
  --file "$LOG_DIR/ironsha" \
  --frequency daily \
  --extension .log \
  --limit 7 &

echo $! > "$LOG_DIR/ironsha.pid"
echo "Started (pid $!, logs: $LOG_DIR/)"
