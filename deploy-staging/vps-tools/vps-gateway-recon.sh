#!/usr/bin/env bash
# vps-gateway-recon.sh — VPS 生产 gateway 与本地 git HEAD 对账（防「未 commit 部署＝生产分叉」）
# 用法：bash deploy-staging/vps-tools/vps-gateway-recon.sh
#   0 = 一致或仅注释差异；1 = 有实质漂移（挡部署，先收编再动）；2 = 连线/工具故障
# 铁律：部署 VPS 前必跑本脚本；输出 DIFF 的档案必须先 diff 收编进 git 才准 scp。
set -euo pipefail

# 连线可覆写（预设＝原 22443 直连，行为逐位不变）：22443 连续 2-3 次即被 ISP RST，
# 多次连线的发布流程改走 SSH-over-443 隧道（127.0.0.1:22222）更稳。
SSH_KEY="${VPS_SSH_KEY:-/home/user/.ssh/id_ed25519}"
SSH_PORT="${VPS_SSH_PORT:-22443}"
SSH_TARGET="${VPS_SSH_TARGET:-ubuntu@YOUR_SERVER_IP}"
SSH_CMD=(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET")
VPS_DIR=/opt/eimu-harness/gateway
LOCAL_DIR="$(cd "$(dirname "$0")/../gateway" && pwd)"
# 临时 worktree 落点可覆写：本机 /tmp 是 12G tmpfs 且常近满（mktemp/worktree 会失败），
# gateway-release.sh 的 recon 一律带 RECON_TMPDIR=/var/tmp；trap 保证两种落点都清干净。
RECON_TMPDIR="${RECON_TMPDIR:-/tmp}"
TMP_DIR=$(mktemp -d "$RECON_TMPDIR/vps-recon.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

# 1. 拉取 VPS 生产源码（排除备份/依赖/测试/执行时状态；root-owned 需 sudo tar）
#    --exclude='*.db*' 是必要的：sessions.db-wal 由服务持续写入，tar 读到一半变动会回
#    退出码 1，配合 set -o pipefail 会让整支 recon 直接死掉、连判决都印不出来。
"${SSH_CMD[@]}" "sudo tar -C $VPS_DIR --exclude='*.bak*' --exclude='*.test.ts' --exclude='node_modules' --exclude='index.r?.ts' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='memory-batches' --exclude='memory-cursor.json' -cf - ." | tar -C "$TMP_DIR" -xf -
if ! ls "$TMP_DIR"/*.ts >/dev/null 2>&1; then
  echo "RECON_FAIL: VPS 拉取失败或为空（连线/权限问题）"; exit 2
fi

# 2. 基准＝RECON_BASE（预设 HEAD）。发布流程应传「上次已发布的 commit」：
#    比对「生产 vs HEAD」会在正常要发布新 commit 时一律误判为漂移，进而逼人 --skip-recon 绕过闸门。
#    正确语义是「生产是否仍等于我们上次发出去的那一版」——相等＝没有手改生产，可以安全发布新工作。
GIT_DIR=$(git -C "$LOCAL_DIR" rev-parse --show-toplevel)
WORKTREE=$(mktemp -d "$RECON_TMPDIR/vps-recon-head.XXXXXX")
trap 'rm -rf "$TMP_DIR" "$WORKTREE"' EXIT
BASE="${RECON_BASE:-HEAD}"
git -C "$GIT_DIR" worktree add --quiet --detach "$WORKTREE" "$BASE" || { echo "RECON_FAIL: 无法解析基准 $BASE"; exit 2; }

drift=0
# 3. 相对路径全量比对（含子目录——0920 教训：workflow-templates/ 拆分目录曾被顶层比对漏掉）
cd "$WORKTREE/deploy-staging/gateway" || exit 2
find . -name '*.ts' ! -name '*.test.ts' ! -path './node_modules/*' ! -name '*.bak*' ! -name 'index.r?.ts' ! -name 'refactor-audit.ts' | sort > "$TMP_DIR/head-files.txt"
cd "$TMP_DIR" || exit 2
find . -name '*.ts' ! -name '*.test.ts' ! -path './node_modules/*' ! -name '*.bak*' ! -name 'index.r?.ts' ! -name 'refactor-audit.ts' | sort > "$TMP_DIR/vps-files.txt"
strip() { sed '/^[[:space:]]*\/\//d; /^[[:space:]]*$/d' "$1"; }
while read -r f; do echo "ONLY_LOCAL ${f#./}（VPS 缺，确认是否该部署）"; done < <(comm -23 "$TMP_DIR/head-files.txt" "$TMP_DIR/vps-files.txt")
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
  echo "RECON_OK: VPS 生产与基准 $BASE 一致（$(ls "$TMP_DIR"/*.ts | wc -l) 档）"
else
  echo "RECON_DRIFT: 生产与基准 $BASE 有实质漂移——先 diff 收编 commit 再部署"
fi
exit $drift
