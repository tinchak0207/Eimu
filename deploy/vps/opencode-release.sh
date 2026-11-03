#!/usr/bin/env bash
# opencode-release.sh — 把 deploy-staging/opencode-runtime（git 真源）同步到
#   /opt/agent-harness/workspace/.opencode 并重启 opencode-server
#
# 用法：
#   bash deploy/vps/opencode-release.sh status            # 唯读：现况＋健康
#   bash deploy/vps/opencode-release.sh plan [--sha C]    # 唯读：列出将变更的档
#   bash deploy/vps/opencode-release.sh guard --sha C     # 唯读：只跑发版祖先闸（对真线上）
#   bash deploy/vps/opencode-release.sh release --sha C [--skip-recon] [--dry-run] [--force] [--fast] [--prompts-only] [--override-ancestry "<理由>"]
#   bash deploy/vps/opencode-release.sh rollback [--dry-run] [--force]   # 回复最新备份
#
# --fast（2026-10-19）：等价 --skip-recon --force，跳过 recon 与 drain，立即重启。
#   用于提示词/文案/技能这类短改：目标 <30s，不再为在途回合等 180s。中断的回合由
#   harness 的耐久续接处理；需要保护在途长任务时不要用 --fast。
# --prompts-only：更快（目标 <5s）——只装 AGENTS.md + skills/_prompt-routing，不打包、
#   不备份、不删档、不重启。只适用于这两处提示词资产的改动。
# 发版祖先闸（2026-10-30，见 release-ancestry-guard.sh）：release/--prompts-only 都必须显式 --sha；
#   候选必须包含 opencode-history.log 推出的线上生效 commit（最近全量 release ＋ 其后 prompts-only；
#   rollback 后回到上一次全量之前），否则拒发。--fast/--skip-recon/--force 不跳过；
#   唯一覆盖 --override-ancestry "<理由>"（写审计）。
#
# F8（2026-10-04）断面 A｜重启前 drain（默认开启）：
#   restart 之前先只读探测「有没有在途回合/子代理」，有则轮询等到清空（上界 180s，
#   DRAIN_MAX_SECS 可覆写）；到上界仍未清空 → **默认中止部署并明确告知**，不再静默
#   杀在途会话。确需立即重启（例：生产已坏需紧急回滚）→ 加 --force 跳过等待。
#
# 为什么不是 gateway-release.sh 那套 symlink 模型（刻意差异，非疏漏）：
#   .opencode 内含 vendored 的 services/(898M) 与 node_modules/(93M) 及执行时 opencode.db，
#   「整包换目录＋切 symlink」会把它们一起抹掉。故本脚本改用「白名单同步」：只同步
#   tools/lib/skills/plugin ＋ 4 个设定档，vendored 与执行时状态永不进入同步范围。
#   删除语义靠「档案清单比对」补齐（本机无 rsync，且不为此装系统套件）。
# 不变量（与 gateway 同）：只发布已 commit 的快照；发布前强制 recon 漂移闸；发布前备份；
#   落地后必须看服务真的起来才算数。
set -euo pipefail
export LC_ALL=C

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
# shellcheck source=release-ancestry-guard.sh
. "$SCRIPT_DIR/release-ancestry-guard.sh"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)
WORKSPACE_DIR="${OC_WORKSPACE_DIR:-$(dirname "$VPS_DIR")}"
HARNESS_ROOT="${OC_HARNESS_ROOT:-$(dirname "$WORKSPACE_DIR")}"
ACTIVATION_LOCK="${HARNESS_ACTIVATION_LOCK:-$HARNESS_ROOT/.harness-activation.lock}"
# workspace 根的手维护设定档：repo 内放在镜像根，但**部署目标是 workspace/ 而非 .opencode/**，
# 故必须从主 tar 排除、单独安装，否则会被放到 .opencode/AGENTS.md（错的位置）。
ROOT_FILES=(AGENTS.md)

