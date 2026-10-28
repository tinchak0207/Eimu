#!/usr/bin/env bash
# gateway-release.sh — VPS agent-gateway 版本化发布 / 回滚
#   release dir（commit SHA＋时间戳）＋ md5 清单 manifest ＋ 原子 symlink 切换 ＋ rollback 回上一版
#
# 用法：
#   bash deploy/vps/gateway-release.sh status            # 看生产现在跑哪一版（唯读）
#   bash deploy/vps/gateway-release.sh release [--sha <commit>] [--skip-recon] [--dry-run] [--force] [--fast]
#   bash deploy/vps/gateway-release.sh rollback [--dry-run] [--force]
#   bash deploy/vps/gateway-release.sh adopt [--dry-run]  # 一次性：把实体目录改成受管 symlink
#
# F8（2026-10-04）断面 A｜重启前 drain（默认开启；release / rollback 生效）：
#   调用远端 deploy.sh（重启 agent-gateway）之前先只读探测在途回合/子代理，有则轮询等
#   到清空（上界 180s）；到上界仍未清空 → 默认中止，加 --force 跳过。判据与
#   opencode-release.sh 完全同套（gateway sessions.db lastTurnActiveAt / subagent_reworks
#   ＋ opencode.db 未 completed 的流式 assistant 讯息）。
#
# --fast（2026-10-19）：等价 --skip-recon --force，跳过 recon 与 drain，立即 build+重启。
#   用于提示词/文案这类短改：目标 <60s，不再为在途回合等 180s。中断的回合由耐久续接处理。
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
ACTIVATION_LOCK="${HARNESS_ACTIVATION_LOCK:-$HARNESS_ROOT/.harness-activation.lock}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_SUBDIR="deploy-staging/gateway"
RECON_SCRIPT="$REPO_ROOT/deploy-staging/vps-tools/vps-gateway-recon.sh"

