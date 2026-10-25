#!/bin/sh
# 先把宿主上的增量写进冻结镜像的 chunk，再降到 nextjs 跑原来的入口。
# 每次启动都要重跑：镜像重建后 chunk 会回到未打补丁的状态。
set -eu
cd /app
node /runtime-delta/apply-a6api-channel.js
node /runtime-delta/apply-h3-content-ir.js
if [ "$(id -u)" -eq 0 ]; then
  exec su -s /bin/sh nextjs -c 'cd /app && exec /usr/local/bin/docker-entrypoint.sh node server.js'
fi
exec /usr/local/bin/docker-entrypoint.sh node server.js