DRY_RUN=0
SKIP_RECON=0
FORCE=0
PROMPTS_ONLY=0
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
  local command
  if [ "$#" -gt 1 ]; then printf -v command '%q ' "$@"; else command="$1"; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$command"
}
remote_binary() {
  if [ "$DRY_RUN" -eq 1 ]; then local n; n="$(wc -c)"; log "DRY-RUN ssh(binary): $* (stdin $n bytes)"; return 0; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

runtime_identity() {
  python3 - "$VPS_DIR" "$WORKSPACE_DIR" <<'IDENTITY'
import hashlib, os, stat, sys
from pathlib import Path
root, ws = map(Path, sys.argv[1:])
h=hashlib.sha256()
def record(p, label):
    st=p.lstat(); h.update(label.encode()+b'\0'+str(stat.S_IMODE(st.st_mode)).encode()+b'\0')
    if p.is_symlink(): h.update(b'L'+os.readlink(p).encode())
    elif p.is_file():
        h.update(b'F')
        with p.open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    elif p.is_dir(): h.update(b'D')
    else: raise RuntimeError('unsupported managed entry')
    h.update(b'\0')
for name in ('tools','lib','skills','plugin','opencode.json','package.json','bun.lock','package-lock.json'):
    p=root/name
    if not p.exists() and not p.is_symlink(): h.update(('missing:'+name+'\0').encode()); continue
    record(p,name)
    if p.is_dir() and not p.is_symlink():
        for current, dirs, files in os.walk(p,followlinks=False):
            dirs[:]=sorted(d for d in dirs if d!='__pycache__')
            for child in sorted(dirs+files):
                q=Path(current)/child; record(q,str(q.relative_to(root)))
p=ws/'AGENTS.md'
if p.exists() or p.is_symlink(): record(p,'ROOT:AGENTS.md')
else: h.update(b'missing:ROOT:AGENTS.md')
print(h.hexdigest())
IDENTITY
}

capture_runtime_identity() {
  if [ "$DRY_RUN" -eq 1 ]; then echo dry-run; return; fi
  { declare -f runtime_identity; printf 'VPS_DIR="$1"; WORKSPACE_DIR="$2"; runtime_identity\n'; } \
    | remote_stdin sudo bash -s -- "$VPS_DIR" "$WORKSPACE_DIR"
}

oc_validate_backup() {
  local archive="$1" listing item
  listing="$(tar -tzf "$archive")" || { echo "BACKUP_INVALID $archive" >&2; return 1; }
  for item in tools lib skills plugin; do
    printf '%s\n' "$listing" | sed 's|^\./||' | grep -Fx -- "$item/" >/dev/null \
      || { echo "BACKUP_INVALID missing_scope=$item" >&2; return 1; }
  done
  [ -f "${archive%.tgz}-AGENTS.md" ] || [ -f "${archive%.tgz}-AGENTS.absent" ] \
    || { echo "BACKUP_AGENTS_UNKNOWN $archive" >&2; return 1; }
}

oc_create_backup() {
  local archive="$1" item
  local -a items=()
  for item in tools lib skills plugin opencode.json package.json bun.lock package-lock.json; do
    if [ -e "$VPS_DIR/$item" ] || [ -L "$VPS_DIR/$item" ]; then items+=("$item"); fi
  done
  [ "${#items[@]}" -gt 0 ] || return 1
  sudo tar -czf "$archive" -C "$VPS_DIR" "${items[@]}" || return 1
  if [ -f "$WORKSPACE_DIR/AGENTS.md" ]; then
    cp -a "$WORKSPACE_DIR/AGENTS.md" "${archive%.tgz}-AGENTS.md" || return 1
  else
    : > "${archive%.tgz}-AGENTS.absent" || return 1
  fi
  oc_validate_backup "$archive" || return 1
  echo "BACKUP $archive"
}

oc_restore_backup() {
  local archive="$1" item
  oc_validate_backup "$archive" || return 1
  for item in tools lib skills plugin opencode.json package.json bun.lock package-lock.json; do
    rm -rf "$VPS_DIR/$item" || return 1
  done
  tar -xzf "$archive" -C "$VPS_DIR" || return 1
  if [ -f "${archive%.tgz}-AGENTS.md" ]; then
    cp -a "${archive%.tgz}-AGENTS.md" "$WORKSPACE_DIR/AGENTS.md" || return 1
  else
    rm -f "$WORKSPACE_DIR/AGENTS.md" || return 1
  fi
}

oc_start_and_verify() {
  [ -x /opt/agent-harness/bin/derive-opencode-runtime.sh ] || { echo DERIVE_MISSING >&2; return 1; }
  sudo /opt/agent-harness/bin/derive-opencode-runtime.sh || return 1
  sudo systemctl restart "$SERVICE" || return 1
  local code state attempt
  for attempt in 1 2 3 4 5 6; do
    state="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || true)"
    if [ "$state" = active ]; then case "$code" in 200|401) echo "VERIFY_OK service=active http=$code"; return 0;; esac; fi
    sleep 2
  done
  echo "HEALTH_UNEXPECTED service=$state http=$code" >&2
  return 1
}

