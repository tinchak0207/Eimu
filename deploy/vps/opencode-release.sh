#!/usr/bin/env bash
# opencode-release.sh — 把 deploy-staging/opencode-runtime（git 真源）同步到
#   /opt/agent-harness/workspace/.opencode 并重启 opencode-server
#
# 用法：
#   bash deploy/vps/opencode-release.sh status            # 唯读：现况＋健康
#   bash deploy/vps/opencode-release.sh plan [--sha C]    # 唯读：列出将变更的档
#   bash deploy/vps/opencode-release.sh release [--sha C] [--skip-recon] [--dry-run]
#   bash deploy/vps/opencode-release.sh rollback [--dry-run]   # 回复最新备份
#
# 为什么不是 gateway-release.sh 那套 symlink 模型（刻意差异，非疏漏）：
#   .opencode 内含 vendored 的 services/(898M) 与 node_modules/(93M) 及执行时 opencode.db，
#   「整包换目录＋切 symlink」会把它们一起抹掉。故本脚本改用「白名单同步」：只同步
#   tools/lib/skills/plugin ＋ 4 个设定档，vendored 与执行时状态永不进入同步范围。
#   删除语义靠「档案清单比对」补齐（本机无 rsync，且不为此装系统套件）。
# 不变量（与 gateway 同）：只发布已 commit 的快照；发布前强制 recon 漂移闸；发布前备份；
#   落地后必须看服务真的起来才算数。
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
WORKSPACE_DIR="${OC_WORKSPACE_DIR:-$(dirname "$VPS_DIR")}"
# workspace 根的手维护设定档：repo 内放在镜像根，但**部署目标是 workspace/ 而非 .opencode/**，
# 故必须从主 tar 排除、单独安装，否则会被放到 .opencode/AGENTS.md（错的位置）。
ROOT_FILES=(AGENTS.md)

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
  remote "cd '$VPS_DIR' && { sudo find tools lib skills plugin -type f ! -path '*/__pycache__/*' 2>/dev/null; for c in opencode.json package.json bun.lock package-lock.json; do sudo test -f \"\$c\" && echo \"\$c\"; done; } | sort" > "$tmp/actual.txt"
  remote "cd '$VPS_DIR' && { sudo find tools lib skills plugin -type f ! -path '*/__pycache__/*' -exec md5sum {} + 2>/dev/null; for c in opencode.json package.json bun.lock package-lock.json; do sudo test -f \"\$c\" && sudo md5sum \"\$c\"; done; } | sort -k2" > "$tmp/actual.md5"
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
  assert_tree_clean
  local sha sha12 ts stage exp tar_file
  sha="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA:-HEAD}^{commit}")" || die "无法解析 commit"
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

  local r_tar="/tmp/oc-release-$sha12-$ts.tar" r_exp="/tmp/oc-exp-$sha12-$ts.txt" tag="opencode-$sha12-$ts"
  local r_agents=""
  remote_binary "cat > $r_tar" < "$tar_file"
  remote_stdin "cat > $r_exp" < "$exp"
  if [ -f "$stage/AGENTS.md" ]; then
    r_agents="/tmp/oc-agents-$sha12-$ts.md"
    remote_binary "cat > $r_agents" < "$stage/AGENTS.md"
    log "  另传 AGENTS.md → $WORKSPACE_DIR/AGENTS.md"
  fi

  remote_stdin bash -s -- "$VPS_DIR" "$BACKUP_DIR" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$OWNER" "$tag" "$sha" "$r_tar" "$r_exp" "$WORKSPACE_DIR" "$r_agents" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; BACKUP_DIR="$2"; SERVICE="$3"; HEALTH_URL="$4"; HISTORY_LOG="$5"; OWNER="$6"; tag="$7"; sha="$8"; r_tar="$9"; r_exp="${10}"; WORKSPACE_DIR="${11}"; r_agents="${12:-}"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)

sudo mkdir -p "$BACKUP_DIR" "$(dirname "$HISTORY_LOG")"

# 1) 发布前备份手维护子集（vendored 与状态不需备份，它们不在同步范围、也不会被动到）
sudo tar -czf "$BACKUP_DIR/$tag-pre.tgz" -C "$VPS_DIR" "${SCOPE[@]}" "${CONFIGS[@]}" 2>/dev/null || true
echo "BACKUP $BACKUP_DIR/$tag-pre.tgz"
if [ -n "$r_agents" ] && sudo test -f "$WORKSPACE_DIR/AGENTS.md"; then
  sudo cp -a "$WORKSPACE_DIR/AGENTS.md" "$BACKUP_DIR/$tag-pre-AGENTS.md"
  echo "BACKUP $BACKUP_DIR/$tag-pre-AGENTS.md"
fi

# 2) 落地（只覆盖／新增；不删——删除语义下一步用清单补）
sudo tar -C "$VPS_DIR" -xf "$r_tar"
# 2b) 目录不变式：不信任压缩档带来的模式。.opencode 与同步范围内的目录一律 2755（可 traverse），
#     否则服务帐号读不到工具链（2026-10-02 事故：被打成 0700 → 整条工具链 fail-closed 而服务显示 active）。
sudo chmod 2755 "$VPS_DIR"
for d in "${SCOPE[@]}"; do
  sudo find "$VPS_DIR/$d" -type d -exec chmod 2755 {} + 2>/dev/null || true
done

