#!/usr/bin/env bash
# gateway-release.sh — VPS agent-gateway 版本化發佈 / 回滾
#   release dir（commit SHA＋時間戳）＋ md5 清單 manifest ＋ 原子 symlink 切換 ＋ rollback 回上一版
#
# 用法：
#   bash deploy/vps/gateway-release.sh status            # 看生產現在跑哪一版（唯讀）
#   bash deploy/vps/gateway-release.sh release [--sha <commit>] [--files <路徑>...] [--skip-recon] [--dry-run]
#   bash deploy/vps/gateway-release.sh rollback [--dry-run]
#   bash deploy/vps/gateway-release.sh adopt [--dry-run]  # 一次性：把實體目錄改成受管 symlink
#
# 為什麼存在：過去「生產跑的是哪一版」只能事後取證（Vercel files API 比 md5、逐 chunk grep），
#   而 alias 曾 34 小時未更新、跑的是舊部署（memory mapay-fee-rejection-fix-0920），
#   「HEAD 已修」≠「生產在跑」是常態風險（memory uncommitted-deploy-production-fork-0920）。
#   本腳本讓每次閘道部署留下不可變的 release 目錄，於是
#   「哪一版在跑」= `readlink -f /opt/agent-harness/gateway`，回滾 = 切 symlink 回上一版。
#
# 設計約束（來自現場，非發明）：
#   1. 只上已 commit 的檔：release 內容由 `git archive <sha> deploy-staging/gateway` 產生。
#      工作區未 commit 的改動永遠進不了 release → 正面解掉「未 commit 部署＝生產分叉」。
#   2. 不做整目錄盲同步：上傳的是「某個 commit 的快照」，不是當前工作區，
#      因此不會把並行路線的未完成工作推上生產（memory 閘道部署配方的核心教訓）。
#   3. 順帶結構性消除一個靜默雷：release 目錄 = 該 commit 的完整檔案集，不會有舊檔殘留
#      掩蔽新目錄（extensionless `workflow-templates.ts` 掩蔽 `workflow-templates/`，
#      見 memory template-monolith-split-0920）。
#   4. 權限：gateway/ 為 ubuntu:ubuntu，但其下 workflow-templates/ 為 root:root
#      → 遠端一律經 /tmp 中轉 + `sudo install -o ubuntu -g ubuntu -m 644 -D` 逐檔落地，
#      不直接 scp 進目標目錄。
#   5. 服務閘門重用既有輪子：`sudo /opt/agent-harness/deploy.sh`
#      （flock 排他鎖 + bun build 語法閘 + restart + healthz）。本腳本不重寫它。
#   6. 部署前必跑既有 recon：deploy-staging/vps-tools/vps-gateway-recon.sh
#      （memory arch-debt-closeout-0920 鐵律）。本腳本不重寫它，只調用它。
#
# ⚠️ 未驗證假設（本腳本只在本機做過 `bash -n` 與 `--dry-run`，從未對生產執行）：
#   A. /opt/agent-harness/gateway 推測是「實體目錄」而非 symlink
#      → 首次使用需人工確認後跑 `adopt`（把現況封存成 baseline release 再換成 symlink）。
#   B. deploy.sh 是否以硬編路徑 /opt/agent-harness/gateway 為工作根。若它 cd 進該路徑或
#      bun build 該路徑下的 index.ts，symlink 不影響它；若它自行做目錄歸屬/比對檢查則需先讀它。
#   C. systemd unit（agent-gateway）的 WorkingDirectory / ExecStart 是否走同一路徑。
#   D. `mv -T` 需與目標同檔案系統；releases 與 gateway 同在 /opt/agent-harness 下，理應成立。
#   E. 遠端有 GNU coreutils（md5sum / mv -T / ln -sfn / install -D）與 curl。
#   F. /opt/agent-harness/deploy.sh 需 sudo，且會撞到 /tmp/deploy-gate-*.js 殘檔 EACCES
#      （memory arch-debt-closeout-0920 的雷）；本腳本不代清，失敗時人工依該記憶處理。
#   G. `adopt` 的 mv→ln 之間有一個短暫視窗（該路徑不存在）。未對生產驗證。
set -euo pipefail