oc_recover() {
  local rc="$1"
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "${OC_CHANGED:-0}" -eq 1 ]; then
    set +e
    if oc_restore_backup "$OC_UNDO" && oc_start_and_verify; then
      echo "RECOVERY_OK opencode original_exit=$rc" >&2
    else
      echo "RECOVERY_FAILED opencode original_exit=$rc — 服务恢复未证实" >&2
    fi
  fi
  if ! maintenance_end; then
    echo "MAINTENANCE_RESTORE_FAILED — 原维护状态未恢复，下次同锁激活可接续" >&2
    [ "$rc" -ne 0 ] || rc=1
  fi
  if [ -n "${OC_TMP_STAGE:-}" ]; then rm -rf "$OC_TMP_STAGE"; fi
  if [ -n "${OC_TMP_UPLOAD:-}" ]; then rm -f "$OC_TMP_UPLOAD"; fi
  exit "$rc"
}

oc_prepare() {
  [ "$(runtime_identity)" = "$1" ] || { echo ACTIVATION_CONFLICT >&2; exit 76; }
  trap 'oc_recover $?' EXIT
  trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
  # H07（2026-11-03「更新中」事故）：带 drain 参数时走两段 drain——软 drain 不开维护，
  # 清零才 maintenance_begin，再短终检（drain_then_maintenance 来自 gateway-release.sh __emit-drain）。
  if [ "$#" -gt 2 ]; then drain_then_maintenance "$2" "${@:3}"; else maintenance_begin "$2"; fi
}

run_oc_activation() {
  { printf 'ACTIVATION_LOCK=%q\n' "$ACTIVATION_LOCK";
    bash "$SCRIPT_DIR/gateway-release.sh" __emit-drain; \
    declare -f runtime_identity oc_validate_backup oc_create_backup oc_restore_backup oc_start_and_verify oc_recover oc_prepare; cat; } \
    | remote_stdin sudo flock -n -E 75 "$ACTIVATION_LOCK" bash -s -- "$@"
}

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --skip-recon) SKIP_RECON=1 ;;
      --force) FORCE=1 ;;
      --fast) SKIP_RECON=1; FORCE=1 ;;
      --prompts-only) PROMPTS_ONLY=1; SKIP_RECON=1; FORCE=1 ;;
      --sha) shift; SHA="${1:-}"; [ -n "$SHA" ] || die "--sha 需要值" ;;
      --override-ancestry) shift; guard_set_override "${1:-}" ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数：$1" ;;
    esac
    shift
  done
}

preflight_local() {
  [ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$REPO_ROOT 不是 git repo"
}

# 根因守门：真源子树有未 commit 改动时禁止发布（未 commit 部署＝生产分叉的入口）
assert_tree_clean() {
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain -- "$SRC_SUBDIR")"
  [ -z "$dirty" ] || { printf '%s\n' "$dirty" >&2; die "$SRC_SUBDIR 有未 commit 改动 → 拒绝发布。先 commit。"; }
}

# 上次发布的 sha（recon 的正确基准：生产是否仍等于上次发出的那一版）
last_release_sha() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" \
    "sudo tail -1 '$HISTORY_LOG' 2>/dev/null | awk '{print \$2}'" 2>/dev/null | head -1
}