DRY_RUN=0
SKIP_RECON=0
SKIP_MEDIA_WF_COVERAGE=0
FORCE=0
SHA=""

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
  local command
  if [ "$#" -gt 1 ]; then printf -v command '%q ' "$@"; else command="$1"; fi
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" "$command"
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
# 一份 drain 实现；OpenCode 发布通过内部 __emit-drain 入口复用。
drain_gate() {
DRAIN_FORCE="${1:-0}"
DRAIN_MAX_SECS="${2:-180}"
DRAIN_POLL_SECS="${3:-5}"
DRAIN_WINDOW_MS="${4:-180000}"
DRAIN_SESSIONS_DB="${5:-/opt/agent-harness/state/sessions.db}"
DRAIN_OPENCODE_DB="${6:-/opt/agent-harness/workspace/.local/share/opencode/opencode.db}"
drain_inflight_count() {
  local now a b c v
  now=$(( $(date +%s) * 1000 ))
  a="$(sudo sqlite3 -readonly -cmd '.timeout 3000' "$DRAIN_SESSIONS_DB" \
    "SELECT COUNT(*) FROM sessions WHERE json_extract(data,'\$.lastTurnActiveAt') > 0 AND ($now - json_extract(data,'\$.lastTurnActiveAt')) < $DRAIN_WINDOW_MS;" 2>/dev/null || echo ERR)"
  b="$(sudo sqlite3 -readonly -cmd '.timeout 3000' "$DRAIN_SESSIONS_DB" "SELECT COUNT(*) FROM subagent_reworks;" 2>/dev/null || echo ERR)"
  c="$(sudo sqlite3 -readonly -cmd '.timeout 3000' "$DRAIN_OPENCODE_DB" \
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
      echo "DRAIN_PROBE_ERR 只读探测失败（sqlite/DB 不可读）→ 中止部署；明确跳过请加 --force"; exit 3
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
}

# 复用既有 maintenance 布尔；同表所有权记录只用于 finally 与下次激活恢复原值。
maintenance_control() {
  python3 - "$1" "$2" "${3:-}" "$ACTIVATION_LOCK" <<'MAINTENANCE'
import json, sqlite3, sys, uuid
from urllib.parse import quote
path, action, token, lock = sys.argv[1:]
c=sqlite3.connect('file:'+quote(path)+'?mode=rw',uri=True,isolation_level=None,timeout=5)
c.execute('BEGIN IMMEDIATE')
try:
    row=c.execute("SELECT value FROM generation_runtime_control WHERE name='deployment-maintenance'").fetchone()
    if action=='begin':
        current=c.execute("SELECT value FROM generation_runtime_control WHERE name='maintenance'").fetchone()
        if row:
            lease=json.loads(row[0])
            if lease['lock']!=lock: raise RuntimeError('maintenance owner uses another activation lock')
            original=lease['original']
            print('MAINTENANCE_RECLAIMED previous interrupted activation',file=sys.stderr)
        else: original=None if current is None else current[0]
        if original not in (None,'0','1'): raise RuntimeError('invalid original maintenance value')
        token=uuid.uuid4().hex
        c.execute("INSERT INTO generation_runtime_control(name,value) VALUES('deployment-maintenance',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",(json.dumps({'owner':token,'original':original,'lock':lock}),))
        c.execute("INSERT INTO generation_runtime_control(name,value) VALUES('maintenance','1') ON CONFLICT(name) DO UPDATE SET value='1'")
    else:
        if not row: raise RuntimeError('maintenance owner missing')
        lease=json.loads(row[0])
        if lease['owner']!=token or lease['lock']!=lock: raise RuntimeError('maintenance ownership changed')
        if lease['original'] is None: c.execute("DELETE FROM generation_runtime_control WHERE name='maintenance'")
        else: c.execute("UPDATE generation_runtime_control SET value=? WHERE name='maintenance'",(lease['original'],))
        c.execute("DELETE FROM generation_runtime_control WHERE name='deployment-maintenance'")
    c.execute('COMMIT')
except:
    c.execute('ROLLBACK'); raise
if action=='begin': print(token)
MAINTENANCE
}
maintenance_begin() {
  MAINT_DB="$1"
  MAINT_TOKEN="$(maintenance_control "$MAINT_DB" begin)"
}
maintenance_end() {
  if [ -n "${MAINT_TOKEN:-}" ]; then
    maintenance_control "$MAINT_DB" end "$MAINT_TOKEN" || return 1
    MAINT_TOKEN=""
  fi
}

gateway_prepare() {
  HARNESS_ROOT="$1"; GATEWAY_PATH="$2"; RELEASES_DIR="$3"; OWNER="$4"; HEALTH_URL="$5"
  local expected="$6" actual
  DEPLOY_GATE="$7"
  actual="$(gateway_identity "$GATEWAY_PATH")"
  [ "$actual" = "$expected" ] || { echo "ACTIVATION_CONFLICT expected=$expected actual=$actual" >&2; exit 76; }
  trap 'gateway_recover $?' EXIT
  trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
  maintenance_begin "${12}"
  drain_gate "${@:8:6}"
  # 维护/共享锁已持有；recent 时间窗不能替代执行端真实空闲。
  sudo python3 - <<'PY'
import base64, json, subprocess, urllib.request
pid = subprocess.check_output(['systemctl', 'show', 'agent-gateway', '-p', 'MainPID', '--value'], text=True).strip()
env = dict(v.split(b'=', 1) for v in open('/proc/' + pid + '/environ', 'rb').read().split(b'\0') if b'=' in v)
origin = env.get(b'OPENCODE_URL', b'http://127.0.0.1:4096').decode().rstrip('/')
auth = 'Basic ' + base64.b64encode(b'opencode:' + env.get(b'OPENCODE_PASSWORD', b'')).decode()
states = json.load(urllib.request.urlopen(urllib.request.Request(origin + '/session/status', headers={'Authorization': auth}), timeout=8))
if not isinstance(states, dict) or any(not k.startswith('ses_') or not isinstance(v, dict) or v.get('type') not in ['idle', 'busy', 'retry'] for k, v in states.items()):
    raise SystemExit('OPENCODE_ACTIVITY_UNKNOWN: activation refused')
active = sum(v['type'] != 'idle' for v in states.values())
if active:
    raise SystemExit('OPENCODE_NOT_IDLE: activation refused count=' + str(active))
print('OPENCODE_IDLE_CONFIRMED under maintenance and activation lock')
PY
}

gateway_identity() {
  if [ -L "$1" ]; then printf 'link:%s\n' "$(readlink -f "$1")";
  elif [ -d "$1" ]; then stat -c 'directory:%d:%i' "$1";
  else echo "MISSING_GATEWAY" >&2; return 1; fi
}

capture_gateway_identity() {
  if [ "$DRY_RUN" -eq 1 ]; then echo dry-run; return; fi
  { declare -f gateway_identity; printf 'gateway_identity "$1"\n'; } \
    | run_remote_stdin bash -s -- "$GATEWAY_PATH"
}

gateway_verify() {
  [ "$(readlink -f "$GATEWAY_PATH")" = "$1" ] || return 1
  (cd "$1" && md5sum -c ../manifest.md5 --quiet) || return 1
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null)" || return 1
  [ "$code" = 200 ] || { echo "HEALTH_UNEXPECTED http=$code" >&2; return 1; }
  echo "VERIFY_OK current=$1 manifest=OK healthz=200"
}

