#!/usr/bin/env bash
# gateway-release.sh — VPS agent-gateway 版本化发布 / 回滚
#   release dir（commit SHA＋时间戳）＋ md5 清单 manifest ＋ 原子 symlink 切换 ＋ rollback 回上一版
#
# 用法：
#   bash deploy/vps/gateway-release.sh status            # 看生产现在跑哪一版（唯读）
#   bash deploy/vps/gateway-release.sh release [--sha <commit>] [--files <路径>...] [--skip-recon] [--dry-run] [--force]
#   bash deploy/vps/gateway-release.sh rollback [--dry-run] [--force]
#   bash deploy/vps/gateway-release.sh adopt [--dry-run]  # 一次性：把实体目录改成受管 symlink
#
# F8（2026-10-04）断面 A｜重启前 drain（默认开启；release / rollback 生效）：
#   调用远端 deploy.sh（重启 agent-gateway）之前先只读探测在途回合/子代理，有则轮询等
#   到清空（上界 180s）；到上界仍未清空 → 默认中止，加 --force 跳过。判据与
#   opencode-release.sh 完全同套（gateway sessions.db lastTurnActiveAt / subagent_reworks
#   ＋ opencode.db 未 completed 的流式 assistant 讯息）。
#
# 为什么存在：过去「生产跑的是哪一版」只能事后取证（Vercel files API 比 md5、逐 chunk grep），
#   而 alias 曾 34 小时未更新、跑的是旧部署（memory mapay-fee-rejection-fix-0920），
#   「HEAD 已修」≠「生产在跑」是常态风险（memory uncommitted-deploy-production-fork-0920）。
#   本脚本让每次闸道部署留下不可变的 release 目录，于是
#   「哪一版在跑」= `readlink -f /opt/agent-harness/gateway`，回滚 = 切 symlink 回上一版。
#
# 设计约束（来自现场，非发明）：
#   1. 只上已 commit 的档：release 内容由 `git archive <sha> deploy-staging/gateway` 产生。
#      工作区未 commit 的改动永远进不了 release → 正面解掉「未 commit 部署＝生产分叉」。
#   2. 不做整目录盲同步：上传的是「某个 commit 的快照」，不是当前工作区，
#      因此不会把并行路线的未完成工作推上生产（memory 闸道部署配方的核心教训）。
#   3. 顺带结构性消除一个静默雷：release 目录 = 该 commit 的完整档案集，不会有旧档残留
#      掩蔽新目录（extensionless `workflow-templates.ts` 掩蔽 `workflow-templates/`，
#      见 memory template-monolith-split-0920）。
#   4. 权限：gateway/ 为 ubuntu:ubuntu，但其下 workflow-templates/ 为 root:root
#      → 远端一律经 /tmp 中转 + `sudo install -o ubuntu -g ubuntu -m 644 -D` 逐档落地，
#      不直接 scp 进目标目录。
#   5. 服务闸门重用既有轮子：`sudo /opt/agent-harness/deploy.sh`
#      （flock 排他锁 + bun build 语法闸 + restart + healthz）。本脚本不重写它。
#   6. 部署前必跑既有 recon：deploy-staging/vps-tools/vps-gateway-recon.sh
#      （memory arch-debt-closeout-0920 铁律）。本脚本不重写它，只调用它。
#
# ⚠️ 未验证假设（本脚本只在本机做过 `bash -n` 与 `--dry-run`，从未对生产执行）：
#   A. /opt/agent-harness/gateway 推测是「实体目录」而非 symlink
#      → 首次使用需人工确认后跑 `adopt`（把现况封存成 baseline release 再换成 symlink）。
#   B. deploy.sh 是否以硬编路径 /opt/agent-harness/gateway 为工作根。若它 cd 进该路径或
#      bun build 该路径下的 index.ts，symlink 不影响它；若它自行做目录归属/比对检查则需先读它。
#   C. systemd unit（agent-gateway）的 WorkingDirectory / ExecStart 是否走同一路径。
#   D. `mv -T` 需与目标同档案系统；releases 与 gateway 同在 /opt/agent-harness 下，理应成立。
#   E. 远端有 GNU coreutils（md5sum / mv -T / ln -sfn / install -D）与 curl。
#   F. /opt/agent-harness/deploy.sh 需 sudo，且会撞到 /tmp/deploy-gate-*.js 残档 EACCES
#      （memory arch-debt-closeout-0920 的雷）；本脚本不代清，失败时人工依该记忆处理。
#   G. `adopt` 的 mv→ln 之间有一个短暂视窗（该路径不存在）。未对生产验证。
set -euo pipefail