run_recon() {
  [ "$SKIP_RECON" -eq 1 ] && { log "SKIP recon（--skip-recon）"; return 0; }
  [ -f "$RECON_SCRIPT" ] || die "找不到 recon 脚本：$RECON_SCRIPT"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN local: bash $RECON_SCRIPT"; return 0; fi
  local base
  base="$(last_release_sha)"
  [ -n "$base" ] || base="HEAD"
  log "== recon 对账（挡漂移；基准 $base）=="
  RECON_BASE="$base" bash "$RECON_SCRIPT" || die "recon 未通过（生产被手改或故障）→ 先收编再发布"
}

# 发版祖先闸：只读读 history（--dry-run 照样读真线上），推出线上生效 commit 集合。
# 须在 OC_EXPECTED 抓取之后调用：之后若有人并行发版，激活阶段 ACTIVATION_CONFLICT 会拦下。
guard_remote_append() {
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "sudo tee -a '$1' >/dev/null"
}
opencode_ancestry_gate() {
  local cand="$1" hist
  local -a online=()
  hist="$(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "sudo cat '$HISTORY_LOG'")" \
    || die "读线上 opencode history 失败（SSH/权限）→ 不发"
  mapfile -t online < <(printf '%s\n' "$hist" | guard_opencode_online_from_history)
  guard_check_ancestry opencode "$cand" "$REPO_ROOT" "$DRY_RUN" guard_remote_append "${online[@]}"
}
cmd_guard() {
  preflight_local
  guard_require_explicit_sha "$SHA" "opencode-release.sh guard"
  DRY_RUN=1
  local sha
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA}^{commit}")" || die "无法解析 commit：$SHA"
  opencode_ancestry_gate "$sha"
}

# 把 commit 的镜像展开到 $1；印出预期档案清单到 $2
stage_from_commit() {
  local stage="$1" exp="$2" sha="$3"
  git -C "$REPO_ROOT" archive --format=tar "$sha" "$SRC_SUBDIR" \
    | tar -x --strip-components=2 -C "$stage"
  ( cd "$stage"
    find "${SCOPE[@]}" -type f ! -path '*/__pycache__/*' 2>/dev/null
    for c in "${CONFIGS[@]}"; do [ -f "$c" ] && echo "$c"; done
  ) | sort > "$exp"
}

# --prompts-only：只热装 AGENTS.md 与 skills/_prompt-routing，正常完成不重启。
# 激活前保存可验证备份；热装失败才恢复旧内容并重启验证。
release_prompts_only() {
  assert_tree_clean
  local sha sha12 ts tmp r_tar
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA}^{commit}")" || die "无法解析 commit：$SHA"
  opencode_ancestry_gate "$sha"
  sha12="$(git -C "$REPO_ROOT" rev-parse --short=12 "$sha")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="$(mktemp -d /tmp/oc-prompts.XXXXXX)"
  trap 'rm -rf "${tmp:-}"' EXIT
  git -C "$REPO_ROOT" archive --format=tar "$sha" \
    "$SRC_SUBDIR/AGENTS.md" "$SRC_SUBDIR/skills/_prompt-routing" > "$tmp/prompts.tar"
  r_tar="/tmp/oc-prompts-$sha12-$ts.tar"
  log "== 提示词快发 @ $sha12 → $ts（只装 AGENTS.md + skills/_prompt-routing，不重启）=="
  remote_binary "cat > $r_tar" < "$tmp/prompts.tar"
  run_oc_activation "$WORKSPACE_DIR" "$VPS_DIR" "$r_tar" "$SRC_SUBDIR" "$OC_EXPECTED" "${OC_DRAIN_SESSIONS_DB:-/opt/agent-harness/state/sessions.db}" "$BACKUP_DIR" "$OWNER" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$sha" <<'REMOTE'
