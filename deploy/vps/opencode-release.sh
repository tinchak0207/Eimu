#!/usr/bin/env bash
# opencode-release.sh — 把 deploy-staging/opencode-runtime（git 真源）同步到
#   /opt/agent-harness/workspace/.opencode 並重啟 opencode-server
#
# 用法：
#   bash deploy/vps/opencode-release.sh status            # 唯讀：現況＋健康
#   bash deploy/vps/opencode-release.sh plan [--sha C]    # 唯讀：列出將變更的檔
#   bash deploy/vps/opencode-release.sh release [--sha C] [--skip-recon] [--dry-run]
#   bash deploy/vps/opencode-release.sh rollback [--dry-run]   # 回復最新備份
#
# 為什麼不是 gateway-release.sh 那套 symlink 模型（刻意差異，非疏漏）：
#   .opencode 內含 vendored 的 services/(898M) 與 node_modules/(93M) 及執行時 opencode.db，
#   「整包換目錄＋切 symlink」會把它們一起抹掉。故本腳本改用「白名單同步」：只同步
#   tools/lib/skills/plugin ＋ 4 個設定檔，vendored 與執行時狀態永不進入同步範圍。
#   刪除語義靠「檔案清單比對」補齊（本機無 rsync，且不為此裝系統套件）。
# 不變量（與 gateway 同）：只發佈已 commit 的快照；發佈前強制 recon 漂移閘；發佈前備份；
#   落地後必須看服務真的起來才算數。
set -euo pipefail

SSH_KEY="${OC_SSH_KEY:-$HOME/.ssh/new.pem}"
SSH_TARGET="${OC_SSH_TARGET:-ubuntu@43.172.85.76}"
SSH_PORT="${OC_SSH_PORT:-22443}"
VPS_DIR="${OC_VPS_DIR:-/opt/agent-harness/workspace/.opencode}"
BACKUP_DIR="${OC_BACKUP_DIR:-/opt/agent-harness/backups}"
HISTORY_LOG="${OC_HISTORY_LOG:-/opt/agent-harness/releases/opencode-history.log}"
SERVICE="${OC_SERVICE:-opencode-server}"
HEALTH_URL="${OC_HEALTH_URL:-http://127.0.0.1:4096/doc}"
OWNER="${OC_OWNER:-ubuntu:ubuntu}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_SUBDIR="deploy-staging/opencode-runtime"
RECON_SCRIPT="$REPO_ROOT/deploy-staging/vps-tools/vps-opencode-recon.sh"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)

DRY_RUN=0
SKIP_RECON=0
SHA=""

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

remote() {
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN ssh: $*"; return 0; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}
remote_stdin() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN ssh(stdin): $*"
    local t; t="$(mktemp -t oc-dry.XXXXXX)"; cat > "$t"; sed 's/^/  | /' "$t" >&2; rm -f "$t"; return 0
  fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}
remote_binary() {
  if [ "$DRY_RUN" -eq 1 ]; then local n; n="$(wc -c)"; log "DRY-RUN ssh(binary): $* (stdin $n bytes)"; return 0; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --skip-recon) SKIP_RECON=1 ;;
      --sha) shift; SHA="${1:-}"; [ -n "$SHA" ] || die "--sha 需要值" ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知參數：$1" ;;
    esac
    shift
  done
}

preflight_local() {
  [ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT 不是 git repo"
}

# 根因守門：真源子樹有未 commit 改動時禁止發佈（未 commit 部署＝生產分叉的入口）
assert_tree_clean() {
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain -- "$SRC_SUBDIR")"
  [ -z "$dirty" ] || { printf '%s\n' "$dirty" >&2; die "$SRC_SUBDIR 有未 commit 改動 → 拒絕發佈。先 commit。"; }
}