# ── 可覆写参数（env 前缀 GW_）────────────────────────────────────────────
SSH_KEY="${GW_SSH_KEY:-$HOME/.ssh/new.pem}"
SSH_TARGET="${GW_SSH_TARGET:-ubuntu@43.172.85.76}"
SSH_PORT="${GW_SSH_PORT:-22443}"
HARNESS_ROOT="${GW_HARNESS_ROOT:-/opt/agent-harness}"
GATEWAY_PATH="${GW_GATEWAY_PATH:-$HARNESS_ROOT/gateway}"
RELEASES_DIR="${GW_RELEASES_DIR:-$HARNESS_ROOT/releases/gateway}"
DEPLOY_GATE="${GW_DEPLOY_GATE:-sudo $HARNESS_ROOT/deploy.sh}"
HEALTH_URL="${GW_HEALTH_URL:-http://127.0.0.1:8081/healthz}"
OWNER="${GW_OWNER:-ubuntu:ubuntu}"
# 执行时状态（SQLite 会话库、记忆游标/批次）不属于任何 commit，必须与代码目录分离。
# release 目录只放 symlink 指向此处，否则每次发布都会把 41MB 的 sessions.db 换掉。
STATE_DIR="${GW_STATE_DIR:-$HARNESS_ROOT/state}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_SUBDIR="deploy-staging/gateway"
RECON_SCRIPT="$REPO_ROOT/deploy-staging/vps-tools/vps-gateway-recon.sh"

DRY_RUN=0
SKIP_RECON=0
SKIP_MEDIA_WF_COVERAGE=0
FORCE=0
SHA=""
EXPLICIT_FILES=()

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# 远端脚本一律用「引号 heredoc + 位置参数」传值（不用无引号 heredoc 内插，
# 因为远端变数与本地变数同名时会静默取到本地值）。顺序固定如下：
#   $1 HARNESS_ROOT  $2 GATEWAY_PATH  $3 RELEASES_DIR  $4 OWNER  $5 HEALTH_URL  $6... 各命令附加
remote_args() { printf '%s\n' "$HARNESS_ROOT" "$GATEWAY_PATH" "$RELEASES_DIR" "$OWNER" "$HEALTH_URL"; }