gateway_recover() {
  local rc="$1"
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "${GW_CHANGED:-0}" -eq 1 ]; then
    set +e
    if ln -sfn "$GW_OLD" "$HARNESS_ROOT/.gateway-link.next" \
      && mv -T "$HARNESS_ROOT/.gateway-link.next" "$GATEWAY_PATH" \
      && bash -c "$DEPLOY_GATE" && gateway_verify "$GW_OLD"; then
      echo "RECOVERY_OK gateway=$GW_OLD original_exit=$rc" >&2
    else
      echo "RECOVERY_FAILED gateway=$GW_OLD original_exit=$rc — 服务恢复未证实" >&2
    fi
  fi
  if ! maintenance_end; then
    echo "MAINTENANCE_RESTORE_FAILED — 原维护状态未恢复，下次同锁激活可接续" >&2
    [ "$rc" -ne 0 ] || rc=1
  fi
  exit "$rc"
}

gateway_activate() {
  local target="$1" old="$2" record="$3" action="$4"
  GW_OLD="$old"; GW_CHANGED=0
  ln -sfn "$target" "$HARNESS_ROOT/.gateway-link.next"
  GW_CHANGED=1
  mv -T "$HARNESS_ROOT/.gateway-link.next" "$GATEWAY_PATH"
  bash -c "$DEPLOY_GATE"
  gateway_verify "$target"
  maintenance_end
  printf '%s %s %s\n' "$record" "$(date -u +%s)" "$action" >> "$RELEASES_DIR/history.log"
  GW_CHANGED=0
  trap - EXIT
}

# 锁与 deploy.sh 的内部构建锁分离，且覆盖整个远端激活与失败恢复。
run_gateway_activation() {
  local -a RA
  mapfile -t RA < <(remote_args)
  { printf 'ACTIVATION_LOCK=%q\n' "$ACTIVATION_LOCK";
    declare -f gateway_identity drain_gate maintenance_control maintenance_begin maintenance_end gateway_prepare gateway_verify gateway_recover gateway_activate; cat; } \
    | run_remote_stdin sudo flock -n -E 75 "$ACTIVATION_LOCK" bash -s -- \
      "${RA[@]}" "$GW_EXPECTED" "$DEPLOY_GATE" "$FORCE" \
      "${OC_DRAIN_MAX_SECS:-180}" "${OC_DRAIN_POLL_SECS:-5}" "${OC_DRAIN_WINDOW_MS:-180000}" \
      "${OC_DRAIN_SESSIONS_DB:-/opt/agent-harness/state/sessions.db}" \
      "${OC_DRAIN_OPENCODE_DB:-/opt/agent-harness/workspace/.local/share/opencode/opencode.db}" "$@"
}

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