# 上次發佈的 sha（recon 的正確基準：生產是否仍等於上次發出的那一版）
last_release_sha() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" \
    "sudo tail -1 '$HISTORY_LOG' 2>/dev/null | awk '{print \$2}'" 2>/dev/null | head -1
}

run_recon() {
  [ "$SKIP_RECON" -eq 1 ] && { log "SKIP recon（--skip-recon）"; return 0; }
  [ -f "$RECON_SCRIPT" ] || die "找不到 recon 腳本：$RECON_SCRIPT"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN local: bash $RECON_SCRIPT"; return 0; fi
  local base
  base="$(last_release_sha)"
  [ -n "$base" ] || base="HEAD"
  log "== recon 對賬（擋漂移；基準 $base）=="
  RECON_BASE="$base" bash "$RECON_SCRIPT" || die "recon 未通過（生產被手改或故障）→ 先收編再發佈"
}

# 把 commit 的鏡像展開到 $1；印出預期檔案清單到 $2
stage_from_commit() {
  local stage="$1" exp="$2" sha="$3"
  git -C "$REPO_ROOT" archive --format=tar "$sha" "$SRC_SUBDIR" \
    | tar -x --strip-components=2 -C "$stage"
  ( cd "$stage"
    find "${SCOPE[@]}" -type f ! -path '*/__pycache__/*' 2>/dev/null
    for c in "${CONFIGS[@]}"; do [ -f "$c" ] && echo "$c"; done
  ) | sort > "$exp"
}

cmd_status() {
  preflight_local
  remote_stdin bash -s -- "$VPS_DIR" "$SERVICE" "$HEALTH_URL" "$BACKUP_DIR" "$HISTORY_LOG" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; SERVICE="$2"; HEALTH_URL="$3"; BACKUP_DIR="$4"; HISTORY_LOG="$5"
echo "vps_dir=$VPS_DIR"
echo "service=$([ "$(systemctl is-active "$SERVICE")" = active ] && echo active || echo "$(systemctl is-active "$SERVICE")")"
code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo ERR)"
echo "opencode_http=$code（200/401 皆代表服務在線並回應）"
echo "--- 手維護子集檔案數 ---"
sudo find "$VPS_DIR"/tools "$VPS_DIR"/lib "$VPS_DIR"/skills "$VPS_DIR"/plugin -type f 2>/dev/null | wc -l
echo "--- 備份（tail 5）---"
sudo ls -1t "$BACKUP_DIR"/opencode-*.tgz 2>/dev/null | head -5 || echo "(無)"
echo "--- history（tail 5）---"
sudo tail -5 "$HISTORY_LOG" 2>/dev/null || echo "(無)"
REMOTE
}

cmd_plan() {
  preflight_local
  local sha tmp
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA:-HEAD}^{commit}")" || die "無法解析 commit"
  tmp="$(mktemp -d /tmp/oc-plan.XXXXXX)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/stage"
  stage_from_commit "$tmp/stage" "$tmp/exp" "$sha"
  log "== plan @ $(git -C "$REPO_ROOT" rev-parse --short=12 "$sha")：commit 端 $(wc -l < "$tmp/exp") 檔 =="

  for c in "${CONFIGS[@]}"; do echo "$c"; done > "$tmp/conf.txt"
  remote "cd '$VPS_DIR' && { sudo find tools lib skills plugin -type f ! -path '*/__pycache__/*' 2>/dev/null; for c in opencode.json package.json bun.lock package-lock.json; do sudo test -f \"\$c\" && echo \"\$c\"; done; } | sort" > "$tmp/actual.txt"
  remote "cd '$VPS_DIR' && { sudo find tools lib skills plugin -type f ! -path '*/__pycache__/*' -exec md5sum {} + 2>/dev/null; for c in opencode.json package.json bun.lock package-lock.json; do sudo test -f \"\$c\" && sudo md5sum \"\$c\"; done; } | sort -k2" > "$tmp/actual.md5"
  ( cd "$tmp/stage"
    { find tools lib skills plugin -type f ! -path '*/__pycache__/*' 2>/dev/null
      for c in opencode.json package.json bun.lock package-lock.json; do [ -f "$c" ] && echo "$c"; done
    } | sort > "$tmp/head-list.txt"
    md5sum $(cat "$tmp/head-list.txt") 2>/dev/null
  ) | sort -k2 > "$tmp/head.md5"

  echo "--- 生產多出（release 會刪）---"; comm -13 "$tmp/exp" "$tmp/actual.txt" | sed 's/^/  DEL /'
  echo "--- git 有、生產缺（release 會新增）---"; comm -23 "$tmp/exp" "$tmp/actual.txt" | sed 's/^/  ADD /'
  echo "--- 內容不同 ---"
  join -j2 -o 0,1.1,2.1 "$tmp/head.md5" "$tmp/actual.md5" 2>/dev/null \
    | awk '$2!=$3{print "  DIFF " $1}' || true
  echo "（完整判定以 vps-opencode-recon.sh 為準）"
}

