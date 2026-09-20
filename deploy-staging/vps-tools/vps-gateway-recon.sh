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
# 3. 相對路徑全量比對（含子目錄——0920 教訓：workflow-templates/ 拆分目錄曾被頂層比對漏掉）
cd "$WORKTREE/deploy-staging/gateway" || exit 2
find . -name '*.ts' ! -name '*.test.ts' ! -path './node_modules/*' ! -name '*.bak*' ! -name 'index.r?.ts' ! -name 'refactor-audit.ts' | sort > "$TMP_DIR/head-files.txt"
cd "$TMP_DIR" || exit 2
find . -name '*.ts' ! -name '*.test.ts' ! -path './node_modules/*' ! -name '*.bak*' ! -name 'index.r?.ts' | sort > "$TMP_DIR/vps-files.txt"
strip() { sed '/^[[:space:]]*\/\//d; /^[[:space:]]*$/d' "$1"; }
while read -r f; do echo "ONLY_LOCAL ${f#./}（VPS 缺，確認是否該部署）"; done < <(comm -23 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")
comm -13 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt" | while read -r f; do echo "ONLY_VPS ${f#./}"; done
if [ -n "$(comm -13 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")" ]; then drift=1; fi
while read -r f; do
  [ -f "$TMP_DIR/$f" ] || continue
  if ! diff -q <(strip "$WORKTREE/deploy-staging/gateway/$f") <(strip "$TMP_DIR/$f") >/dev/null; then
    echo "DIFF ${f#./}"; drift=1
  fi
done < "$TMP_DIR/head-files.txt"

git -C "$GIT_DIR" worktree remove --force "$WORKTREE" 2>/dev/null || true

if [ "$drift" -eq 0 ]; then
  echo "RECON_OK: VPS 生產與 git HEAD 一致（$(ls "$TMP_DIR"/*.ts | wc -l) 檔）"
else
  echo "RECON_DRIFT: 生產與 HEAD 有實質漂移——先 diff 收编 commit 再部署"
fi
exit $drift