run_remote() {
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN ssh: $*"; return 0; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

# 带 stdin 的远端执行。--dry-run 时把远端脚本原样印出（可另存后 bash -n 检查），不连线。
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

# 二进位 tar 上传。--dry-run 只吞掉 stdin 并报位元组数（不把 tar 二进位印到终端）。
run_remote_binary() {
  if [ "$DRY_RUN" -eq 1 ]; then
    local n
    n="$(wc -c)"
    log "DRY-RUN ssh(binary): $* (stdin $n bytes)"
    return 0
  fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$@"
}

# ── F8（2026-10-04）断面 A：agent-gateway 重启前的 drain（只读）─────────────
# 与 opencode-release.sh 同一套判据/上界（见该脚本 F8 段注释；三路只读信号）。
# gateway 重启虽由会话 N1 自动重投主 turn（sessions-core.ts），但会杀掉 async 子代理
# watcher（孤儿化，需断面 B 兜底），故同样在 deploy.sh 闸门前先 drain。
# 命中在途 → 轮询到清空；上界后仍非空 → 回传码 3（呼叫端中止；--force 跳过）。
run_drain_gate() {
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN drain gate（跳过远端只读探测）"; return 0; fi
  run_remote_stdin bash -s -- "$FORCE" \
    "${OC_DRAIN_MAX_SECS:-180}" "${OC_DRAIN_POLL_SECS:-5}" "${OC_DRAIN_WINDOW_MS:-180000}" \
    "${OC_DRAIN_SESSIONS_DB:-/opt/agent-harness/state/sessions.db}" \
    "${OC_DRAIN_OPENCODE_DB:-/opt/agent-harness/workspace/.local/share/opencode/opencode.db}" <<'REMOTE'
set -euo pipefail
DRAIN_FORCE="${1:-0}"
DRAIN_MAX_SECS="${2:-180}"
DRAIN_POLL_SECS="${3:-5}"
DRAIN_WINDOW_MS="${4:-180000}"
DRAIN_SESSIONS_DB="${5:-/opt/agent-harness/state/sessions.db}"
DRAIN_OPENCODE_DB="${6:-/opt/agent-harness/workspace/.local/share/opencode/opencode.db}"
drain_inflight_count() {
  local now a b c v
  now=$(( $(date +%s) * 1000 ))
  a="$(sudo sqlite3 -cmd '.timeout 3000' "$DRAIN_SESSIONS_DB" \
    "SELECT COUNT(*) FROM sessions WHERE json_extract(data,'\$.lastTurnActiveAt') > 0 AND ($now - json_extract(data,'\$.lastTurnActiveAt')) < $DRAIN_WINDOW_MS;" 2>/dev/null || echo ERR)"
  b="$(sudo sqlite3 -cmd '.timeout 3000' "$DRAIN_SESSIONS_DB" "SELECT COUNT(*) FROM subagent_reworks;" 2>/dev/null || echo ERR)"
  c="$(sudo sqlite3 -cmd '.timeout 3000' "$DRAIN_OPENCODE_DB" \
    "SELECT COUNT(*) FROM message WHERE json_extract(data,'\$.role')='assistant' AND json_extract(data,'\$.time.completed') IS NULL AND ($now - time_updated) < $DRAIN_WINDOW_MS;" 2>/dev/null || echo ERR)"
  for v in "$a" "$b" "$c"; do case "$v" in ''|*[!0-9]*) echo ERR; return 0;; esac; done
  echo $(( a + b + c ))
}
if [ "$DRAIN_FORCE" = "1" ]; then
  echo "DRAIN_SKIPPED (--force)"
else
  drain_waited=0
  while :; do
    drain_n="$(drain_inflight_count)"
    if [ "$drain_n" = "ERR" ]; then
      echo "DRAIN_PROBE_ERR 只读探测失败（sqlite/DB 不可读）→ 保守放行（fail-open，请人工确认）"; break
    fi
    if [ "$drain_n" = "0" ]; then echo "DRAIN_CLEAR waited=${drain_waited}s"; break; fi
    if [ "$drain_waited" -ge "$DRAIN_MAX_SECS" ]; then
      echo "DRAIN_TIMEOUT inflight=$drain_n waited=${drain_waited}s limit=${DRAIN_MAX_SECS}s — 默认中止部署；确需立即重启请加 --force"
      exit 3
    fi
    echo "DRAIN_WAIT inflight=$drain_n waited=${drain_waited}s / ${DRAIN_MAX_SECS}s"
    sleep "$DRAIN_POLL_SECS"; drain_waited=$(( drain_waited + DRAIN_POLL_SECS ))
  done
fi
REMOTE
}

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