set -euo pipefail
export LC_ALL=C
WORKSPACE_DIR="$1"; VPS_DIR="$2"; r_tar="$3"; SRC_SUBDIR="$4"
OWNER="$8"; SERVICE="$9"; HEALTH_URL="${10}"; HISTORY_LOG="${11}"; sha="${12}"
oc_prepare "$5" "$6"
OC_UNDO="$7/prompts-recovery-$(date -u +%Y%m%dT%H%M%SZ)-$$.tgz"
oc_create_backup "$OC_UNDO"
OC_CHANGED=1
stage="$(mktemp -d /tmp/oc-prompts-stage.XXXXXX)"
OC_TMP_STAGE="$stage"; OC_TMP_UPLOAD="$r_tar"
tar -xf "$r_tar" -C "$stage"
src="$stage/$SRC_SUBDIR"
[ -f "$src/AGENTS.md" ] || { echo "PROMPTS_ONLY_MISSING AGENTS.md"; exit 1; }
sudo install -D -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$src/AGENTS.md" "$WORKSPACE_DIR/AGENTS.md"
n=0
while IFS= read -r -d '' f; do
  rel="${f#"$src"/}"
  sudo install -D -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$f" "$VPS_DIR/$rel"
  n=$((n+1))
done < <(find "$src/skills/_prompt-routing" -type f -print0)
rm -rf "$stage" "$r_tar"
# 快发也记一行：下次全量发布的 recon 以 history 末行 sha 为基准，不记就把自己发的 AGENTS.md 误判成手改漂移。
sudo mkdir -p "$(dirname "$HISTORY_LOG")"
printf 'prompts-only %s %s prompts\n' "$sha" "$(date -u +%s)" | sudo tee -a "$HISTORY_LOG" >/dev/null
maintenance_end
OC_CHANGED=0
trap - EXIT
echo "PROMPTS_ONLY_OK files=$((n+1)) agents_sha=$(sha256sum "$WORKSPACE_DIR/AGENTS.md" | cut -d' ' -f1 | cut -c1-12)"
REMOTE
}

cmd_status() {
  preflight_local
  remote_stdin bash -s -- "$VPS_DIR" "$SERVICE" "$HEALTH_URL" "$BACKUP_DIR" "$HISTORY_LOG" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; SERVICE="$2"; HEALTH_URL="$3"; BACKUP_DIR="$4"; HISTORY_LOG="$5"
echo "vps_dir=$VPS_DIR"
echo "service=$([ "$(systemctl is-active "$SERVICE")" = active ] && echo active || echo "$(systemctl is-active "$SERVICE")")"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || echo ERR)"
echo "opencode_http=$code（200/401 皆代表服务在线并回应）"
echo "--- 手维护子集档案数 ---"
sudo find "$VPS_DIR"/tools "$VPS_DIR"/lib "$VPS_DIR"/skills "$VPS_DIR"/plugin -type f 2>/dev/null | wc -l
echo "--- 备份（tail 5）---"
sudo ls -1t "$BACKUP_DIR"/opencode-*.tgz 2>/dev/null | head -5 || echo "(无)"
echo "--- history（tail 5）---"
sudo tail -5 "$HISTORY_LOG" 2>/dev/null || echo "(无)"
REMOTE
}