子命令：
  status                  唯读：印出生产目前指向的 release、meta、manifest 校验结果、healthz
  release [--sha C] [--skip-recon] [--skip-media-wf-coverage] [--dry-run] [--force] [--fast]
                          发布：git archive 该 commit 的 deploy-staging/gateway → release 目录
                          → drain 闸门 → md5 manifest → 原子切 symlink → deploy.sh 闸门 → 验证
                          必须发布完整的已提交 commit 快照；--files 在本地立即拒绝。
                          --force：跳过重启前 drain（仍有在途会话时也立即重启）
  rollback [--dry-run] [--force]
                          回滚：drain → 切 symlink 回上一个 release → deploy.sh 闸门 → 验证
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
      --fast) SKIP_RECON=1; FORCE=1; SKIP_MEDIA_WF_COVERAGE=1 ;;
      --sha) shift; SHA="${1:-}"; [ -n "$SHA" ] || die "--sha 需要值" ;;
      --files) die "--files 已禁用：gateway 必须发布完整的已提交 commit 快照，请使用 release --sha <commit>" ;;
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
# 2026-10-14 修：手造 release 目录（yolo-*／prompt-qc-*／camera-skill-*）没有 meta.env，
# 远端 sed 读不到档返回退出码 2；`2>/dev/null` 只吞 stderr 吞不掉退出码，于是 pipefail 下
# 这里赋值失败 → 整支脚本静默 EXIT 2（2026-10-12 现场，见 memory
# 2026-10-12-gateway-release-blocked-two-gates）。`|| true` 把「读不到」收敛成空字串，
# 落到呼叫端本来就写好的 `case "$base" in ""|unknown-baseline) base="HEAD"` 分支。
current_release_sha() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  ssh -i "$SSH_KEY" -p "$SSH_PORT" -o ConnectTimeout=10 "$SSH_TARGET" \
    "m=\$(dirname \$(readlink -f '$GATEWAY_PATH' 2>/dev/null))/meta.env; sed -n 's/^GIT_SHA=//p' \"\$m\" 2>/dev/null || true" 2>/dev/null | head -1 || true
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
  local GW_EXPECTED rel
  GW_EXPECTED="$(capture_gateway_identity)" || die "无法读取当前 gateway 身份"
  rel="baseline-$(date -u +%Y%m%dT%H%M%SZ)"
  run_gateway_activation "$rel" "$STATE_DIR" <<'REMOTE'
set -euo pipefail
gateway_prepare "$@"
rel="${14}"; STATE_DIR="${15}"
if [ -L "$GATEWAY_PATH" ]; then echo "ALREADY_ADOPTED"; exit 0; fi
[ -d "$GATEWAY_PATH" ] || { echo "NO_GATEWAY_DIR"; exit 1; }
mkdir -p "$RELEASES_DIR/$rel" "$STATE_DIR"
mv "$GATEWAY_PATH" "$RELEASES_DIR/$rel/files"
# 立即建立旧内容链接；失败恢复仍指向同一份原有代码，不回滚运行状态。
ln -s "$RELEASES_DIR/$rel/files" "$GATEWAY_PATH"
for it in sessions.db sessions.db-shm sessions.db-wal memory-cursor.json memory-batches; do
  if [ -e "$RELEASES_DIR/$rel/files/$it" ] && [ ! -e "$STATE_DIR/$it" ]; then mv "$RELEASES_DIR/$rel/files/$it" "$STATE_DIR/$it"; fi
  if [ -e "$STATE_DIR/$it" ]; then ln -sfn "$STATE_DIR/$it" "$RELEASES_DIR/$rel/files/$it"; fi
done
chown -R "$OWNER" "$RELEASES_DIR/$rel" "$STATE_DIR"
(cd "$RELEASES_DIR/$rel/files" && find . -type f -print0 | sort -z | xargs -0 md5sum > ../manifest.md5)
printf 'GIT_SHA=unknown-baseline\nRELEASE_ID=%s\n' "$rel" > "$RELEASES_DIR/$rel/meta.env"
gateway_activate "$RELEASES_DIR/$rel/files" "$RELEASES_DIR/$rel/files" "$rel unknown-baseline" adopt
REMOTE
  log "adopt 完成：$rel"
}