子命令：
  status                  唯读：印出生产目前指向的 release、meta、manifest 校验结果、healthz
  release [--sha C] [--files F...] [--skip-recon] [--skip-media-wf-coverage] [--dry-run] [--force]
                          发布：git archive 该 commit 的 deploy-staging/gateway → release 目录
                          → md5 manifest → 原子切 symlink → drain 闸门 + deploy.sh 闸门 → 验证
                          ⚠️ --files 不可用于本 gateway：release 目录必须是完整档案集，
                             只放改动档会让目录缺 index.ts（切换前会被起跑闸拦下）。
                          --force：跳过重启前 drain（仍有在途会话时也立即重启）
  rollback [--dry-run] [--force]
                          回滚：切 symlink 回上一个 release → drain + 同一道 deploy.sh 闸门 → 验证
  adopt [--dry-run]       一次性：把实体 /opt/agent-harness/gateway 封存成 baseline release
                          并换成受管 symlink（此后 release/rollback 才可用）

环境可覆写：GW_SSH_KEY GW_SSH_TARGET GW_SSH_PORT GW_HARNESS_ROOT GW_GATEWAY_PATH
            GW_RELEASES_DIR GW_DEPLOY_GATE GW_HEALTH_URL GW_OWNER
            GW_DRY_REMOTE_LOG（--dry-run 时把远端脚本另存到该档，供 bash -n 检查）
EOF
}

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --skip-recon) SKIP_RECON=1 ;;
      --skip-media-wf-coverage) SKIP_MEDIA_WF_COVERAGE=1 ;;
      --force) FORCE=1 ;;
      --sha) shift; SHA="${1:-}"; [ -n "$SHA" ] || die "--sha 需要值" ;;
      --files)
        shift
        while [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; do EXPLICIT_FILES+=("$1"); shift; done
        continue ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数：$1" ;;
    esac
    shift
  done
}

preflight_local() {
  [ -f "$SSH_KEY" ] || die "SSH key 不存在：$SSH_KEY"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "$REPO_ROOT 不是 git repo"
}

# 根因守门：deploy-staging/gateway 有未 commit 改动时禁止发布。
# 这正是「未 commit 部署＝生产分叉」的入口（memory uncommitted-deploy-production-fork-0920）。
assert_gateway_tree_clean() {
  local dirty
  dirty="$(git -C "$REPO_ROOT" status --porcelain -- "$SRC_SUBDIR")"
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty" >&2
    die "$SRC_SUBDIR 有未 commit 改动 → 拒绝发布（未 commit 部署＝生产分叉的根因）。先 commit。"
  fi
}

# 既有轮子：部署前 recon 对账（0=一致 1=漂移 2=故障）
# 现行 release 的 GIT_SHA（recon 的正确基准：生产是否仍等于上次发出的那一版）
current_release_sha() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" \
    "m=\$(dirname \$(readlink -f '$GATEWAY_PATH' 2>/dev/null))/meta.env; sed -n 's/^GIT_SHA=//p' \"\$m\" 2>/dev/null" 2>/dev/null | head -1
}


# 2026-10-11 修画布：近 N 天媒体会话 workflow_write 覆盖率发版门（默认 7 天 ≥15%）。
# 只读查 VPS ledger + opencode.db；样本不足（<5）跳过不挡。可用 --skip-media-wf-coverage 跳过。
run_media_wf_coverage() {
  [ "$SKIP_MEDIA_WF_COVERAGE" -eq 1 ] && { log "SKIP media workflow_write coverage（--skip-media-wf-coverage）"; return 0; }
  local script="$REPO_ROOT/tools/check-media-workflow-write-coverage.py"
  [ -f "$script" ] || die "找不到覆盖率脚本：$script"
  log "== 媒体会话 workflow_write 覆盖率发版门 =="
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: 将在 VPS 跑 check-media-workflow-write-coverage.py"
    return 0
  fi
  # 上传脚本到远端临时档再跑（避免依赖生产树是否已含新档）
  local remote_py="/tmp/check-media-workflow-write-coverage.$$.py"
  run_remote_binary "cat > $remote_py" < "$script" || die "上传覆盖率脚本失败"
  if ! run_remote "MEDIA_WF_DAYS=${MEDIA_WF_DAYS:-7} MEDIA_WF_MIN_COVERAGE=${MEDIA_WF_MIN_COVERAGE:-0.15} python3 $remote_py; ec=\$?; rm -f $remote_py; exit \$ec"; then
    die "媒体会话 workflow_write 覆盖率未过门槛（见 tools/check-media-workflow-write-coverage.py；临时跳过加 --skip-media-wf-coverage）"
  fi
  log "media workflow_write coverage PASS"
}

