#!/bin/bash
# 每 90 秒单次探测,最多 8 次(约 12 分钟),成功即退出
cd /home/lenovo/Desktop/image-app
for i in $(seq 1 8); do
  R=$(timeout 30 node .dsh-ssh/exec.js "hostname" 2>&1 | tail -1)
  echo "[$(date -u +%H:%M:%S)] probe $i: $R" >> /home/lenovo/Desktop/image-app/.pixai-refresh/ssh-probe.log
  case "$R" in VM-*) echo "SSH_BACK"; exit 0;; esac
  sleep 90
done
echo "STILL_LIMITED" >> /home/lenovo/Desktop/image-app/.pixai-refresh/ssh-probe.log