cmd_release() {
  preflight_local
  assert_gateway_tree_clean
  local sha_full sha_short ts rel
  sha_full="$(git -C "$REPO_ROOT" rev-parse --verify "${SHA:-HEAD}^{commit}")" || die "无法解析 commit"
  if [ "$DRY_RUN" -eq 0 ]; then bun "$REPO_ROOT/tools/check-opencode-tool-schemas.mjs" --commit "$sha_full" --repo "$REPO_ROOT"; fi
  sha_short="$(git -C "$REPO_ROOT" rev-parse --short=12 "$sha_full")"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; rel="$sha_short-$ts-$$"
  local GW_EXPECTED
  GW_EXPECTED="$(capture_gateway_identity)" || die "无法读取当前 gateway 身份"
  run_recon
  # 2026-10-28 用户裁定：媒体会话 workflow_write 覆盖率不再作为发版门（run_media_wf_coverage 保留但不调用，见根因 note）。
  local stage_tar="/tmp/gw-release-$rel.tar" stage_dir="/tmp/gw-release-$rel"
  git -C "$REPO_ROOT" archive --format=tar "$sha_full" "$SRC_SUBDIR" | run_remote_binary "cat > $stage_tar"
  run_gateway_activation "$rel" "$sha_full" "$sha_short" "$stage_tar" "$stage_dir" "$STATE_DIR" <<'REMOTE'
set -euo pipefail
gateway_prepare "$@"
rel="${14}"; sha_full="${15}"; sha_short="${16}"; stage_tar="${17}"; stage_dir="${18}"; STATE_DIR="${19}"
STATE_ITEMS=(sessions.db sessions.db-shm sessions.db-wal memory-cursor.json memory-batches)
[ -L "$GATEWAY_PATH" ] || { echo "NOT_ADOPTED"; exit 1; }
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
    sudo ln -sfn "$STATE_DIR/$it" "$CUR_DIR/$it"
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


old="$(readlink -f "$GATEWAY_PATH")"
gateway_activate "$REL_DIR/files" "$old" "$rel $sha_full" release
REMOTE
  log "release 完成：$rel"
}

cmd_rollback() {
  preflight_local
  local GW_EXPECTED
  GW_EXPECTED="$(capture_gateway_identity)" || die "无法读取当前 gateway 身份"
  run_gateway_activation <<'REMOTE'
set -euo pipefail
gateway_prepare "$@"
[ -L "$GATEWAY_PATH" ] || { echo "NOT_ADOPTED"; exit 1; }
old="$(readlink -f "$GATEWAY_PATH")"
CUR="$(basename "$(dirname "$old")")"
mapfile -t RELS < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's:/$::' | xargs -n1 basename)
idx=-1
for i in "${!RELS[@]}"; do [ "${RELS[$i]}" = "$CUR" ] && { idx=$i; break; }; done
[ "$idx" -ge 0 ] || { echo "CURRENT_NOT_IN_RELEASES"; exit 1; }
next=$((idx+1))
[ "$next" -lt "${#RELS[@]}" ] || { echo "NO_PREVIOUS_RELEASE"; exit 1; }
prev="${RELS[$next]}"; PREV_DIR="$RELEASES_DIR/$prev/files"
(cd "$PREV_DIR" && md5sum -c ../manifest.md5 --quiet) || { echo "PREV_MANIFEST_FAIL"; exit 1; }
gateway_activate "$PREV_DIR" "$old" "$prev rollback" rollback
REMOTE
  log "rollback 完成"
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
    __emit-drain) declare -f drain_gate maintenance_control maintenance_begin maintenance_end ;;
    status) parse_flags "$@"; cmd_status ;;
    release) parse_flags "$@"; cmd_release ;;
    rollback) parse_flags "$@"; cmd_rollback ;;
    adopt) parse_flags "$@"; cmd_adopt ;;
    -h|--help|help) usage ;;
    *) usage; die "未知子命令：$cmd" ;;
  esac
}

main "$@"
