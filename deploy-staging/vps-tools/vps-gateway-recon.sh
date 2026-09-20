#!/usr/bin/env bash
# vps-gateway-recon.sh — VPS 生產 gateway 與本地 git HEAD 對賬（防「未 commit 部署＝生產分叉」）
# 用法：bash deploy-staging/vps-tools/vps-gateway-recon.sh
#   0 = 一致或僅註釋差異；1 = 有實質漂移（擋部署，先收编再動）；2 = 連線/工具故障
# 鐵律：部署 VPS 前必跑本腳本；輸出 DIFF 的檔案必須先 diff 收编進 git 才准 scp。
set -euo pipefail

SSH_KEY=/home/lenovo/.ssh/new.pem
SSH_CMD=(ssh -i "$SSH_KEY" -p 22443 -o ConnectTimeout=10 ubuntu@43.172.85.76)
VPS_DIR=/opt/agent-harness/gateway
LOCAL_DIR="$(cd "$(dirname "$0")/../gateway" && pwd)"
TMP_DIR=$(mktemp -d /tmp/vps-recon.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

# 1. 拉取 VPS 生產源碼（排除備份/依賴/測試；root-owned 需 sudo tar）
"${SSH_CMD[@]}" "sudo tar -C $VPS_DIR --exclude='*.bak*' --exclude='*.test.ts' --exclude='node_modules' --exclude='index.r?.ts' -cf - ." | tar -C "$TMP_DIR" -xf -
if ! ls "$TMP_DIR"/*.ts >/dev/null 2>&1; then
  echo "RECON_FAIL: VPS 拉取失敗或為空（連線/權限問題）"; exit 2
fi

# 2. 以 git HEAD 為基準（不是工作區——工作區未 commit 的改動本身就是要抓的漂移）
GIT_DIR=$(git -C "$LOCAL_DIR" rev-parse --show-toplevel)
WORKTREE=$(mktemp -d /tmp/vps-recon-head.XXXXXX)
trap 'rm -rf "$TMP_DIR" "$WORKTREE"' EXIT
git -C "$GIT_DIR" worktree add --quiet --detach "$WORKTREE" HEAD

drift=0
# 3. 逐檔比對（略過僅註釋/空白差異的等價檔）
for f in "$TMP_DIR"/*.ts; do
  b=$(basename "$f")
  head_f="$WORKTREE/deploy-staging/gateway/$b"
  if [ ! -f "$head_f" ]; then
    echo "ONLY_VPS $b"; drift=1; continue
  fi
  if ! diff -q <(sed '/^[[:space:]]*\/\//d; /^[[:space:]]*$/d' "$head_f") \
                <(sed '/^[[:space:]]*\/\//d; /^[[:space:]]*$/d' "$f") >/dev/null; then
    echo "DIFF $b"; drift=1
  fi
done
for f in "$WORKTREE/deploy-staging/gateway"/*.ts; do
  b=$(basename "$f")
  case "$b" in *.test.ts|refactor-audit.ts) continue;; esac  # 本地測試/審計工具，不部署
  [ -f "$TMP_DIR/$b" ] || echo "ONLY_LOCAL $b（VPS 缺，確認是否該部署）"
done

git -C "$GIT_DIR" worktree remove --force "$WORKTREE" 2>/dev/null || true

if [ "$drift" -eq 0 ]; then
  echo "RECON_OK: VPS 生產與 git HEAD 一致（$(ls "$TMP_DIR"/*.ts | wc -l) 檔）"
else
  echo "RECON_DRIFT: 生產與 HEAD 有實質漂移——先 diff 收编 commit 再部署"
fi
exit $drift