run_recon() {
  [ "$SKIP_RECON" -eq 1 ] && { log "SKIP recon（--skip-recon）"; return 0; }
  [ -f "$RECON_SCRIPT" ] || die "找不到 recon 脚本：$RECON_SCRIPT"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN local: bash $RECON_SCRIPT"; return 0; fi
  local base
  base="$(current_release_sha)"
  case "$base" in ""|unknown-baseline) base="HEAD";; esac
  log "== 既有 recon 对账（挡漂移；基准 $base）=="
  if ! RECON_BASE="$base" bash "$RECON_SCRIPT"; then
    die "recon 未通过（生产被手改或连线故障）→ 先 diff 收编再发布（deploy-staging/vps-tools/vps-gateway-recon.sh）"
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
  log "== adopt：$GATEWAY_PATH（实体目录）→ symlink → $RELEASES_DIR/$rel/files =="
  log "⚠️ 一次性、对生产有实质影响的操作；本脚本从未对生产验证过，请人工确认后再跑。"
  local -a RA
  mapfile -t RA < <(remote_args)
  run_remote_stdin bash -s -- "${RA[@]}" "$rel" "$STATE_DIR" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"; rel="$6"; STATE_DIR="$7"
STATE_ITEMS=(sessions.db sessions.db-shm sessions.db-wal memory-cursor.json memory-batches)
if [ -L "$GATEWAY_PATH" ]; then echo "ALREADY_ADOPTED"; exit 0; fi
[ -d "$GATEWAY_PATH" ] || { echo "NO_GATEWAY_DIR: $GATEWAY_PATH"; exit 1; }
sudo mkdir -p "$RELEASES_DIR/$rel"
sudo mv "$GATEWAY_PATH" "$RELEASES_DIR/$rel/files"
sudo ln -s "$RELEASES_DIR/$rel/files" "$GATEWAY_PATH"
sudo chown -h "$OWNER" "$GATEWAY_PATH" 2>/dev/null || true
sudo chown -R "$OWNER" "$RELEASES_DIR/$rel" 2>/dev/null || true

# 状态与代码分离：把执行时状态集中到 $STATE_DIR，release 目录只留 symlink。
# 首次（此处）＝迁移；之后每次 release 只是重建同一组 symlink，资料不随版本搬移，
# 因此回滚到 baseline 也仍读到同一份会话库，不会回退成空库。
sudo mkdir -p "$STATE_DIR"
for it in "${STATE_ITEMS[@]}"; do
  if [ -e "$RELEASES_DIR/$rel/files/$it" ] && [ ! -e "$STATE_DIR/$it" ]; then
    sudo mv "$RELEASES_DIR/$rel/files/$it" "$STATE_DIR/$it"
  fi
  if [ -e "$STATE_DIR/$it" ]; then
    sudo ln -sfn "$STATE_DIR/$it" "$RELEASES_DIR/$rel/files/$it"
  fi
done
sudo chown -R "$OWNER" "$STATE_DIR" 2>/dev/null || true

