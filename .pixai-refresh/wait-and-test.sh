#!/bin/bash
# 等待腾讯云限流窗口解除后,单次验证 SSH 22443
sleep 1800
cd /home/lenovo/Desktop/image-app
for i in 1 2 3; do
  R=$(timeout 40 node .dsh-ssh/exec.js "hostname && date -u +%H:%M:%S" 2>&1 | tail -1)
  echo "[$(date -u +%H:%M:%S)] try $i: $R" >> /home/lenovo/Desktop/image-app/.pixai-refresh/ssh-recheck.log
  case "$R" in VM-*) echo "SSH_RECOVERED"; exit 0;; esac
  sleep 10
done
echo "STILL_BLOCKED" >> /home/lenovo/Desktop/image-app/.pixai-refresh/ssh-recheck.log
