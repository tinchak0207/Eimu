#!/bin/bash
# 内存守卫:used% >= 65% 时自动重启 pixai 注册(释放 headless chrome renderer)
# pool 每账号即时落盘,重启不丢进度;邮箱自动过滤已用
REGDIR=/home/lenovo/Desktop/image-app/.pixai-refresh
POOL=/home/lenovo/Desktop/image-app/pixai-pool-new.json
LOG=$REGDIR/memguard.log
THRESHOLD=65
INTERVAL=60
PROXY_PORTS="24000,24001,24002,24003,24004,24005,24006,24007,24008,24009,24010,24011,24012,24013"
CONCURRENCY=3

log() { echo "$(date '+%F %T') $1" >> "$LOG"; }

restart_register() {
  local pct=$1
  log "memory ${pct}% >= ${THRESHOLD}%, restarting register"
  local REGPID=$(pgrep -f "register-pixai-accounts.js" | head -1)
  if [ -n "$REGPID" ]; then
    # 只杀注册的 chrome(/tmp/playwright_chromiumdev_profile 专属,不碰桌面 chrome)
    pkill -9 -f "playwright_chromiumdev_profile" 2>/dev/null
    sleep 1
    kill -9 "$REGPID" 2>/dev/null
    sleep 3
  fi
  local POOL_N=$(python3 -c "import json;print(len(json.load(open('$POOL'))))" 2>/dev/null || echo '?')
  cd "$REGDIR" || return 1
  PROXY_PORTS=$PROXY_PORTS CONCURRENCY=$CONCURRENCY nohup node register-pixai-accounts.js 1000 >> register-full.log 2>&1 &
  log "restarted, pool=$POOL_N, new pid=$!"
}

log "memguard started (threshold=${THRESHOLD}%, interval=${INTERVAL}s)"
while true; do
  USED_PCT=$(awk '/MemTotal|MemAvailable/ {if($1=="MemTotal:"){t=$2}; if($1=="MemAvailable:"){a=$2}} END{printf "%d", (t-a)*100/t}' /proc/meminfo)
  if [ -n "$USED_PCT" ] && [ "$USED_PCT" -ge "$THRESHOLD" ]; then
    restart_register "$USED_PCT"
  fi
  sleep $INTERVAL
done