# ── 可覆寫參數（env 前綴 GW_）────────────────────────────────────────────
SSH_KEY="${GW_SSH_KEY:-$HOME/.ssh/new.pem}"
SSH_TARGET="${GW_SSH_TARGET:-ubuntu@43.172.85.76}"
SSH_PORT="${GW_SSH_PORT:-22443}"
HARNESS_ROOT="${GW_HARNESS_ROOT:-/opt/agent-harness}"
GATEWAY_PATH="${GW_GATEWAY_PATH:-$HARNESS_ROOT/gateway}"
RELEASES_DIR="${GW_RELEASES_DIR:-$HARNESS_ROOT/releases/gateway}"
DEPLOY_GATE="${GW_DEPLOY_GATE:-sudo $HARNESS_ROOT/deploy.sh}"
HEALTH_URL="${GW_HEALTH_URL:-http://127.0.0.1:8081/healthz}"
OWNER="${GW_OWNER:-ubuntu:ubuntu}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_SUBDIR="deploy-staging/gateway"
RECON_SCRIPT="$REPO_ROOT/deploy-staging/vps-tools/vps-gateway-recon.sh"

DRY_RUN=0
SKIP_RECON=0
SHA=""
EXPLICIT_FILES=()

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# 遠端腳本一律用「引號 heredoc + 位置參數」傳值（不用無引號 heredoc 內插，
# 因為遠端變數與本地變數同名時會靜默取到本地值）。順序固定如下：
#   $1 HARNESS_ROOT  $2 GATEWAY_PATH  $3 RELEASES_DIR  $4 OWNER  $5 HEALTH_URL  $6... 各命令附加
remote_args() { printf '%s\n' "$HARNESS_ROOT" "$GATEWAY_PATH" "$RELEASES_DIR" "$OWNER" "$HEALTH_URL"; }

run_remote() {
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN ssh: $*"; return 0; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

# 帶 stdin 的遠端執行。--dry-run 時把遠端腳本原樣印出（可另存後 bash -n 檢查），不連線。
run_remote_stdin() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN ssh(stdin): $*"
    local tmp
    tmp="$(mktemp -t gw-dry-remote.XXXXXX)"
    cat > "$tmp"
    if [ -n "${GW_DRY_REMOTE_LOG:-}" ]; then cat "$tmp" >> "$GW_DRY_REMOTE_LOG"; fi
    log "-----8<----- remote script begin -----8<-----"
    sed 's/^/  | /' "$tmp" >&2
    log "----->8----- remote script end ------>8-----"
    rm -f "$tmp"
    return 0
  fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

# 二進位 tar 上傳。--dry-run 只吞掉 stdin 並報位元組數（不把 tar 二進位印到終端）。
run_remote_binary() {
  if [ "$DRY_RUN" -eq 1 ]; then
    local n
    n="$(wc -c)"
    log "DRY-RUN ssh(binary): $* (stdin $n bytes)"
    return 0
  fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

子命令：
  status                  唯讀：印出生產目前指向的 release、meta、manifest 校驗結果、healthz
  release [--sha C] [--files F...] [--skip-recon] [--dry-run]
                          發佈：git archive 該 commit 的 deploy-staging/gateway → release 目錄
                          → md5 manifest → 原子切 symlink → deploy.sh 閘門 → 驗證
  rollback [--dry-run]    回滾：切 symlink 回上一個 release → 同一道 deploy.sh 閘門 → 驗證
  adopt [--dry-run]       一次性：把實體 /opt/agent-harness/gateway 封存成 baseline release
                          並換成受管 symlink（此後 release/rollback 才可用）

環境可覆寫：GW_SSH_KEY GW_SSH_TARGET GW_SSH_PORT GW_HARNESS_ROOT GW_GATEWAY_PATH
            GW_RELEASES_DIR GW_DEPLOY_GATE GW_HEALTH_URL GW_OWNER
            GW_DRY_REMOTE_LOG（--dry-run 時把遠端腳本另存到該檔，供 bash -n 檢查）
EOF
}

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --skip-recon) SKIP_RECON=1 ;;
      --sha) shift; SHA="${1:-}"; [ -n "$SHA" ] || die "--sha 需要值" ;;
      --files)
        shift
        while [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; do EXPLICIT_FILES+=("$1"); shift; done
        continue ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知參數：$1" ;;
    esac
    shift
  done
}