cmd_plan() {
  preflight_local
  local sha tmp
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA:-HEAD}^{commit}")" || die "无法解析 commit"
  tmp="$(mktemp -d /tmp/oc-plan.XXXXXX)"
  # RETURN trap 触发时 local 已出作用域，set -u 下直接引用 $tmp 会喷 unbound
  # （与 cmd_release 同因，见其 EXIT trap 注解）——用 ${tmp:-} 保险。
  trap 'rm -rf "${tmp:-}"' RETURN
  mkdir -p "$tmp/stage"
  stage_from_commit "$tmp/stage" "$tmp/exp" "$sha"
  log "== plan @ $(git -C "$REPO_ROOT" rev-parse --short=12 "$sha")：commit 端 $(wc -l < "$tmp/exp") 档 =="

  for c in "${CONFIGS[@]}"; do echo "$c"; done > "$tmp/conf.txt"
  remote "cd '$VPS_DIR' && { sudo find tools lib skills plugin -type f ! -path '*/__pycache__/*' 2>/dev/null; for c in opencode.json package.json bun.lock package-lock.json; do sudo test -f \"\$c\" && echo \"\$c\"; done; } | LC_ALL=C sort" > "$tmp/actual.txt"
  remote "cd '$VPS_DIR' && { sudo find tools lib skills plugin -type f ! -path '*/__pycache__/*' -exec md5sum {} + 2>/dev/null; for c in opencode.json package.json bun.lock package-lock.json; do sudo test -f \"\$c\" && sudo md5sum \"\$c\"; done; } | LC_ALL=C sort -k2" > "$tmp/actual.md5"
  ( cd "$tmp/stage"
    # 档名可能含空白（例：skills/higgsfield/docs/Seedance 2 Skill.md）——用 NUL
    # 分隔（-print0 / sort -z / xargs -0），否则 `md5sum $(cat 清单)` 会被
    # word-split 成多个假档名而 exit 1（实测）。
    { find tools lib skills plugin -type f ! -path '*/__pycache__/*' -print0 2>/dev/null
      for c in opencode.json package.json bun.lock package-lock.json; do [ -f "$c" ] && printf '%s\0' "$c"; done
    } | sort -z > "$tmp/head-list.txt"
    xargs -0 -r md5sum < "$tmp/head-list.txt" 2>/dev/null
  ) | sort -k2 > "$tmp/head.md5"

  echo "--- 生产多出（release 会删）---"; comm -13 "$tmp/exp" "$tmp/actual.txt" | sed 's/^/  DEL /'
  echo "--- git 有、生产缺（release 会新增）---"; comm -23 "$tmp/exp" "$tmp/actual.txt" | sed 's/^/  ADD /'
  echo "--- 内容不同 ---"
  join -j2 -o 0,1.1,2.1 "$tmp/head.md5" "$tmp/actual.md5" 2>/dev/null \
    | awk '$2!=$3{print "  DIFF " $1}' || true
  echo "（完整判定以 vps-opencode-recon.sh 为准）"
  if [ -f "$tmp/stage/AGENTS.md" ]; then
    local a b
    a="$(md5sum "$tmp/stage/AGENTS.md" | awk '{print $1}')"
    b="$(remote "sudo md5sum '$WORKSPACE_DIR/AGENTS.md' 2>/dev/null" | awk '{print $1}')"
    if [ "$a" = "$b" ]; then echo "  $WORKSPACE_DIR/AGENTS.md 一致"; else echo "  DIFF $WORKSPACE_DIR/AGENTS.md（workspace 根）"; fi
  fi
}

cmd_release() {
  preflight_local
  local OC_EXPECTED
  guard_require_explicit_sha "$SHA" "opencode-release.sh release"
  OC_EXPECTED="$(capture_runtime_identity)" || die "无法读取当前 runtime 内容身份"
  if [ "$PROMPTS_ONLY" -eq 1 ]; then release_prompts_only; return; fi
  assert_tree_clean
  local sha sha12 ts stage exp tar_file
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA}^{commit}")" || die "无法解析 commit：$SHA"
  opencode_ancestry_gate "$sha"
  if [ "$DRY_RUN" -eq 0 ]; then bun "$REPO_ROOT/tools/check-opencode-tool-schemas.mjs" --commit "$sha" --repo "$REPO_ROOT"; fi
  sha12="$(git -C "$REPO_ROOT" rev-parse --short=12 "$sha")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  stage="$(mktemp -d /tmp/oc-stage.XXXXXX)"; exp="$(mktemp /tmp/oc-exp.XXXXXX)"; tar_file="$(mktemp /tmp/oc-stage.XXXXXX.tar)"
  # 用 ${x:-} 保险：trap 在 cmd_release 返回后才触发，此时 local 变数已出作用域，
  # `set -u` 下直接引用会喷 unbound variable（首发实测）。
  trap 'rm -rf "${stage:-}" "${exp:-}" "${tar_file:-}"' EXIT

  log "== 发布 .opencode @ $sha12 → $ts =="
  run_recon
  stage_from_commit "$stage" "$exp" "$sha"
  log "  预期 $(wc -l < "$exp") 档"
  # 目录模式不可由 stage 决定（2026-10-02 事故，已实锤）：stage 是 mktemp -d（0700），tar 会把
  # "./" 的 0700 记进压缩档，远端 sudo tar -x 再把它盖到生产 .opencode 上 → opencode-server
  # （agentsvc，systemd PrivateTmp）失去 traverse，沙箱对 skills/lib/node_modules 的 ro-bind 与
  # plugin/tool 载入全失败，而 systemd 仍显示 active（假绿灯）。这里先把目录正规化。
  find "$stage" -type d -exec chmod 755 {} + 2>/dev/null || true
  chmod 755 "$stage"
  tar -C "$stage" --exclude=./AGENTS.md -cf "$tar_file" .
  local bytes; bytes="$(wc -c < "$tar_file")"
  log "  封装 $bytes bytes（AGENTS.md 另行处理，不进 .opencode）"

  local r_tar="/tmp/oc-release-$sha12-$ts-$$.tar" r_exp="/tmp/oc-exp-$sha12-$ts-$$.txt" tag="opencode-$sha12-$ts-$$"
  local r_agents=""
  remote_binary "cat > $r_tar" < "$tar_file"
  remote_stdin "cat > $r_exp" < "$exp"
  if [ -f "$stage/AGENTS.md" ]; then
    r_agents="/tmp/oc-agents-$sha12-$ts-$$.md"
    remote_binary "cat > $r_agents" < "$stage/AGENTS.md"
    log "  另传 AGENTS.md → $WORKSPACE_DIR/AGENTS.md"
  fi

  # 同一远端目标的 drain→同步→重启→验证必须排他，锁随该 SSH 批次结束释放。
  # BACKUP_DIR 已存在是受管发布的前提；缺失时 flock 拒绝，不提前改线上。
  run_oc_activation "$VPS_DIR" "$BACKUP_DIR" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$OWNER" "$tag" "$sha" "$r_tar" "$r_exp" "$WORKSPACE_DIR" "$r_agents" "$FORCE" "${OC_DRAIN_MAX_SECS:-180}" "${OC_DRAIN_POLL_SECS:-5}" "${OC_DRAIN_WINDOW_MS:-180000}" "${OC_DRAIN_SESSIONS_DB:-/opt/agent-harness/state/sessions.db}" "${OC_DRAIN_OPENCODE_DB:-/opt/agent-harness/workspace/.local/share/opencode/opencode.db}" "$OC_EXPECTED" <<'REMOTE'
