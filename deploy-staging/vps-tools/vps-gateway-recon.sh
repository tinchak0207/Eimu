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
# 臨時 worktree 落點可覆寫：本機 /tmp 是 12G tmpfs 且常近滿（mktemp/worktree 會失敗），
# gateway-release.sh 的 recon 一律帶 RECON_TMPDIR=/var/tmp；trap 保證兩種落點都清乾淨。
RECON_TMPDIR="${RECON_TMPDIR:-/tmp}"
TMP_DIR=$(mktemp -d "$RECON_TMPDIR/vps-recon.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

# 1. 拉取 VPS 生產源碼（排除備份/依賴/測試/執行時狀態；root-owned 需 sudo tar）
#    --exclude='*.db*' 是必要的：sessions.db-wal 由服務持續寫入，tar 讀到一半變動會回
#    退出碼 1，配合 set -o pipefail 會讓整支 recon 直接死掉、連判決都印不出來。
"${SSH_CMD[@]}" "sudo tar -C $VPS_DIR --exclude='*.bak*' --exclude='*.test.ts' --exclude='node_modules' --exclude='index.r?.ts' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='memory-batches' --exclude='memory-cursor.json' -cf - ." | tar -C "$TMP_DIR" -xf -
if ! ls "$TMP_DIR"/*.ts >/dev/null 2>&1; then
  echo "RECON_FAIL: VPS 拉取失敗或為空（連線/權限問題）"; exit 2
fi

# 2. 基準＝RECON_BASE（預設 HEAD）。發佈流程應傳「上次已發佈的 commit」：
#    比對「生產 vs HEAD」會在正常要發佈新 commit 時一律誤判為漂移，進而逼人 --skip-recon 繞過閘門。
#    正確語義是「生產是否仍等於我們上次發出去的那一版」——相等＝沒有手改生產，可以安全發佈新工作。
GIT_DIR=$(git -C "$LOCAL_DIR" rev-parse --show-toplevel)
WORKTREE=$(mktemp -d "$RECON_TMPDIR/vps-recon-head.XXXXXX")
trap 'rm -rf "$TMP_DIR" "$WORKTREE"' EXIT
BASE="${RECON_BASE:-HEAD}"
git -C "$GIT_DIR" worktree add --quiet --detach "$WORKTREE" "$BASE" || { echo "RECON_FAIL: 無法解析基準 $BASE"; exit 2; }

drift=0
# 3. 相對路徑全量比對（含子目錄——0920 教訓：workflow-templates/ 拆分目錄曾被頂層比對漏掉）
cd "$WORKTREE/deploy-staging/gateway" || exit 2
find . -name '*.ts' ! -name '*.test.ts' ! -path './node_modules/*' ! -name '*.bak*' ! -name 'index.r?.ts' ! -name 'refactor-audit.ts' | sort > "$TMP_DIR/head-files.txt"
cd "$TMP_DIR" || exit 2
find . -name '*.ts' ! -name '*.test.ts' ! -path './node_modules/*' ! -name '*.bak*' ! -name 'index.r?.ts' ! -name 'refactor-audit.ts' | sort > "$TMP_DIR/vps-files.txt"
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
  echo "RECON_OK: VPS 生產與基準 $BASE 一致（$(ls "$TMP_DIR"/*.ts | wc -l) 檔）"
else
  echo "RECON_DRIFT: 生產與基準 $BASE 有實質漂移——先 diff 收編 commit 再部署"
fi
exit $drift
