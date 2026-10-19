#!/usr/bin/env bash
# vps-opencode-recon.sh — VPS 生产 .opencode 手维护子集 与 本地 git HEAD 对账
# 用法：bash deploy-staging/vps-tools/vps-opencode-recon.sh
#   0 = 一致；1 = 有实质漂移（挡部署，先收编再动）；2 = 连线/工具故障
#
# 与 vps-gateway-recon.sh 的关系：同型，但对象是第二可变面 workspace/.opencode。
# 只对账手维护子集（tools/lib/skills/plugin＋4 个设定档）；vendored 的 node_modules/
# services 与执行时状态 opencode.db/*.redteam-* 永不参与，否则对账会被 898MB 噪音淹没。
set -euo pipefail

# 连线可覆写（预设＝原 22443 直连，行为逐位不变）：22443 连续 2-3 次即被 ISP RST，
# 多次连线的发布流程改走 SSH-over-443 隧道（127.0.0.1:22222）更稳。
SSH_KEY="${VPS_SSH_KEY:-/home/user/.ssh/id_ed25519}"
SSH_PORT="${VPS_SSH_PORT:-22443}"
SSH_TARGET="${VPS_SSH_TARGET:-ubuntu@YOUR_SERVER_IP}"
SSH_CMD=(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET")
VPS_DIR=/opt/eimu-harness/workspace/.opencode
LOCAL_DIR="$(cd "$(dirname "$0")/../opencode-runtime" && pwd)"
TMP_DIR=$(mktemp -d /tmp/vps-oc-recon.XXXXXX)
WORKTREE=""
GIT_DIR=""
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$WORKTREE" ] && [ -n "$GIT_DIR" ]; then
    git -C "$GIT_DIR" worktree remove --force "$WORKTREE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)
WORKSPACE_DIR="$(dirname "$VPS_DIR")"
# workspace 根的手维护设定档：repo 内放在镜像根，但**部署目标是 workspace/ 而非 .opencode/**
ROOT_FILES=(AGENTS.md)

# 1. 只拉手维护子集
"${SSH_CMD[@]}" "sudo tar -C $VPS_DIR \
  --exclude='node_modules' --exclude='services' \
  --exclude='opencode.db' --exclude='opencode.db-*' \
  --exclude='*.redteam-*' --exclude='*.bak*' --exclude='__pycache__' \
  -cf - ${SCOPE[*]} ${CONFIGS[*]} 2>/dev/null" | tar -C "$TMP_DIR" -xf -
if [ ! -d "$TMP_DIR/tools" ]; then
  echo "RECON_FAIL: VPS 拉取失败或为空（连线/权限问题）"; exit 2
fi

# 2. 基准＝RECON_BASE（预设 HEAD）。发布流程应传「上次已发布的 commit」：
#    比对「生产 vs HEAD」会在正常要发布新 commit 时一律误判为漂移，逼人 --skip-recon 绕过闸门。
#    正确语义是「生产是否仍等于我们上次发出去的那一版」。
GIT_DIR=$(git -C "$LOCAL_DIR" rev-parse --show-toplevel)
WORKTREE=$(mktemp -d /tmp/vps-oc-recon-head.XXXXXX)
BASE="${RECON_BASE:-HEAD}"
git -C "$GIT_DIR" worktree add --quiet --detach "$WORKTREE" "$BASE" || { echo "RECON_FAIL: 无法解析基准 $BASE"; exit 2; }
HEAD_DIR="$WORKTREE/deploy-staging/opencode-runtime"

# 漂移比对排除清单（不影响发布安装）：
#   opencode.json 由 gateway 的 gen-opencode.ts 于执行期从 model registry 重新生成（单一写者），
#   与 opencode 轨基准 commit 恒不相符 → 不纳入漂移比对（2026-10-03）。
#   注意：此处只排除「比对」；发布安装清单仍由 opencode-release.sh 的 CONFIGS 决定，行为不变。
DRIFT_EXCLUDE=(opencode.json)

list_of() {
  local root="$1"
  ( cd "$root"
    find "${SCOPE[@]}" -type f ! -path '*/__pycache__/*' 2>/dev/null
    for c in "${CONFIGS[@]}"; do [ -f "$c" ] && echo "$c"; done
  ) | grep -vxF -e "${DRIFT_EXCLUDE[@]}" | sort
}
list_of "$HEAD_DIR" > "$TMP_DIR/head-files.txt"
list_of "$TMP_DIR"  > "$TMP_DIR/vps-files.txt"

drift=0
if [ -n "$(comm -23 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")" ]; then
  while read -r f; do echo "ONLY_LOCAL $f（VPS 缺，确认是否该部署）"; done < <(comm -23 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")
  drift=1
fi
if [ -n "$(comm -13 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")" ]; then
  while read -r f; do echo "ONLY_VPS $f（生产多出，release 会删）"; done < <(comm -13 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")
  drift=1
fi
while read -r f; do
  [ -f "$TMP_DIR/$f" ] && [ -f "$HEAD_DIR/$f" ] || continue
  if ! cmp -s "$HEAD_DIR/$f" "$TMP_DIR/$f"; then
    echo "DIFF $f"; drift=1
  fi
done < "$TMP_DIR/head-files.txt"

# 4. workspace 根的手维护设定档（位置与 .opencode/ 不同，故独立比对）
for rf in "${ROOT_FILES[@]}"; do
  if [ -f "$HEAD_DIR/$rf" ]; then
    "${SSH_CMD[@]}" "sudo cat '$WORKSPACE_DIR/$rf'" > "$TMP_DIR/root-$rf" 2>/dev/null || true
    if [ -s "$TMP_DIR/root-$rf" ]; then
      cmp -s "$HEAD_DIR/$rf" "$TMP_DIR/root-$rf" || { echo "DIFF $rf（workspace 根）"; drift=1; }
    else
      echo "ONLY_LOCAL $rf（workspace 根：repo 有、生产缺）"; drift=1
    fi
  elif "${SSH_CMD[@]}" "sudo test -f '$WORKSPACE_DIR/$rf'" 2>/dev/null; then
    # 基准版没有、但 repo 的 HEAD 有 → 这是「本次导入一条新的受管路径」，不是漂移；
    # 否则会出现鸡生蛋：生产那份待修的档案反而挡住修它的发布。
    if git -C "$GIT_DIR" cat-file -e "HEAD:deploy-staging/opencode-runtime/$rf" 2>/dev/null; then
      echo "INFO $rf（workspace 根）：repo 已纳管、基准版尚无 → 视为导入，不计漂移"
    else
      echo "ONLY_VPS $rf（workspace 根：生产有、repo 缺）"; drift=1
    fi
  fi
done

if [ "$drift" -eq 0 ]; then
  echo "RECON_OK: .opencode 生产与基准 $BASE 一致（$(wc -l < "$TMP_DIR/head-files.txt") 档）"
else
  echo "RECON_DRIFT: .opencode 生产与基准 $BASE 有实质漂移——先收编 commit 再部署"
fi
exit $drift