set -euo pipefail
export LC_ALL=C
VPS_DIR="$1"; BACKUP_DIR="$2"; SERVICE="$3"; HEALTH_URL="$4"; HISTORY_LOG="$5"; OWNER="$6"; tag="$7"; sha="$8"; r_tar="$9"; r_exp="${10}"; WORKSPACE_DIR="${11}"; r_agents="${12:-}"; DRAIN_FORCE="${13:-0}"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)

oc_prepare "${19}" "${17}" "${13}" "${14}" "${15}" "${16}" "${17}" "${18}"

# drain 成功后才开始可见变更；超时只留下临时上传文件，不覆盖运行中的工具/提示词。
sudo mkdir -p "$BACKUP_DIR" "$(dirname "$HISTORY_LOG")"
OC_UNDO="$BACKUP_DIR/$tag-pre.tgz"
oc_create_backup "$OC_UNDO"
OC_CHANGED=1
trap 'oc_recover $?' EXIT
sudo tar -C "$VPS_DIR" -xf "$r_tar"
sudo chmod 2755 "$VPS_DIR"
for d in "${SCOPE[@]}"; do
  sudo find "$VPS_DIR/$d" -type d -exec chmod 2755 {} + 2>/dev/null || true
done
# 删除语义仍限于手维护子集；vendored 与运行状态不在清单范围。
sudo find "${SCOPE[@]/#/$VPS_DIR/}" -type f ! -path '*/__pycache__/*' 2>/dev/null \
  | sed "s|^$VPS_DIR/||" | sort > /tmp/oc-actual.txt
for c in "${CONFIGS[@]}"; do sudo test -f "$VPS_DIR/$c" && echo "$c" >> /tmp/oc-actual.txt; done
sort -o /tmp/oc-actual.txt /tmp/oc-actual.txt
if ! comm --check-order -13 "$r_exp" /tmp/oc-actual.txt > /tmp/oc-extras.txt; then
  echo "EXTRAS_COMPARE_FAILED 文件清单比较失败，停止发布，不删除任何文件"
  exit 1