cmd_release() {
  preflight_local
  assert_tree_clean
  local sha sha12 ts stage exp tar_file
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA:-HEAD}^{commit}")" || die "無法解析 commit"
  sha12="$(git -C "$REPO_ROOT" rev-parse --short=12 "$sha")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  stage="$(mktemp -d /tmp/oc-stage.XXXXXX)"; exp="$(mktemp /tmp/oc-exp.XXXXXX)"; tar_file="$(mktemp /tmp/oc-stage.XXXXXX.tar)"
  # 用 ${x:-} 保險：trap 在 cmd_release 返回後才觸發，此時 local 變數已出作用域，
  # `set -u` 下直接引用會噴 unbound variable（首發實測）。
  trap 'rm -rf "${stage:-}" "${exp:-}" "${tar_file:-}"' EXIT

  log "== 發佈 .opencode @ $sha12 → $ts =="
  run_recon
  stage_from_commit "$stage" "$exp" "$sha"
  log "  預期 $(wc -l < "$exp") 檔"
  tar -C "$stage" -cf "$tar_file" .
  local bytes; bytes="$(wc -c < "$tar_file")"
  log "  封裝 $bytes bytes"

  local r_tar="/tmp/oc-release-$sha12-$ts.tar" r_exp="/tmp/oc-exp-$sha12-$ts.txt" tag="opencode-$sha12-$ts"
  remote_binary "cat > $r_tar" < "$tar_file"
  remote_stdin "cat > $r_exp" < "$exp"

  remote_stdin bash -s -- "$VPS_DIR" "$BACKUP_DIR" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$OWNER" "$tag" "$sha" "$r_tar" "$r_exp" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; BACKUP_DIR="$2"; SERVICE="$3"; HEALTH_URL="$4"; HISTORY_LOG="$5"; OWNER="$6"; tag="$7"; sha="$8"; r_tar="$9"; r_exp="${10}"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)

sudo mkdir -p "$BACKUP_DIR" "$(dirname "$HISTORY_LOG")"

# 1) 發佈前備份手維護子集（vendored 與狀態不需備份，它們不在同步範圍、也不會被動到）
sudo tar -czf "$BACKUP_DIR/$tag-pre.tgz" -C "$VPS_DIR" "${SCOPE[@]}" "${CONFIGS[@]}" 2>/dev/null || true
echo "BACKUP $BACKUP_DIR/$tag-pre.tgz"

# 2) 落地（只覆蓋／新增；不刪——刪除語義下一步用清單補）
sudo tar -C "$VPS_DIR" -xf "$r_tar"

# 3) 刪除生產多出、而 commit 沒有的檔（含舊的 node_modules 之外的殘檔）；
#    vendored(node_modules/services) 與 opencode.db 不在 walk 範圍，永不誤刪。
sudo find "${SCOPE[@]/#/$VPS_DIR/}" -type f ! -path '*/__pycache__/*' 2>/dev/null \
  | sed "s|^$VPS_DIR/||" | sort > /tmp/oc-actual.txt
