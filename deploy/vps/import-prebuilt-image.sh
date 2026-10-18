#!/usr/bin/env bash
# 离机构建镜像导入。接收 docker save 的 tar，load 后按 compose 里已有服务 up -d。
# 不写密钥。镜像标签须已与 compose 项目期望的名字一致。不要在本机对生产执行。
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf '%s\n' "用法: $0 <images.tar> [compose文件]" >&2
  exit 2
fi

TAR=$1
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE=${2:-"$ROOT/control-plane-compose.yml"}

if [[ ! -f "$TAR" ]]; then
  printf '%s\n' "找不到镜像归档: $TAR" >&2
  exit 2
fi
if [[ ! -f "$COMPOSE" ]]; then
  printf '%s\n' "找不到 compose: $COMPOSE" >&2
  exit 2
fi

docker load -i "$TAR"
docker compose -f "$COMPOSE" up -d --no-build