fi
n=0
while IFS= read -r f; do [ -n "$f" ] && { sudo rm -f "$VPS_DIR/$f"; n=$((n+1)); }; done < /tmp/oc-extras.txt
echo "REMOVED $n 个生产多出档"
sudo chown -R "$OWNER" $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done) 2>/dev/null || true
for c in "${CONFIGS[@]}"; do sudo chown "$OWNER" "$VPS_DIR/$c" 2>/dev/null || true; done
if [ -n "$r_agents" ]; then
  sudo install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$r_agents" "$WORKSPACE_DIR/AGENTS.md"
  cmp -s "$r_agents" "$WORKSPACE_DIR/AGENTS.md" || { echo "AGENTS_MISMATCH"; exit 1; }
  echo "AGENTS_OK $WORKSPACE_DIR/AGENTS.md"
  rm -f "$r_agents"
fi
SVC_USER="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
[ -n "$SVC_USER" ] || SVC_USER="agentsvc"
for probe in "$VPS_DIR" "$VPS_DIR/lib" "$VPS_DIR/plugin" "$VPS_DIR/tools" "$VPS_DIR/skills"; do
  if ! sudo -u "$SVC_USER" test -r "$probe"; then
    echo "PERM_FAIL $probe 服务帐号 $SVC_USER 不可读（目录模式或上层 traverse 不足）"; exit 1
  fi
done
echo "PERM_OK $SVC_USER 可读 .opencode 工具链"

oc_start_and_verify
rm -f "$r_tar" "$r_exp" /tmp/oc-actual.txt /tmp/oc-extras.txt
maintenance_end
printf '%s %s %s release service=active\n' "$tag" "$sha" "$(date -u +%s)" >> "$HISTORY_LOG"
OC_CHANGED=0
trap - EXIT

REMOTE
  log "release 完成：$tag"
}

cmd_rollback() {
  preflight_local
  local OC_EXPECTED
  OC_EXPECTED="$(capture_runtime_identity)" || die "无法读取当前 runtime 内容身份"
  run_oc_activation "$VPS_DIR" "$BACKUP_DIR" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$OWNER" "$FORCE" \
    "${OC_DRAIN_MAX_SECS:-180}" "${OC_DRAIN_POLL_SECS:-5}" "${OC_DRAIN_WINDOW_MS:-180000}" \
    "${OC_DRAIN_SESSIONS_DB:-/opt/agent-harness/state/sessions.db}" \
    "${OC_DRAIN_OPENCODE_DB:-/opt/agent-harness/workspace/.local/share/opencode/opencode.db}" "$OC_EXPECTED" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; BACKUP_DIR="$2"; SERVICE="$3"; HEALTH_URL="$4"; HISTORY_LOG="$5"; OWNER="$6"
WORKSPACE_DIR="$(dirname "$VPS_DIR")"
latest="$(sudo ls -1t "$BACKUP_DIR"/opencode-*-pre.tgz 2>/dev/null | head -1 || true)"
[ -n "$latest" ] || { echo NO_BACKUP; exit 1; }
oc_validate_backup "$latest"
oc_prepare "${13}" "${11}" "${7}" "${8}" "${9}" "${10}" "${11}" "${12}"
OC_UNDO="$BACKUP_DIR/recovery-opencode-$(date -u +%Y%m%dT%H%M%SZ)-$$.tgz"
oc_create_backup "$OC_UNDO"
OC_CHANGED=1
trap 'oc_recover $?' EXIT
oc_restore_backup "$latest"
oc_start_and_verify
maintenance_end
printf 'rollback %s %s service=active\n' "$latest" "$(date -u +%s)" >> "$HISTORY_LOG"
OC_CHANGED=0
trap - EXIT
echo "ROLLBACK_OK from=$latest"
REMOTE
}

main() {
  local cmd="${1:-}"; [ -n "$cmd" ] || { usage; exit 2; }; shift || true
  case "$cmd" in
    status) parse_flags "$@"; cmd_status ;;
    plan) parse_flags "$@"; cmd_plan ;;
    guard) parse_flags "$@"; cmd_guard ;;
    release) parse_flags "$@"; cmd_release ;;
    rollback) parse_flags "$@"; cmd_rollback ;;
    -h|--help|help) usage ;;
    *) usage; die "未知子命令：$cmd" ;;
  esac
}
main "$@"