for c in "${CONFIGS[@]}"; do sudo test -f "$VPS_DIR/$c" && echo "$c" >> /tmp/oc-actual.txt; done
sort -o /tmp/oc-actual.txt /tmp/oc-actual.txt
comm -13 "$r_exp" /tmp/oc-actual.txt > /tmp/oc-extras.txt || true
n=0
while IFS= read -r f; do [ -n "$f" ] && { sudo rm -f "$VPS_DIR/$f"; n=$((n+1)); }; done < /tmp/oc-extras.txt
echo "REMOVED $n 個生產多出檔"

# 4) 權限與服務
sudo chown -R "$OWNER" $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done) 2>/dev/null || true
for c in "${CONFIGS[@]}"; do sudo chown "$OWNER" "$VPS_DIR/$c" 2>/dev/null || true; done
sudo systemctl restart "$SERVICE"
sleep 2
state="$(systemctl is-active "$SERVICE" || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo ERR)"
echo "$tag $sha $(date -u +%s) release files=$(wc -l < "$r_exp") service=$state http=$code" | sudo tee -a "$HISTORY_LOG" >/dev/null
if [ "$state" != "active" ]; then echo "SERVICE_NOT_ACTIVE state=$state"; sudo journalctl -u "$SERVICE" -n 20 --no-pager >&2; exit 1; fi
case "$code" in 200|401) echo "VERIFY_OK service=active http=$code files=$(wc -l < "$r_exp")";; *) echo "HEALTH_UNEXPECTED http=$code"; exit 1;; esac
rm -f "$r_tar" "$r_exp" /tmp/oc-actual.txt /tmp/oc-extras.txt
REMOTE
  log "release 完成：$tag"
}

cmd_rollback() {
  preflight_local
  log "== rollback：回復最新一份 opencode-*-pre.tgz =="
  remote_stdin bash -s -- "$VPS_DIR" "$BACKUP_DIR" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$OWNER" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; BACKUP_DIR="$2"; SERVICE="$3"; HEALTH_URL="$4"; HISTORY_LOG="$5"; OWNER="$6"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)
latest="$(sudo ls -1t "$BACKUP_DIR"/opencode-*-pre.tgz 2>/dev/null | head -1 || true)"
[ -n "$latest" ] || { echo "NO_BACKUP"; exit 1; }
echo "ROLLBACK_FROM $latest"
# 先清手維護子集，再還原（清掉現有 extras，回滾才是真的回到備份狀態）
sudo rm -rf $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done)
sudo tar -xzf "$latest" -C "$VPS_DIR"
sudo chown -R "$OWNER" $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done) 2>/dev/null || true
for c in "${CONFIGS[@]}"; do sudo chown "$OWNER" "$VPS_DIR/$c" 2>/dev/null || true; done
sudo systemctl restart "$SERVICE"; sleep 2
state="$(systemctl is-active "$SERVICE" || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo ERR)"
echo "rollback $latest $(date -u +%s) service=$state http=$code" | sudo tee -a "$HISTORY_LOG" >/dev/null
[ "$state" = active ] || { echo "SERVICE_NOT_ACTIVE"; exit 1; }
echo "ROLLBACK_OK from=$latest service=active http=$code"
REMOTE
}

main() {
  local cmd="${1:-}"; [ -n "$cmd" ] || { usage; exit 2; }; shift || true
  case "$cmd" in
    status) parse_flags "$@"; cmd_status ;;
    plan) parse_flags "$@"; cmd_plan ;;
    release) parse_flags "$@"; cmd_release ;;
    rollback) parse_flags "$@"; cmd_rollback ;;
    -h|--help|help) usage ;;
    *) usage; die "未知子命令：$cmd" ;;
  esac
}
main "$@"