preflight_local() {
  [ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$REPO_ROOT 不是 git repo"
}

# 根因守門：deploy-staging/gateway 有未 commit 改動時禁止發佈。
# 這正是「未 commit 部署＝生產分叉」的入口（memory uncommitted-deploy-production-fork-0920）。
assert_gateway_tree_clean() {
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain -- "$SRC_SUBDIR")"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" >&2
    die "$SRC_SUBDIR 有未 commit 改動 → 拒絕發佈（未 commit 部署＝生產分叉的根因）。先 commit。"
  fi
}

# 既有輪子：部署前 recon 對賬（0=一致 1=漂移 2=故障）
run_recon() {
  [ "$SKIP_RECON" -eq 1 ] && { log "SKIP recon（--skip-recon）"; return 0; }
  [ -f "$RECON_SCRIPT" ] || die "找不到 recon 腳本：$RECON_SCRIPT"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN local: bash $RECON_SCRIPT"; return 0; fi
  log "== 既有 recon 對賬（擋漂移）=="
  if ! bash "$RECON_SCRIPT"; then
    die "recon 未通過（漂移或連線故障）→ 先 diff 收編再發佈（deploy-staging/vps-tools/vps-gateway-recon.sh）"
  fi
}

# ── status ──────────────────────────────────────────────────────────────
cmd_status() {
  preflight_local
  local -a RA
  mapfile -t RA < <(remote_args)
  run_remote_stdin bash -s -- "${RA[@]}" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"
echo "gateway_path=$GATEWAY_PATH"
if [ -L "$GATEWAY_PATH" ]; then
  echo "mode=symlink"
  echo "current=$(readlink -f "$GATEWAY_PATH")"
else
  echo "mode=plain-dir（尚未 adopt，release/rollback 不可用）"
fi
echo "releases_dir=$RELEASES_DIR"
if [ -d "$RELEASES_DIR" ]; then
  for r in $(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::'); do
    if [ -f "$r/meta.env" ]; then
      printf 'release %s ' "$(basename "$r")"; tr '\n' ' ' < "$r/meta.env"; echo
    else
      echo "release $(basename "$r") (no meta.env)"
    fi
  done
  cur="$(readlink -f "$GATEWAY_PATH" 2>/dev/null || true)"
  if [ -n "$cur" ] && [ -f "$cur/../manifest.md5" ]; then
    if (cd "$cur" && md5sum -c ../manifest.md5 --quiet); then echo "manifest_verify=OK"; else echo "manifest_verify=FAIL"; fi
  fi
  if [ -f "$RELEASES_DIR/history.log" ]; then echo "--- history.log (tail 5) ---"; tail -5 "$RELEASES_DIR/history.log"; fi
else
  echo "releases_dir 不存在"
fi
if command -v curl >/dev/null 2>&1; then
  echo "healthz=$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo ERR)"
fi
REMOTE
}

# ── adopt（一次性）──────────────────────────────────────────────────────
cmd_adopt() {
  preflight_local
  local ts rel
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  rel="baseline-$ts"
  log "== adopt：$GATEWAY_PATH（實體目錄）→ symlink → $RELEASES_DIR/$rel/files =="
  log "⚠️ 一次性、對生產有實質影響的操作；本腳本從未對生產驗證過，請人工確認後再跑。"
  local -a RA
  mapfile -t RA < <(remote_args)
  run_remote_stdin bash -s -- "${RA[@]}" "$rel" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"; rel="$6"
if [ -L "$GATEWAY_PATH" ]; then echo "ALREADY_ADOPTED"; exit 0; fi
[ -d "$GATEWAY_PATH" ] || { echo "NO_GATEWAY_DIR: $GATEWAY_PATH"; exit 1; }
sudo mkdir -p "$RELEASES_DIR/$rel"
sudo mv "$GATEWAY_PATH" "$RELEASES_DIR/$rel/files"
sudo ln -s "$RELEASES_DIR/$rel/files" "$GATEWAY_PATH"
sudo chown -h "$OWNER" "$GATEWAY_PATH" 2>/dev/null || true
sudo chown -R "$OWNER" "$RELEASES_DIR/$rel" 2>/dev/null || true
cd "$RELEASES_DIR/$rel/files"
find . -type f -print0 | sort -z | xargs -0 md5sum > "../manifest.md5"
{
  echo "RELEASE_ID=$rel"
  echo "GIT_SHA=unknown-baseline"
  echo "CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "FILE_COUNT=$(wc -l < ../manifest.md5)"
  echo "NOTE=adopted-baseline（非 commit 快照；內容為 adopt 當下的生產目錄，可能含漂移）"
} > "../meta.env"
echo "$rel unknown-baseline $(date -u +%s) adopt" | sudo tee -a "$RELEASES_DIR/history.log" >/dev/null
echo "ADOPTED current=$(readlink -f "$GATEWAY_PATH")"
REMOTE
  if [ "$DRY_RUN" -eq 0 ]; then
    log "== adopt 後跑既有服務閘門（確認 symlink 路徑仍可服務）=="
    run_remote "$DEPLOY_GATE"
    verify_release "$RELEASES_DIR/$rel/files"
  fi
}

# ── release ─────────────────────────────────────────────────────────────
cmd_release() {
  preflight_local
  assert_gateway_tree_clean

  local sha_full sha_short ts rel
  sha_full="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA:-HEAD}^{commit}")" \
    || die "無法解析 commit：${SHA:-HEAD}"
  sha_short="$(git -C "$REPO_ROOT" rev-parse --short=12 "$sha_full")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  rel="$sha_short-$ts"

  if [ "${#EXPLICIT_FILES[@]}" -gt 0 ]; then
    for f in "${EXPLICIT_FILES[@]}"; do
      case "$f" in "$SRC_SUBDIR"/*) ;; *) die "--files 必須是 $SRC_SUBDIR/ 下的路徑：$f" ;; esac
      git -C "$REPO_ROOT" cat-file -e "$sha_full:$f" 2>/dev/null || die "該 commit 不含此檔：$f"
    done
    log "== 精準發佈（--files，${#EXPLICIT_FILES[@]} 檔）：$sha_short → $rel =="
  else
    log "== 完整快照發佈：$SRC_SUBDIR @ $sha_short → $rel =="
    log "   （git archive 該 commit 的完整檔案集：不含工作區未 commit 改動，也不會有舊檔殘留）"
  fi

  run_recon

  local stage_tar="/tmp/gw-release-$rel.tar"
  local stage_dir="/tmp/gw-release-$rel"

  if [ "${#EXPLICIT_FILES[@]}" -gt 0 ]; then
    local tmp_tar
    tmp_tar="$(mktemp -t gw-partial.XXXXXX.tar)"
    tar -C "$REPO_ROOT" -cf "$tmp_tar" "${EXPLICIT_FILES[@]}"
    run_remote_binary "cat > $stage_tar" < "$tmp_tar"
    rm -f "$tmp_tar"
  else
    git -C "$REPO_ROOT" archive --format=tar "$sha_full" "$SRC_SUBDIR" \
      | run_remote_binary "cat > $stage_tar"
  fi

  local -a RA
  mapfile -t RA < <(remote_args)
  run_remote_stdin bash -s -- "${RA[@]}" "$rel" "$sha_full" "$sha_short" "$stage_tar" "$stage_dir" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"
rel="$6"; sha_full="$7"; sha_short="$8"; stage_tar="$9"; stage_dir="${10}"

if [ ! -L "$GATEWAY_PATH" ]; then
  echo "NOT_ADOPTED: $GATEWAY_PATH 不是 symlink → 先跑 adopt（見腳本頭部假設 A）"
  exit 1
fi

REL_DIR="$RELEASES_DIR/$rel"
sudo mkdir -p "$REL_DIR/files" "$stage_dir"
# --strip-components=2：tar 內路徑為 deploy-staging/gateway/<檔>，剝掉兩層後 files/ 即 gateway 根
sudo tar -xf "$stage_tar" -C "$stage_dir" --strip-components=2
sudo chown -R "$OWNER" "$stage_dir"

# 逐檔 sudo install（-D 建父目錄），owner/mode 與既有檔一致：-rw-r--r-- ubuntu ubuntu
cd "$stage_dir"
while IFS= read -r -d '' f; do
  sudo install -D -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$f" "$REL_DIR/files/$f"
done < <(find . -type f -print0)
cd /
rm -rf "$stage_dir" "$stage_tar"

cd "$REL_DIR/files"
find . -type f -print0 | sort -z | xargs -0 md5sum > "$REL_DIR/manifest.md5"
FILE_COUNT="$(wc -l < "$REL_DIR/manifest.md5")"
MANIFEST_MD5="$(md5sum "$REL_DIR/manifest.md5" | cut -d' ' -f1)"
{
  echo "RELEASE_ID=$rel"
  echo "GIT_SHA=$sha_full"
  echo "GIT_SHA_SHORT=$sha_short"
  echo "CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "FILE_COUNT=$FILE_COUNT"
  echo "MANIFEST_MD5=$MANIFEST_MD5"
  echo "SOURCE=git-archive"
} > "$REL_DIR/meta.env"

# 原子切換：先建 next symlink，再 mv -T 一次性 rename 覆蓋（同檔案系統）
sudo ln -sfn "$REL_DIR/files" "$HARNESS_ROOT/.gateway-link.next"
sudo mv -T "$HARNESS_ROOT/.gateway-link.next" "$GATEWAY_PATH"

echo "$rel $sha_full $(date -u +%s) release" | sudo tee -a "$RELEASES_DIR/history.log" >/dev/null
echo "SWITCHED current=$(readlink -f "$GATEWAY_PATH") files=$FILE_COUNT"
REMOTE

  if [ "$DRY_RUN" -eq 0 ]; then
    log "== 既有服務閘門：$DEPLOY_GATE =="
    run_remote "$DEPLOY_GATE"
    verify_release "$RELEASES_DIR/$rel/files"
  fi
  log "release 完成：$rel"
}

# ── rollback ────────────────────────────────────────────────────────────
cmd_rollback() {
  preflight_local
  log "== rollback：切回上一個 release =="
  local -a RA
  mapfile -t RA < <(remote_args)

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN：略過「解析上一個 release」（需連線讀 releases 目錄）"
    run_remote_stdin bash -s -- "${RA[@]}" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"
if [ ! -L "$GATEWAY_PATH" ]; then echo "NOT_ADOPTED"; exit 1; fi
CUR="$(basename "$(dirname "$(readlink -f "$GATEWAY_PATH")")")"
mapfile -t RELS < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::' | xargs -n1 basename)
idx=-1
for i in "${!RELS[@]}"; do [ "${RELS[$i]}" = "$CUR" ] && { idx=$i; break; }; done
[ "$idx" -ge 0 ] || { echo "CURRENT_NOT_IN_RELEASES:$CUR" >&2; exit 1; }
next=$((idx+1))
[ "$next" -lt "${#RELS[@]}" ] || { echo "NO_PREVIOUS_RELEASE (current=$CUR)" >&2; exit 1; }
echo "PREV=${RELS[$next]}"
PREV_DIR="$RELEASES_DIR/${RELS[$next]}/files"
[ -d "$PREV_DIR" ] || { echo "MISSING_PREV_DIR"; exit 1; }
( cd "$PREV_DIR" && md5sum -c "$RELEASES_DIR/${RELS[$next]}/manifest.md5" --quiet ) || { echo "PREV_MANIFEST_FAIL"; exit 1; }
sudo ln -sfn "$PREV_DIR" "$HARNESS_ROOT/.gateway-link.next"
sudo mv -T "$HARNESS_ROOT/.gateway-link.next" "$GATEWAY_PATH"
echo "${RELS[$next]} rollback $(date -u +%s) rollback" | sudo tee -a "$RELEASES_DIR/history.log" >/dev/null
echo "ROLLED_BACK current=$(readlink -f "$GATEWAY_PATH")"
REMOTE
    log "rollback dry-run 結束（未連線、未切換）"
    return 0
  fi

  local prev
  prev="$(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" bash -s -- "${RA[@]}" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"
[ -L "$GATEWAY_PATH" ] || { echo "NOT_ADOPTED" >&2; exit 1; }
CUR="$(basename "$(dirname "$(readlink -f "$GATEWAY_PATH")")")"
mapfile -t RELS < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::' | xargs -n1 basename)
idx=-1
for i in "${!RELS[@]}"; do [ "${RELS[$i]}" = "$CUR" ] && { idx=$i; break; }; done
[ "$idx" -ge 0 ] || { echo "CURRENT_NOT_IN_RELEASES:$CUR" >&2; exit 1; }
next=$((idx+1))
[ "$next" -lt "${#RELS[@]}" ] || { echo "NO_PREVIOUS_RELEASE (current=$CUR)" >&2; exit 1; }
echo "${RELS[$next]}"
REMOTE
)"
  [ -n "$prev" ] || die "取不到上一個 release（rollback 目標為空）"
  log "rollback 目標：$prev"

  run_remote_stdin bash -s -- "${RA[@]}" "$prev" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"; prev="$6"
PREV_DIR="$RELEASES_DIR/$prev/files"
[ -d "$PREV_DIR" ] || { echo "MISSING_PREV_DIR: $PREV_DIR"; exit 1; }
[ -f "$RELEASES_DIR/$prev/manifest.md5" ] || { echo "MISSING_PREV_MANIFEST"; exit 1; }
( cd "$PREV_DIR" && md5sum -c "$RELEASES_DIR/$prev/manifest.md5" --quiet ) || { echo "PREV_MANIFEST_FAIL"; exit 1; }
sudo ln -sfn "$PREV_DIR" "$HARNESS_ROOT/.gateway-link.next"
sudo mv -T "$HARNESS_ROOT/.gateway-link.next" "$GATEWAY_PATH"
echo "$prev rollback $(date -u +%s) rollback" | sudo tee -a "$RELEASES_DIR/history.log" >/dev/null
echo "ROLLED_BACK current=$(readlink -f "$GATEWAY_PATH")"
REMOTE

  log "== 既有服務閘門：$DEPLOY_GATE =="
  run_remote "$DEPLOY_GATE"
  verify_release "$RELEASES_DIR/$prev/files"
  log "rollback 完成：$prev"
}

# ── 收尾驗證（symlink 指向 + manifest + healthz）─────────────────────────
verify_release() {
  local expected="$1"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN verify $expected"; return 0; fi
  run_remote_stdin bash -s -- "$GATEWAY_PATH" "$HEALTH_URL" "$expected" <<'REMOTE'
set -euo pipefail
GATEWAY_PATH="$1"; HEALTH_URL="$2"; EXPECTED="$3"
CUR="$(readlink -f "$GATEWAY_PATH")"
[ "$CUR" = "$EXPECTED" ] || { echo "SWITCH_MISMATCH cur=$CUR expect=$EXPECTED"; exit 1; }
( cd "$EXPECTED" && md5sum -c "$EXPECTED/../manifest.md5" --quiet ) || { echo "MANIFEST_FAIL"; exit 1; }
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo ERR)"
[ "$CODE" = "200" ] || { echo "HEALTHZ=$CODE"; exit 1; }
echo "VERIFY_OK current=$CUR manifest=OK healthz=200"
REMOTE
  log "⚠️ VERIFY_OK 只證明「切到預期的 release 且服務起來了」，不證明功能可用（要打真端點）。"
}

main() {
  local cmd="${1:-}"
  [ -n "$cmd" ] || { usage; exit 2; }
  shift || true
  case "$cmd" in
    status) parse_flags "$@"; cmd_status ;;
    release) parse_flags "$@"; cmd_release ;;
    rollback) parse_flags "$@"; cmd_rollback ;;
    adopt) parse_flags "$@"; cmd_adopt ;;
    -h|--help|help) usage ;;
    *) usage; die "未知子命令：$cmd" ;;
  esac
}

main "$@"