# 3) 删除生产多出、而 commit 没有的档（含旧的 node_modules 之外的残档）；
#    vendored(node_modules/services) 与 opencode.db 不在 walk 范围，永不误删。
sudo find "${SCOPE[@]/#/$VPS_DIR/}" -type f ! -path '*/__pycache__/*' 2>/dev/null \
  | sed "s|^$VPS_DIR/||" | sort > /tmp/oc-actual.txt
for c in "${CONFIGS[@]}"; do sudo test -f "$VPS_DIR/$c" && echo "$c" >> /tmp/oc-actual.txt; done
sort -o /tmp/oc-actual.txt /tmp/oc-actual.txt
comm -13 "$r_exp" /tmp/oc-actual.txt > /tmp/oc-extras.txt || true
n=0
while IFS= read -r f; do [ -n "$f" ] && { sudo rm -f "$VPS_DIR/$f"; n=$((n+1)); }; done < /tmp/oc-extras.txt
echo "REMOVED $n 个生产多出档"

# 4) 权限与服务
sudo chown -R "$OWNER" $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done) 2>/dev/null || true
for c in "${CONFIGS[@]}"; do sudo chown "$OWNER" "$VPS_DIR/$c" 2>/dev/null || true; done
# workspace 根设定档（位置在 .opencode 之外，单独安装＋逐 byte 验证）
if [ -n "$r_agents" ]; then
  sudo install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$r_agents" "$WORKSPACE_DIR/AGENTS.md"
  if cmp -s "$r_agents" "$WORKSPACE_DIR/AGENTS.md"; then
    echo "AGENTS_OK $WORKSPACE_DIR/AGENTS.md"
  else
    echo "AGENTS_MISMATCH"; exit 1
  fi
  rm -f "$r_agents"
fi

# 4b) 断言：服务帐号必须读得到工具链。读不到＝重启后整条工具链 fail-closed（沙箱 ro-bind 失败、
#     plugin/tool 载入失败），而 systemd 仍会显示 active（假绿灯）——所以这里 fail-closed 挡下发布。
SVC_USER="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
[ -n "$SVC_USER" ] || SVC_USER="agentsvc"
for probe in "$VPS_DIR" "$VPS_DIR/lib" "$VPS_DIR/plugin" "$VPS_DIR/tools" "$VPS_DIR/skills"; do
  if ! sudo -u "$SVC_USER" test -r "$probe"; then
    echo "PERM_FAIL $probe 服务帐号 $SVC_USER 不可读（目录模式或上层 traverse 不足）"; exit 1
  fi
done
echo "PERM_OK $SVC_USER 可读 .opencode 工具链"

sudo systemctl restart "$SERVICE"
sleep 2
state="$(systemctl is-active "$SERVICE" || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || echo ERR)"
echo "$tag $sha $(date -u +%s) release files=$(wc -l < "$r_exp") service=$state http=$code" | sudo tee -a "$HISTORY_LOG" >/dev/null
if [ "$state" != "active" ]; then echo "SERVICE_NOT_ACTIVE state=$state"; sudo journalctl -u "$SERVICE" -n 20 --no-pager >&2; exit 1; fi
case "$code" in 200|401) echo "VERIFY_OK service=active http=$code files=$(wc -l < "$r_exp")";; *) echo "HEALTH_UNEXPECTED http=$code"; exit 1;; esac
rm -f "$r_tar" "$r_exp" /tmp/oc-actual.txt /tmp/oc-extras.txt
REMOTE
  log "release 完成：$tag"
}

cmd_rollback() {
  preflight_local
  log "== rollback：回复最新一份 opencode-*-pre.tgz =="
  remote_stdin bash -s -- "$VPS_DIR" "$BACKUP_DIR" "$SERVICE" "$HEALTH_URL" "$HISTORY_LOG" "$OWNER" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; BACKUP_DIR="$2"; SERVICE="$3"; HEALTH_URL="$4"; HISTORY_LOG="$5"; OWNER="$6"
SCOPE=(tools lib skills plugin)
CONFIGS=(opencode.json package.json bun.lock package-lock.json)
latest="$(sudo ls -1t "$BACKUP_DIR"/opencode-*-pre.tgz 2>/dev/null | head -1 || true)"
[ -n "$latest" ] || { echo "NO_BACKUP"; exit 1; }
echo "ROLLBACK_FROM $latest"
# 先清手维护子集，再还原（清掉现有 extras，回滚才是真的回到备份状态）
sudo rm -rf $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done)
sudo tar -xzf "$latest" -C "$VPS_DIR"
sudo chown -R "$OWNER" $(for d in "${SCOPE[@]}"; do echo "$VPS_DIR/$d"; done) 2>/dev/null || true
for c in "${CONFIGS[@]}"; do sudo chown "$OWNER" "$VPS_DIR/$c" 2>/dev/null || true; done
# workspace 根设定档随同一版备份还原
agents_bak="${latest%-pre.tgz}-pre-AGENTS.md"
if sudo test -f "$agents_bak"; then
  sudo install -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$agents_bak" "$(dirname "$VPS_DIR")/AGENTS.md"
  echo "AGENTS_RESTORED $(dirname "$VPS_DIR")/AGENTS.md"
fi
sudo systemctl restart "$SERVICE"; sleep 2
state="$(systemctl is-active "$SERVICE" || true)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || echo ERR)"
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
