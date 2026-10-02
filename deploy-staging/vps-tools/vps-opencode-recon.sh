#!/usr/bin/env bash
# vps-opencode-recon.sh — VPS 生產 .opencode 手維護子集 與 本地 git HEAD 對賬
# 用法：bash deploy-staging/vps-tools/vps-opencode-recon.sh
#   0 = 一致；1 = 有實質漂移（擋部署，先收編再動）；2 = 連線/工具故障
#
# 與 vps-gateway-recon.sh 的關係：同型，但對象是第二可變面 workspace/.opencode。
# 只對賬手維護子集（tools/lib/skills/plugin＋4 個設定檔）；vendored 的 node_modules/
# services 與執行時狀態 opencode.db/*.redteam-* 永不參與，否則對賬會被 898MB 噪音淹沒。
set -euo pipefail

SSH_KEY=/home/lenovo/.ssh/new.pem
SSH_CMD=(ssh -i "$SSH_KEY" -p 22443 -o ConnectTimeout=10 ubuntu@43.172.85.76)
VPS_DIR=/opt/agent-harness/workspace/.opencode
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

# 1. 只拉手維護子集
"${SSH_CMD[@]}" "sudo tar -C $VPS_DIR \
  --exclude='node_modules' --exclude='services' \
  --exclude='opencode.db' --exclude='opencode.db-*' \
  --exclude='*.redteam-*' --exclude='*.bak*' --exclude='__pycache__' \
  -cf - ${SCOPE[*]} ${CONFIGS[*]} 2>/dev/null" | tar -C "$TMP_DIR" -xf -
if [ ! -d "$TMP_DIR/tools" ]; then
  echo "RECON_FAIL: VPS 拉取失敗或為空（連線/權限問題）"; exit 2
fi

# 2. 以 git HEAD 為基準（不是工作區——未 commit 的改動本身就是要抓的漂移）
GIT_DIR=$(git -C "$LOCAL_DIR" rev-parse --show-toplevel)
WORKTREE=$(mktemp -d /tmp/vps-oc-recon-head.XXXXXX)
git -C "$GIT_DIR" worktree add --quiet --detach "$WORKTREE" HEAD
HEAD_DIR="$WORKTREE/deploy-staging/opencode-runtime"

list_of() {
  local root="$1"
  ( cd "$root"
    find "${SCOPE[@]}" -type f ! -path '*/__pycache__/*' 2>/dev/null
    for c in "${CONFIGS[@]}"; do [ -f "$c" ] && echo "$c"; done
  ) | sort
}
list_of "$HEAD_DIR" > "$TMP_DIR/head-files.txt"
list_of "$TMP_DIR"  > "$TMP_DIR/vps-files.txt"

drift=0
if [ -n "$(comm -23 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")" ]; then
  while read -r f; do echo "ONLY_LOCAL $f（VPS 缺，確認是否該部署）"; done < <(comm -23 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")
  drift=1
fi
if [ -n "$(comm -13 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")" ]; then
  while read -r f; do echo "ONLY_VPS $f（生產多出，release 會刪）"; done < <(comm -13 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")
  drift=1
fi
while read -r f; do
  [ -f "$TMP_DIR/$f" ] && [ -f "$HEAD_DIR/$f" ] || continue
  if ! cmp -s "$HEAD_DIR/$f" "$TMP_DIR/$f"; then
    echo "DIFF $f"; drift=1
  fi
done < "$TMP_DIR/head-files.txt"

if [ "$drift" -eq 0 ]; then
  echo "RECON_OK: .opencode 生產與 git HEAD 一致（$(wc -l < "$TMP_DIR/head-files.txt") 檔）"
else
  echo "RECON_DRIFT: .opencode 生產與 HEAD 有實質漂移——先收編 commit 再部署"
fi
exit $drift