cd "$RELEASES_DIR/$rel/files"
find . -type f -print0 | sort -z | xargs -0 md5sum > "../manifest.md5"
{
  echo "RELEASE_ID=$rel"
  echo "GIT_SHA=unknown-baseline"
  echo "CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "FILE_COUNT=$(wc -l < ../manifest.md5)"
  echo "NOTE=adopted-baseline（非 commit 快照；内容为 adopt 当下的生产目录，可能含漂移）"
} > "../meta.env"
echo "$rel unknown-baseline $(date -u +%s) adopt" | sudo tee -a "$RELEASES_DIR/history.log" >/dev/null
echo "ADOPTED current=$(readlink -f "$GATEWAY_PATH")"
REMOTE
  if [ "$DRY_RUN" -eq 0 ]; then
    log "== adopt 后跑既有服务闸门（确认 symlink 路径仍可服务）=="
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
    || die "无法解析 commit：${SHA:-HEAD}"
  sha_short="$(git -C "$REPO_ROOT" rev-parse --short=12 "$sha_full")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  rel="$sha_short-$ts"

  if [ "${#EXPLICIT_FILES[@]}" -gt 0 ]; then
    for f in "${EXPLICIT_FILES[@]}"; do
      case "$f" in "$SRC_SUBDIR"/*) ;; *) die "--files 必须是 $SRC_SUBDIR/ 下的路径：$f" ;; esac
      git -C "$REPO_ROOT" cat-file -e "$sha_full:$f" 2>/dev/null || die "该 commit 不含此档：$f"
    done
    log "== 精准发布（--files，${#EXPLICIT_FILES[@]} 档）：$sha_short → $rel =="
  else
    log "== 完整快照发布：$SRC_SUBDIR @ $sha_short → $rel =="
    log "   （git archive 该 commit 的完整档案集：不含工作区未 commit 改动，也不会有旧档残留）"
  fi

  run_recon
  run_media_wf_coverage

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
  run_remote_stdin bash -s -- "${RA[@]}" "$rel" "$sha_full" "$sha_short" "$stage_tar" "$stage_dir" "$STATE_DIR" <<'REMOTE'
set -euo pipefail
HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"
rel="$6"; sha_full="$7"; sha_short="$8"; stage_tar="$9"; stage_dir="${10}"; STATE_DIR="${11}"
STATE_ITEMS=(sessions.db sessions.db-shm sessions.db-wal memory-cursor.json memory-batches)

if [ ! -L "$GATEWAY_PATH" ]; then
  echo "NOT_ADOPTED: $GATEWAY_PATH 不是 symlink → 先跑 adopt（见脚本头部假设 A）"
  exit 1
fi

REL_DIR="$RELEASES_DIR/$rel"
sudo mkdir -p "$REL_DIR/files" "$stage_dir"
# $REL_DIR 由 sudo mkdir 建立＝root 所有，但 manifest.md5／meta.env 是后续「非 sudo」写入
# （adopt 没踩到，因为它是 mv 进来的目录、保有原 owner；release 是新建目录）。
# 先把 $REL_DIR 交给 ubuntu，写入与后续 rollback 的读取都一致。
sudo chown "$OWNER" "$REL_DIR"
# --strip-components=2：tar 内路径为 deploy-staging/gateway/<档>，剥掉两层后 files/ 即 gateway 根
sudo tar -xf "$stage_tar" -C "$stage_dir" --strip-components=2
sudo chown -R "$OWNER" "$stage_dir"

# 逐档 sudo install（-D 建父目录），owner/mode 与既有档一致：-rw-r--r-- ubuntu ubuntu
cd "$stage_dir"
while IFS= read -r -d '' f; do
  sudo install -D -o "${OWNER%%:*}" -g "${OWNER##*:}" -m 644 "$f" "$REL_DIR/files/$f"
done < <(find . -type f -print0)
cd /
rm -rf "$stage_dir" "$stage_tar"

# 状态与代码分离：新 release 目录不放真实状态档，只放指向 $STATE_DIR 的 symlink。
# 若 $STATE_DIR 尚无该项（例如 adopt 前就已存在的旧状态），从当前 release 目录迁移一次。
CUR_DIR="$(readlink -f "$GATEWAY_PATH" 2>/dev/null || true)"
sudo mkdir -p "$STATE_DIR"
for it in "${STATE_ITEMS[@]}"; do
  if [ ! -e "$STATE_DIR/$it" ] && [ -n "$CUR_DIR" ] && [ -e "$CUR_DIR/$it" ]; then
    sudo mv "$CUR_DIR/$it" "$STATE_DIR/$it"
  fi
  if [ -e "$STATE_DIR/$it" ]; then
    sudo ln -sfn "$STATE_DIR/$it" "$REL_DIR/files/$it"
  fi
done
sudo chown -R "$OWNER" "$STATE_DIR" 2>/dev/null || true

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

# 起跑闸（2026-10-05 事故后加）：release 目录必须是**完整树**——入口点 index.ts 必须在。
# 事故：用 `--files` 精准发布只把 3 个改动档放进新 release 目录，symlink 已经切过去、
# 直到 deploy.sh 的 bun build 才以 ModuleNotFound 拦下重启 ⇒ 生产停在「symlink 指向只有
# 8 档的目录、进程靠内存里的旧码还活着」的半截状态，此刻任何按需模块解析都会炸。
# 切换前拦：不切 symlink、不动服务，磁盘上只留一个废弃 release 目录。
if [ ! -f "$REL_DIR/files/index.ts" ]; then
  echo "PARTIAL_RELEASE_MISSING_ENTRYPOINT: $REL_DIR/files 缺 index.ts。" >&2
  echo "  本 gateway 的 release 目录＝完整档案集，--files 精准发布无法满足（列全所有依赖也不现实）。" >&2
  echo "  请改用完整快照发布（不带 --files）；本次未切换 symlink、未重启服务。" >&2
  exit 1
fi

# 原子切换：先建 next symlink，再 mv -T 一次性 rename 覆盖（同档案系统）
sudo ln -sfn "$REL_DIR/files" "$HARNESS_ROOT/.gateway-link.next"
sudo mv -T "$HARNESS_ROOT/.gateway-link.next" "$GATEWAY_PATH"

echo "$rel $sha_full $(date -u +%s) release" | sudo tee -a "$RELEASES_DIR/history.log" >/dev/null
echo "SWITCHED current=$(readlink -f "$GATEWAY_PATH") files=$FILE_COUNT"
REMOTE

  if [ "$DRY_RUN" -eq 0 ]; then
    log "== 既有服务闸门：$DEPLOY_GATE =="
    if ! run_drain_gate; then die "部署前 drain 未通过：仍有在途会话（等它收束后重试，或加 --force 立即重启）"; fi
    run_remote "$DEPLOY_GATE"
    verify_release "$RELEASES_DIR/$rel/files"
  fi
  log "release 完成：$rel"
}

# ── rollback ────────────────────────────────────────────────────────────
cmd_rollback() {
  preflight_local
  log "== rollback：切回上一个 release =="
  local -a RA
  mapfile -t RA < <(remote_args)

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN：略过「解析上一个 release」（需连线读 releases 目录）"
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
    log "rollback dry-run 结束（未连线、未切换）"
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
  [ -n "$prev" ] || die "取不到上一个 release（rollback 目标为空）"
  log "rollback 目标：$prev"

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

  log "== 既有服务闸门：$DEPLOY_GATE =="
  if ! run_drain_gate; then die "回滚前 drain 未通过：仍有在途会话（等它收束后重试，或加 --force 立即重启）"; fi
  run_remote "$DEPLOY_GATE"
  verify_release "$RELEASES_DIR/$prev/files"
  log "rollback 完成：$prev"
}

# ── 收尾验证（symlink 指向 + manifest + healthz）─────────────────────────
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
  log "⚠️ VERIFY_OK 只证明「切到预期的 release 且服务起来了」，不证明功能可用（要打真端点）。"
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
