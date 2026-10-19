#!/usr/bin/env bash
# prompt-release.sh — 提示词/技能/文案快速发布（2026-10-19）
#
# 并行发布 runtime 与 gateway，两个子发布都走 --fast：
#   --fast = --skip-recon --force：跳过 recon 与 drain，立即重启。
# 目标：<60s。用于改 AGENTS.md / skills / prompt-registry / expert 文案这类短改。
# 代价：会中断 2-5 条在途流；耐久回合由 harness 续接。需要保护长任务时不要用本脚本。
#
# 用法：
#   bash deploy/vps/prompt-release.sh [--sha C]
#
# 环境：OC_SSH_PORT / GW_SSH_PORT / OC_SSH_KEY / GW_SSH_KEY 同各自脚本。
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGDIR="${TMPDIR:-/tmp}/prompt-release-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$LOGDIR"

bash "$ROOT/deploy/vps/opencode-release.sh" release --prompts-only "$@" >"$LOGDIR/runtime.log" 2>&1 & p1=$!
bash "$ROOT/deploy/vps/gateway-release.sh" release --fast "$@" >"$LOGDIR/gateway.log" 2>&1 & p2=$!

r1=0; wait "$p1" || r1=$?
r2=0; wait "$p2" || r2=$?

echo "== runtime (exit $r1)"; tail -n 10 "$LOGDIR/runtime.log"
echo "== gateway (exit $r2)"; tail -n 10 "$LOGDIR/gateway.log"
echo "logs: $LOGDIR"
[ "$r1" -eq 0 ] && [ "$r2" -eq 0 ]
