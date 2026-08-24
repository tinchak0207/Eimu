#!/bin/bash
# start-ssh443.sh — 幂等启动 SSH-over-443 隧道(ws-tunnel-node.js)
# 用法: bash start-ssh443.sh [port]   (默认 22222)
PORT="${1:-22222}"
DIR="/home/lenovo/Desktop/image-app/.pixai-refresh"
LOG="$DIR/ws-tunnel-node.log"

# 已在跑则跳过
if pgrep -f "ws-tunnel-node.js $PORT" > /dev/null 2>&1; then
  echo "tunnel already running on $PORT"
  exit 0
fi

# 端口被占用则清掉(旧的 python/gost 残留)
if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  for pid in $(lsof -ti :$PORT 2>/dev/null); do kill -9 $pid 2>/dev/null; done
  sleep 1
fi

setsid node "$DIR/ws-tunnel-node.js" "$PORT" > "$LOG" 2>&1 < /dev/null &
sleep 2
head -1 "$LOG"
