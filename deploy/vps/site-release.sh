#!/usr/bin/env bash
# site-release.sh — eimu.dev 自托管站点（VPS eimu-site 容器）离机构建 / 发版 / 回滚，本机全程免 sudo
#
# 用法：
#   bash deploy/vps/site-release.sh engine                 # 只读：本机构建引擎预检（系统 docker / rootless），给出可走的路
#   bash deploy/vps/site-release.sh engine-install         # 免 sudo：下载与系统 dockerd 同版本的 docker-rootless-extras 到 ~/.local/opt
#   bash deploy/vps/site-release.sh engine-up              # 免 sudo：用户态拉起 rootless dockerd（$XDG_RUNTIME_DIR/docker.sock）
#   bash deploy/vps/site-release.sh engine-down            # 停掉 engine-up 拉起的 rootless dockerd
#   bash deploy/vps/site-release.sh status                 # 只读：线上 eimu-site 镜像/修订、site-* 标签、盘/内存/在途
#   bash deploy/vps/site-release.sh preflight --sha <c> [--overlay-patch F]   # 只读：引擎＋祖先＋overlay＋VPS 上线闸
#   bash deploy/vps/site-release.sh build --sha <c> [--overlay-patch F] [--tag-suffix S]     # 本机构建＋本机冒烟＋归档
#   bash deploy/vps/site-release.sh release --sha <c> [--overlay-patch F] [--tag-suffix S] [--check-absent P::T] [--check-present P::T] [--dry-run]
#   bash deploy/vps/site-release.sh rollback --to <镜像标签>   # 用 VPS 上已有镜像换回（同一换装/健康检查/自动回退）
#
# 为什么存在（BACKLOG 13，2026-11-04）：
#   站点发版原本是手抄配方（memory 2026-11-01-eimu-site-selfhost-frontend-release）：本机系统 docker
#   构建 → scp → VPS load → 换 eimu-site。11-03 起本机 docker.service inactive、lenovo 不在 docker 组、
#   `sudo -n` 要密码，H10/H11/H12 的站点改动全卡住；VPS 又禁止原地构建（AGENTS.md 2026-10-18 禁令）。
#   本脚本把配方落成可重复命令，并加一条免 sudo 的构建引擎：rootless dockerd（系统 /usr/bin/dockerd ＋
#   用户目录里的 rootlesskit/dockerd-rootless.sh；/etc/subuid、/etc/subgid 已有 lenovo 段，newuidmap 带 cap）。
#
# 引擎选择顺序（第一个 `docker info` 通的就用）：SITE_DOCKER_HOST → $DOCKER_HOST → 系统 /var/run/docker.sock
#   → rootless $XDG_RUNTIME_DIR/docker.sock。都不通 → ENGINE_UNAVAILABLE（exit 10）并列出：
#   ①免 sudo：engine-install＋engine-up；②需暴君执行一次：sudo systemctl start docker。
#   本脚本永远不调用 sudo（本机），不改 sudoers，不 systemctl start docker。
#
# 上线闸（release 全部满足才动线上，任一不满足 exit 3，不重试）：
#   VPS 根盘可用 ≥ SITE_MIN_DISK_GIB（3）GiB；MemAvailable ≥ SITE_MIN_MEM_MIB（400）MiB 且 SwapFree ≥ 512MiB、
#   近 15 分钟内核无 OOM kill；网关在途＝0（与 gateway-release.sh drain_inflight_count 同三路只读 SQL）；
#   harness 激活锁空闲（没有并行网关/opencode 发版）；候选 sha 含线上镜像 revision（祖先闸，fail-closed）；
#   线上标签带 overlay（-ui2/-ov）而候选不带 → 拒发（否则静默回退未提交的 UI 补丁）。
# 换装：新镜像 load 后，旧容器 stop＋rename 成 eimu-site-prev-<ts>（保留原样，供秒级回退），按同参数
#   起新 eimu-site，经 nginx（--resolve www.eimu.dev:443:127.0.0.1）轮询 /api/healthz；不通 → 删新容器、
#   改回旧名并启动（exit 20）。成功才删 prev 容器；旧镜像标签保留作回滚锚（本脚本从不 rmi）。
#   只发一次：本地 flock＋远端 flock，持锁 exit 75；脚本内没有任何重试循环（健康轮询除外，有上界）。
#
# 退出码：0 成功｜1 一般失败｜2 用法｜3 上线闸不满足｜10 无可用构建引擎｜20 新版不健康已自动回退｜
#   21 回退后旧版也不健康（需人工）｜75 另一发版持锁
set -euo pipefail

SSH_KEY="${SITE_SSH_KEY:-${GW_SSH_KEY:-$HOME/.ssh/new.pem}}"
SSH_TARGET="${SITE_SSH_TARGET:-${GW_SSH_TARGET:-ubuntu@43.172.85.76}}"
SSH_PORT="${SITE_SSH_PORT:-${GW_SSH_PORT:-22443}}"
CONTAINER="${SITE_CONTAINER:-eimu-site}"
IMAGE_REPO="${SITE_IMAGE_REPO:-image-control-plane-generation-api}"
SITE_NETWORK="${SITE_NETWORK:-imagesite_imagesite}"
SITE_MEMORY="${SITE_MEMORY:-800m}"
SITE_ENV_FILE="${SITE_ENV_FILE:-/opt/eimu-site/site.env}"
SITE_HOST="${SITE_HOST:-www.eimu.dev}"
SITE_PUBLIC_ORIGIN="${SITE_PUBLIC_ORIGIN:-https://www.eimu.dev}"
SITE_MCP_URL="${SITE_MCP_URL:-https://eimu.dev/api/mcp}"
REMOTE_LOCK="${SITE_REMOTE_LOCK:-/opt/eimu-site/.site-release.lock}"
HARNESS_ROOT="${GW_HARNESS_ROOT:-/opt/agent-harness}"
ACTIVATION_LOCK="${HARNESS_ACTIVATION_LOCK:-$HARNESS_ROOT/.harness-activation.lock}"
MIN_DISK_GIB="${SITE_MIN_DISK_GIB:-3}"
MIN_MEM_MIB="${SITE_MIN_MEM_MIB:-400}"
MIN_SWAP_FREE_MIB="${SITE_MIN_SWAP_FREE_MIB:-512}"
HEALTH_TIMEOUT="${SITE_HEALTH_TIMEOUT:-150}"
BUILD_NETWORK="${SITE_BUILD_NETWORK:-host}"
STATE_DIR="${SITE_STATE_DIR:-$HOME/.local/state/eimu-site-release}"
BUILD_ROOT="${SITE_BUILD_ROOT:-$HOME/.cache/eimu-site-release}"
SMOKE_PORT="${SITE_SMOKE_PORT:-13099}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
ROOTLESS_SOCK="unix://$RUNTIME_DIR/docker.sock"

SHA=""; FULL_SHA=""; OVERLAY=""; TAG_SUFFIX=""; TAG_SUFFIX_SET=0; DRY_RUN=0; ROLLBACK_TO=""; OVERRIDE_ANCESTRY=""
ALLOW_DROP_OVERLAY=0
CHECK_ABSENT=(); CHECK_PRESENT=()
ENGINE_HOST=""; ENGINE_KIND=""

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
ssh_opts() { printf '%s\n' -i "$SSH_KEY" -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o BatchMode=yes; }
remote() { local -a o; mapfile -t o < <(ssh_opts); ssh "${o[@]}" -p "$SSH_PORT" "$SSH_TARGET" "$@"; }

# ── 构建引擎 ─────────────────────────────────────────────────────────────
dockerd_version() { /usr/bin/dockerd --version 2>/dev/null | sed -n 's/^Docker version \([0-9.]*\).*/\1/p'; }
rootless_dir() { printf '%s\n' "${SITE_ROOTLESS_DIR:-$HOME/.local/opt/docker-rootless-$(dockerd_version)}"; }
engine_try() { DOCKER_HOST="$1" timeout 15 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }

resolve_engine() {
  local -a cands=()
  if [ -n "${SITE_DOCKER_HOST:-}" ]; then cands=("$SITE_DOCKER_HOST")
  else
    [ -n "${DOCKER_HOST:-}" ] && cands+=("$DOCKER_HOST")
    cands+=("unix:///var/run/docker.sock" "$ROOTLESS_SOCK")
  fi
  local h
  for h in "${cands[@]}"; do
    if engine_try "$h"; then
      ENGINE_HOST="$h"
      if DOCKER_HOST="$h" docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then ENGINE_KIND=rootless; else ENGINE_KIND=system; fi
      return 0
    fi
  done
  return 1
}

engine_diagnose() {
  local rd; rd="$(rootless_dir)"
  echo "docker_cli=$(command -v docker || echo MISSING)"
  echo "dockerd=$(command -v dockerd || echo MISSING) version=$(dockerd_version)"
  echo "system_service=$(systemctl is-active docker 2>/dev/null || true) socket_unit=$(systemctl is-active docker.socket 2>/dev/null || true)"
  if [ -S /var/run/docker.sock ]; then
    if [ -w /var/run/docker.sock ]; then echo "system_sock=present,writable"; else echo "system_sock=present,NO_PERMISSION（$(id -un) 不在 docker 组）"; fi
  else echo "system_sock=absent"; fi
  if id -nG | tr ' ' '\n' | grep -qx docker; then echo "docker_group=yes"; else echo "docker_group=no"; fi
  echo "rootless_sock=$( [ -S "$RUNTIME_DIR/docker.sock" ] && echo present || echo absent ) ($RUNTIME_DIR/docker.sock)"
  echo "rootless_extras=$( [ -x "$rd/dockerd-rootless.sh" ] && [ -x "$rd/rootlesskit" ] && echo "installed ($rd)" || echo "missing ($rd)")"
  echo "subuid=$(grep -c "^$(id -un):" /etc/subuid 2>/dev/null || echo 0) subgid=$(grep -c "^$(id -un):" /etc/subgid 2>/dev/null || echo 0)"
  echo "newuidmap=$(command -v newuidmap || echo MISSING) newgidmap=$(command -v newgidmap || echo MISSING)"
  echo "userns=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a) max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo n/a)"
  echo "podman=$(command -v podman || echo absent)"
}

engine_unavailable() {
  log "ENGINE_UNAVAILABLE：没有可用的本机构建引擎（本脚本不会 sudo，不会 systemctl start docker）"
  engine_diagnose >&2
  local rd; rd="$(rootless_dir)"
  log "可走的路："
  if [ -x "$rd/dockerd-rootless.sh" ]; then
    log "  ① 免 sudo（推荐）：bash deploy/vps/site-release.sh engine-up    # 用户态 rootless dockerd"
  else
    log "  ① 免 sudo（推荐）：bash deploy/vps/site-release.sh engine-install && bash deploy/vps/site-release.sh engine-up"
  fi
  log "     前提：/etc/subuid 与 /etc/subgid 有 $(id -un) 段、newuidmap/newgidmap 可用（缺这两样才需要 sudo：sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un)）"
  log "  ② 需暴君执行一次 sudo：sudo systemctl start docker   （之后本脚本自动走系统 /var/run/docker.sock；不建议把 $(id -un) 加进 docker 组＝等同 root）"
  exit 10
}

cmd_engine() {
  engine_diagnose
  if resolve_engine; then echo "ENGINE_OK kind=$ENGINE_KIND host=$ENGINE_HOST server=$(DOCKER_HOST="$ENGINE_HOST" docker info --format '{{.ServerVersion}}')"; else engine_unavailable; fi
}

cmd_engine_install() {
  local v rd url tmp
  v="$(dockerd_version)"; [ -n "$v" ] || die "读不到系统 dockerd 版本（/usr/bin/dockerd）；rootless 需要系统已装 docker 包（只用二进位，不用其服务）"
  rd="$(rootless_dir)"
  if [ -x "$rd/dockerd-rootless.sh" ] && [ -x "$rd/rootlesskit" ]; then echo "ENGINE_INSTALL_SKIP 已装：$rd"; return 0; fi
  url="https://download.docker.com/linux/static/stable/$(uname -m)/docker-rootless-extras-$v.tgz"
  mkdir -p "$rd"; tmp="$rd/extras.tgz"
  curl -fsSL -m 300 -o "$tmp" "$url" || die "下载失败：$url"
  tar xzf "$tmp" -C "$rd" --strip-components=1
  echo "ENGINE_INSTALLED dir=$rd sha256=$(sha256sum "$tmp" | cut -d' ' -f1) rootlesskit=$("$rd/rootlesskit" --version 2>/dev/null | awk '{print $NF}')"
}

cmd_engine_up() {
  if engine_try "$ROOTLESS_SOCK"; then echo "ENGINE_UP_ALREADY host=$ROOTLESS_SOCK"; return 0; fi
  local rd log_f pid
  rd="$(rootless_dir)"
  [ -x "$rd/dockerd-rootless.sh" ] && [ -x "$rd/rootlesskit" ] || { log "rootless extras 未装：$rd"; engine_unavailable; }
  grep -q "^$(id -un):" /etc/subuid && grep -q "^$(id -un):" /etc/subgid || { log "/etc/subuid 或 /etc/subgid 缺 $(id -un) 段"; engine_unavailable; }
  command -v newuidmap >/dev/null && command -v newgidmap >/dev/null || { log "缺 newuidmap/newgidmap（shadow 包）"; engine_unavailable; }
  [ -d "$RUNTIME_DIR" ] && [ -w "$RUNTIME_DIR" ] || die "XDG_RUNTIME_DIR 不可写：$RUNTIME_DIR"
  mkdir -p "$STATE_DIR"; log_f="$STATE_DIR/rootless-dockerd.log"
  XDG_RUNTIME_DIR="$RUNTIME_DIR" PATH="$rd:/usr/bin:$PATH" setsid nohup "$rd/dockerd-rootless.sh" >"$log_f" 2>&1 </dev/null &
  pid=$!; echo "$pid" > "$STATE_DIR/rootless-dockerd.pid"
  for _ in $(seq 1 30); do
    if engine_try "$ROOTLESS_SOCK"; then echo "ENGINE_UP host=$ROOTLESS_SOCK pid=$pid log=$log_f"; return 0; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 2
  done
  log "ENGINE_UP_FAILED（日志尾）："; tail -20 "$log_f" >&2 || true
  exit 10
}

cmd_engine_down() {
  local pf="$STATE_DIR/rootless-dockerd.pid" pid
  [ -f "$pf" ] || { echo "ENGINE_DOWN_SKIP 没有 engine-up 记录的 pid"; return 0; }
  pid="$(cat "$pf")"
  if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid"; echo "ENGINE_DOWN pid=$pid"; else echo "ENGINE_DOWN_SKIP pid=$pid 已不在"; fi
  rm -f "$pf"
}

# ── 公共 ────────────────────────────────────────────────────────────────
need_sha() {
  [ -n "$SHA" ] || die "$1 必须显式 --sha <commit>"
  FULL_SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$SHA^{commit}" 2>/dev/null)" || die "不认识的 commit：$SHA（先 git fetch）"
}
overlay_sha() { [ -n "$OVERLAY" ] && sha256sum "$OVERLAY" | cut -d' ' -f1 || true; }
image_tag() {
  local suf="$TAG_SUFFIX"
  if [ "$TAG_SUFFIX_SET" -eq 0 ] && [ -n "$OVERLAY" ]; then suf="-ov$(overlay_sha | cut -c1-8)"; fi
  printf '%s:site-%s%s\n' "$IMAGE_REPO" "${FULL_SHA:0:9}" "$suf"
}
archive_path() { local t; t="$(image_tag)"; printf '%s/%s.tar.gz\n' "$STATE_DIR" "${t##*:}"; }

# 与 gateway-release.sh drain_inflight_count 同三路只读判据（窗口 180s）；任何一路读不到 → ERR（fail-closed）。
REMOTE_INFLIGHT_FN='
site_inflight() {
  local hr="$1" now W=180000 a b c
  now=$(( $(date +%s) * 1000 ))
  a="$(sqlite3 -readonly -cmd ".timeout 3000" "$hr/state/sessions.db" "SELECT COUNT(*) FROM sessions WHERE json_extract(data,'"'"'\$.lastTurnActiveAt'"'"') > 0 AND ($now - json_extract(data,'"'"'\$.lastTurnActiveAt'"'"')) < $W;" 2>/dev/null || echo ERR)"
  b="$(sqlite3 -readonly -cmd ".timeout 3000" "$hr/state/sessions.db" "SELECT COUNT(*) FROM subagent_reworks;" 2>/dev/null || echo ERR)"
  c="$(sqlite3 -readonly -cmd ".timeout 3000" "$hr/workspace/.local/share/opencode/opencode.db" "SELECT COUNT(*) FROM message WHERE json_extract(data,'"'"'\$.role'"'"')='"'"'assistant'"'"' AND json_extract(data,'"'"'\$.time.completed'"'"') IS NULL AND ($now - time_updated) < $W;" 2>/dev/null || echo ERR)"
  case "$a$b$c" in *[!0-9]*|"") echo "ERR (sessions=$a subagent_reworks=$b opencode_streaming=$c)";; *) echo "$((a+b+c)) (sessions=$a subagent_reworks=$b opencode_streaming=$c)";; esac
}
'

# 远端只读：线上状态＋上线闸原料。输出 key=value。
remote_probe() {
  { printf '%s\n' "$REMOTE_INFLIGHT_FN"; cat; } <<'REMOTE' | remote "sudo bash -s -- $(printf '%q ' "$CONTAINER" "$HARNESS_ROOT" "$ACTIVATION_LOCK" "$IMAGE_REPO")"
set -uo pipefail
C="$1"; HR="$2"; AL="$3"; REPO="$4"
echo "live_image=$(docker inspect "$C" --format '{{.Config.Image}}' 2>/dev/null || echo NONE)"
echo "live_image_id=$(docker inspect "$C" --format '{{.Image}}' 2>/dev/null | cut -c1-19)"
echo "live_revision=$(docker inspect "$C" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"
echo "live_overlay=$(docker inspect "$C" --format '{{index .Config.Labels "eimu.site.overlay.sha256"}}' 2>/dev/null)"
echo "live_state=$(docker inspect "$C" --format '{{.State.Status}} started={{.State.StartedAt}} net={{.HostConfig.NetworkMode}} mem={{.HostConfig.Memory}} restart={{.HostConfig.RestartPolicy.Name}}' 2>/dev/null)"
echo "site_images=$(docker images --format '{{.Repository}}:{{.Tag}}' "$REPO" | grep ':site-' | tr '\n' ' ')"
echo "disk_avail_kib=$(df -Pk / | awk 'NR==2{print $4}')"
echo "disk_human=$(df -h / | awk 'NR==2{print $4" free / "$5" used"}')"
echo "mem_avail_mib=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
echo "swap_free_mib=$(awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo)"
echo "oom_15m=$(journalctl -k --since '-15min' --no-pager 2>/dev/null | grep -c -i 'out of memory' || true)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "inflight=$(site_inflight "$HR")"
if [ -e "$AL" ]; then if flock -n "$AL" true 2>/dev/null; then echo "activation_lock=free"; else echo "activation_lock=HELD"; fi; else echo "activation_lock=absent"; fi
echo "gw_healthz=$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8081/healthz || echo ERR)"
echo "site_healthz=$(curl -sk -o /dev/null -m 8 -w '%{http_code}' --resolve www.eimu.dev:443:127.0.0.1 https://www.eimu.dev/api/healthz || echo ERR)"
REMOTE
}
kv() { sed -n "s/^$1=//p" <<<"$PROBE" | head -1; }

# 上线闸：失败返回非零并打印原因（不退出，便于 preflight 全列）。
gates_check() {
  local fail=0 disk mem swap oom inf lock live_rev live_img
  disk="$(kv disk_avail_kib)"; mem="$(kv mem_avail_mib)"; swap="$(kv swap_free_mib)"; oom="$(kv oom_15m)"
  inf="$(kv inflight | cut -d' ' -f1)"; lock="$(kv activation_lock)"; live_rev="$(kv live_revision)"; live_img="$(kv live_image)"
  if [ "${disk:-0}" -ge $(( MIN_DISK_GIB * 1024 * 1024 )) ] 2>/dev/null; then echo "GATE disk OK ($(kv disk_human))"; else echo "GATE disk FAIL ($(kv disk_human)，需 ≥${MIN_DISK_GIB}GiB)"; fail=1; fi
  if [ "${mem:-0}" -ge "$MIN_MEM_MIB" ] 2>/dev/null && [ "${swap:-0}" -ge "$MIN_SWAP_FREE_MIB" ] 2>/dev/null && [ "${oom:-1}" = "0" ]; then
    echo "GATE memory OK (MemAvailable=${mem}MiB SwapFree=${swap}MiB oom_15m=$oom)"
  else echo "GATE memory FAIL (MemAvailable=${mem}MiB≥$MIN_MEM_MIB? SwapFree=${swap}MiB≥$MIN_SWAP_FREE_MIB? oom_15m=$oom=0?)"; fail=1; fi
  if [ "$inf" = "0" ]; then echo "GATE inflight OK ($(kv inflight))"; else echo "GATE inflight FAIL ($(kv inflight))"; fail=1; fi
  if [ "$lock" != "HELD" ]; then echo "GATE activation_lock OK ($lock)"; else echo "GATE activation_lock FAIL（网关/opencode 发版进行中）"; fail=1; fi
  if [ "$(kv site_healthz)" = "200" ]; then echo "GATE live_site_healthz OK"; else echo "GATE live_site_healthz WARN ($(kv site_healthz)) — 现网本来就不健康，换装后以新版健康为准"; fi
  if [ -z "$live_rev" ]; then
    if [ -n "$OVERRIDE_ANCESTRY" ]; then echo "GATE ancestry OVERRIDE（线上无 revision 标签）：$OVERRIDE_ANCESTRY"; else echo "GATE ancestry FAIL（线上镜像无 org.opencontainers.image.revision，无法判定；确需发请 --override-ancestry \"理由\"）"; fail=1; fi
  elif ! git -C "$REPO_ROOT" cat-file -e "$live_rev^{commit}" 2>/dev/null; then echo "GATE ancestry FAIL（本地没有线上 revision $live_rev，先 git fetch）"; fail=1
  elif git -C "$REPO_ROOT" merge-base --is-ancestor "$live_rev" "$FULL_SHA"; then echo "GATE ancestry OK (live ${live_rev:0:9} ⊂ ${FULL_SHA:0:9})"
  elif [ -n "$OVERRIDE_ANCESTRY" ]; then echo "GATE ancestry OVERRIDE：$OVERRIDE_ANCESTRY"
  else echo "GATE ancestry FAIL（候选 ${FULL_SHA:0:9} 不含线上 ${live_rev:0:9}，缺：$(git -C "$REPO_ROOT" log --format=%h "$FULL_SHA..$live_rev" | head -10 | tr '\n' ' ')）"; fail=1; fi
  case "$live_img" in
    *-ui[0-9]*|*-ov*)
      if [ -z "$OVERLAY" ] && [ "$ALLOW_DROP_OVERLAY" -ne 1 ]; then echo "GATE overlay FAIL（线上 $live_img 带未提交 UI overlay，候选没带 --overlay-patch → 会回退线上 UI；确认要丢弃请加 --allow-drop-overlay）"; fail=1
      else echo "GATE overlay OK (live=$live_img candidate_overlay=$( [ -n "$OVERLAY" ] && overlay_sha | cut -c1-12 || echo none))"; fi ;;
    *) echo "GATE overlay OK (live 无 overlay)";;
  esac
  return "$fail"
}

# ── 构建 ────────────────────────────────────────────────────────────────
cmd_build() {
  need_sha build
  resolve_engine || engine_unavailable
  export DOCKER_HOST="$ENGINE_HOST"
  local tag dir df arc t0
  tag="$(image_tag)"; arc="$(archive_path)"
  mkdir -p "$STATE_DIR" "$BUILD_ROOT"
  if DOCKER_HOST="$ENGINE_HOST" docker image inspect "$tag" >/dev/null 2>&1 && [ -s "$arc" ] && [ -s "$arc.sha256" ]; then
    echo "BUILD_REUSE tag=$tag archive=$arc"; return 0
  fi
  log "BUILD engine=$ENGINE_KIND host=$ENGINE_HOST sha=${FULL_SHA:0:9} overlay=$( [ -n "$OVERLAY" ] && overlay_sha | cut -c1-12 || echo none) tag=$tag"
  dir="$BUILD_ROOT/src-${FULL_SHA:0:12}-$$"
  [ ! -e "$dir" ] || die "构建目录已存在：$dir"
  mkdir -p "$dir"
  # 只上已 commit 的快照（git archive），不读工作区；overlay 是显式、带 sha256 记录的补丁。
  git -C "$REPO_ROOT" archive "$FULL_SHA" | tar -x -C "$dir"
  if [ -n "$OVERLAY" ]; then
    git -C "$dir" init -q 2>/dev/null || true
    (cd "$dir" && git apply --check "$OVERLAY" && git apply "$OVERLAY") || { rm -rf "$dir"; die "overlay 补丁打不上：$OVERLAY"; }
    rm -rf "$dir/.git"
  fi
  df="$STATE_DIR/site.Dockerfile"
  # 与 2026-11-01 配方一致：builder 阶段内联非秘密的 NEXT_PUBLIC 站点地址，VERCEL=1 走 next.config 的跳 lint/tsc。
  awk '{print} /^FROM node:22-alpine AS builder/{print "ENV VERCEL=1\nENV NEXT_PUBLIC_SITE_URL=https://eimu.dev\nENV NEXT_PUBLIC_APP_URL=https://www.eimu.dev"}' \
    "$dir/deploy/vps/Dockerfile" > "$df"
  grep -q '^ENV NEXT_PUBLIC_SITE_URL' "$df" || { rm -rf "$dir"; die "Dockerfile 里找不到 builder 阶段，配方需更新"; }
  t0=$(date +%s)
  local -a labels=(--label "org.opencontainers.image.revision=$FULL_SHA" --label "eimu.site.engine=$ENGINE_KIND")
  [ -n "$OVERLAY" ] && labels+=(--label "eimu.site.overlay.sha256=$(overlay_sha)" --label "eimu.site.overlay.files=$(grep -E '^\+\+\+ b/' "$OVERLAY" | sed 's#^+++ b/##' | tr '\n' ',' | sed 's/,$//')")
  if ! docker build --network="$BUILD_NETWORK" -f "$df" --target runner -t "$tag" "${labels[@]}" "$dir"; then
    rm -rf "$dir"; die "docker build 失败（不重试）"
  fi
  rm -rf "$dir"
  log "BUILD_DONE $(( $(date +%s) - t0 ))s id=$(docker image inspect "$tag" --format '{{.Id}}' | cut -c1-19)"
  smoke_local "$tag"
  docker save "$tag" | gzip -1 > "$arc.part"
  mv "$arc.part" "$arc"
  sha256sum "$arc" | cut -d' ' -f1 > "$arc.sha256"
  echo "BUILD_OK tag=$tag id=$(docker image inspect "$tag" --format '{{.Id}}' | cut -c1-19) archive=$arc bytes=$(stat -c %s "$arc") sha256=$(cut -c1-16 "$arc.sha256")…"
}

http_code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" || echo ERR; }

# 本机冒烟：不带 site.env（不碰任何秘密），只验进程起得来、静态与插件页在包里。
smoke_local() {
  local tag="$1" name="eimu-site-smoke-$$" code base="http://127.0.0.1:$SMOKE_PORT"
  docker run -d --rm --name "$name" -p "127.0.0.1:$SMOKE_PORT:3000" "$tag" >/dev/null
  code=000
  for _ in $(seq 1 30); do code="$(http_code "$base/api/healthz")"; [ "$code" = "200" ] && break; sleep 2; done
  local fail=0
  echo "SMOKE healthz=$code home=$(http_code "$base/") plugin_readme=$(http_code "$base/plugin/eimu/README.md")"
  [ "$code" = "200" ] || fail=1
  run_checks "$base" || fail=1
  docker rm -f "$name" >/dev/null 2>&1 || true
  [ "$fail" -eq 0 ] || die "本机冒烟失败（镜像已建：$tag，未归档、未上线）"
}

# --check-absent/--check-present "<路径>::<文本>"；对给定 origin 逐条验。
run_checks() {
  local base="$1" spec p t body fail=0
  for spec in "${CHECK_ABSENT[@]+"${CHECK_ABSENT[@]}"}"; do
    p="${spec%%::*}"; t="${spec#*::}"; body="$(curl -s -m 20 "$base$p" || true)"
    if [ -n "$body" ] && ! grep -qF -- "$t" <<<"$body"; then echo "CHECK absent OK $p !~ '$t'"; else echo "CHECK absent FAIL $p（空响应或仍含 '$t'）"; fail=1; fi
  done
  for spec in "${CHECK_PRESENT[@]+"${CHECK_PRESENT[@]}"}"; do
    p="${spec%%::*}"; t="${spec#*::}"; body="$(curl -s -m 20 "$base$p" || true)"
    if grep -qF -- "$t" <<<"$body"; then echo "CHECK present OK $p ~ '$t'"; else echo "CHECK present FAIL $p 不含 '$t'"; fail=1; fi
  done
  return "$fail"
}

# ── 远端换装（release / rollback 共用）──────────────────────────────────
# $1 TAR（远端路径或 -）$2 SHA256（或 -）$3 TAG $4 容器 $5 网络 $6 内存 $7 env-file $8 健康上界 $9 HR ${10} 站点 host
REMOTE_ACTIVATE='
set -uo pipefail
TAR="$1"; SUM="$2"; TAG="$3"; C="$4"; NET="$5"; MEM="$6"; ENVF="$7"; HT="$8"; HR="$9"; HOST="${10}"
PREV=""; DONE=0
health() { curl -sk -o /dev/null -m 8 -w "%{http_code}" --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/healthz" 2>/dev/null || echo ERR; }
wait_health() { local i=0 code=000; while [ "$i" -lt "$HT" ]; do code="$(health)"; [ "$code" = 200 ] && { echo "HEALTH 200 after ${i}s"; return 0; }; sleep 3; i=$((i+3)); done; echo "HEALTH FAIL last=$code after ${HT}s"; return 1; }
restore() {
  [ -n "$PREV" ] || return 0
  echo "ROLLBACK_BEGIN → $PREV"
  docker logs --tail 30 "$C" 2>&1 | sed "s/^/  new| /" | tail -30
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker rename "$PREV" "$C" && docker update --restart=always "$C" >/dev/null && docker start "$C" >/dev/null
  if wait_health; then echo "ROLLED_BACK image=$(docker inspect "$C" --format "{{.Config.Image}}")"; exit 20; fi
  echo "ROLLBACK_UNHEALTHY 需人工"; exit 21
}
trap '"'"'rc=$?; if [ "$DONE" -ne 1 ] && [ -n "$PREV" ]; then restore; fi; exit $rc'"'"' EXIT
trap "exit 130" INT; trap "exit 143" TERM; trap "exit 129" HUP
[ -f "$ENVF" ] || { echo "ABORT env-file 不存在：$ENVF"; exit 1; }
docker inspect "$C" >/dev/null 2>&1 || { echo "ABORT 线上没有容器 $C"; exit 1; }
OLD="$(docker inspect "$C" --format "{{.Config.Image}}")"
if [ "$TAR" != "-" ]; then
  echo "$SUM  $TAR" | sha256sum -c --quiet - || { rm -f "$TAR"; echo "ABORT 归档 sha256 不符"; exit 1; }
  gunzip -c "$TAR" | docker load | tail -2; rc=${PIPESTATUS[1]}
  rm -f "$TAR"
  [ "$rc" -eq 0 ] || { echo "ABORT docker load 失败"; exit 1; }
fi
docker image inspect "$TAG" >/dev/null 2>&1 || { echo "ABORT 镜像不在 VPS：$TAG"; exit 1; }
[ "$OLD" != "$TAG" ] || { echo "NOOP 线上已是 $TAG"; DONE=1; exit 0; }
fin="$(site_inflight "$HR")"
case "$fin" in 0\ *) echo "FINAL_INFLIGHT $fin";; *) echo "ABORT 换装前终检在途≠0：$fin（新镜像已 load 留在 VPS，旧版未动；低峰再发 rollback --to 新标签 或重跑 release）"; exit 3;; esac
echo "disk_after_load=$(df -h / | awk "NR==2{print \$4\" free / \"\$5}")"
PREV="$C-prev-$(date +%s)"
docker stop -t 20 "$C" >/dev/null && docker rename "$C" "$PREV" && docker update --restart=no "$PREV" >/dev/null || { echo "ABORT 停旧容器失败"; docker start "$C" >/dev/null 2>&1; PREV=""; exit 1; }
echo "SWAP old=$OLD → new=$TAG（旧容器暂存为 $PREV）"
docker run -d --name "$C" --restart always --network "$NET" --memory "$MEM" --env-file "$ENVF" "$TAG" >/dev/null || { echo "RUN_FAIL"; exit 1; }
wait_health || exit 1
DONE=1
docker rm "$PREV" >/dev/null && echo "PREV_REMOVED $PREV（镜像 $OLD 保留作回滚锚）"
echo "RELEASED image=$TAG id=$(docker inspect "$C" --format "{{.Image}}" | cut -c1-19) rollback_anchor=$OLD"
'

remote_activate() {
  # $1 远端 tar 或 -  $2 sha256 或 -  $3 tag
  remote "sudo flock -n -E 75 $(printf '%q' "$REMOTE_LOCK") bash -c $(printf '%q' "$REMOTE_INFLIGHT_FN$REMOTE_ACTIVATE") site-activate $(printf '%q ' "$1" "$2" "$3" "$CONTAINER" "$SITE_NETWORK" "$SITE_MEMORY" "$SITE_ENV_FILE" "$HEALTH_TIMEOUT" "$HARNESS_ROOT" "$SITE_HOST")"
}

public_verify() {
  local fail=0 code mcp_hdr
  code="$(http_code "$SITE_PUBLIC_ORIGIN/api/healthz")"; echo "PUBLIC healthz=$code"; [ "$code" = "200" ] || fail=1
  echo "PUBLIC home=$(http_code "$SITE_PUBLIC_ORIGIN/") plugin_readme=$(http_code "$SITE_PUBLIC_ORIGIN/plugin/eimu/README.md")"
  # MCP：无 key initialize 必须 401 且带 resource_metadata（鉴权闸在、路由活着）；不带任何凭证。
  mcp_hdr="$(curl -s -o /dev/null -D - -m 20 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"site-release-probe","version":"1"}}}' \
    "$SITE_MCP_URL" || true)"
  if grep -q '^HTTP/[0-9.]* 401' <<<"$mcp_hdr" && grep -qi 'resource_metadata' <<<"$mcp_hdr"; then echo "PUBLIC mcp_unauth=401+resource_metadata OK"; else echo "PUBLIC mcp_unauth FAIL ($(head -1 <<<"$mcp_hdr"))"; fail=1; fi
  run_checks "$SITE_PUBLIC_ORIGIN" || fail=1
  return "$fail"
}

with_local_lock() {
  mkdir -p "$STATE_DIR"
  exec 9>"$STATE_DIR/site-release.lock"
  flock -n 9 || { log "SITE_RELEASE_LOCKED 本机另一发站进行中"; exit 75; }
}

cmd_status() { PROBE="$(remote_probe)"; printf '%s\n' "$PROBE"; }

cmd_preflight() {
  need_sha preflight
  [ -z "$OVERLAY" ] || [ -f "$OVERLAY" ] || die "overlay 不存在：$OVERLAY"
  if resolve_engine; then echo "ENGINE_OK kind=$ENGINE_KIND host=$ENGINE_HOST"; else echo "ENGINE_UNAVAILABLE（build 会 exit 10；见 engine 子命令）"; fi
  PROBE="$(remote_probe)"; printf '%s\n' "$PROBE"
  echo "candidate_tag=$(image_tag)"
  if gates_check; then echo "PREFLIGHT_OK"; else echo "PREFLIGHT_BLOCKED"; return 3; fi
}

cmd_release() {
  need_sha release
  [ -z "$OVERLAY" ] || [ -f "$OVERLAY" ] || die "overlay 不存在：$OVERLAY"
  with_local_lock
  # 闸先跑一遍（只读）：明知不能上线就别浪费构建。
  PROBE="$(remote_probe)"
  gates_check || { echo "RELEASE_BLOCKED（上线闸不满足，未构建/未上传/未换装）"; exit 3; }
  cmd_build
  local tag arc sum rtmp
  tag="$(image_tag)"; arc="$(archive_path)"; sum="$(cat "$arc.sha256")"
  if [ "$DRY_RUN" -eq 1 ]; then echo "DRY_RUN 构建＋冒烟已过，未上传：tag=$tag archive=$arc"; return 0; fi
  # 构建可能耗时数分钟：换装前再验一次闸（只读），状态变了就停。
  PROBE="$(remote_probe)"
  gates_check || { echo "RELEASE_BLOCKED（构建后复检闸不满足，未上传/未换装；镜像归档留在 $arc）"; exit 3; }
  rtmp="/tmp/$(basename "$arc")"
  local -a o; mapfile -t o < <(ssh_opts)
  scp -q "${o[@]}" -P "$SSH_PORT" "$arc" "$SSH_TARGET:$rtmp" || die "上传失败（不重试）"
  local rc=0
  remote_activate "$rtmp" "$sum" "$tag" || rc=$?
  [ "$rc" -eq 0 ] || { echo "RELEASE_FAILED rc=$rc（见上方 ROLLED_BACK/ROLLBACK_UNHEALTHY；不重试）"; exit "$rc"; }
  if public_verify; then echo "RELEASE_OK tag=$tag"; else echo "RELEASE_VERIFY_FAIL tag=$tag（新版已在线且 healthz 200，公网核验未全过；回滚：bash deploy/vps/site-release.sh rollback --to $(kv live_image)）"; exit 1; fi
}

cmd_rollback() {
  [ -n "$ROLLBACK_TO" ] || die "rollback 需要 --to <VPS 上已有的镜像标签>（status 可看 site_images）"
  with_local_lock
  PROBE="$(remote_probe)"; printf '%s\n' "$PROBE" | grep -E '^(live_image|site_images|inflight|disk_human)='
  [ "$(kv inflight | cut -d' ' -f1)" = "0" ] || { echo "ROLLBACK_BLOCKED inflight≠0"; exit 3; }
  remote_activate - - "$ROLLBACK_TO"
  public_verify || exit 1
}

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha) SHA="${2:-}"; shift 2 ;;
      --overlay-patch) OVERLAY="$(readlink -f "${2:-}")"; shift 2 ;;
      --tag-suffix) TAG_SUFFIX="${2:-}"; TAG_SUFFIX_SET=1; shift 2 ;;
      --check-absent) CHECK_ABSENT+=("${2:-}"); shift 2 ;;
      --check-present) CHECK_PRESENT+=("${2:-}"); shift 2 ;;
      --to) ROLLBACK_TO="${2:-}"; shift 2 ;;
      --override-ancestry) OVERRIDE_ANCESTRY="${2:-}"; [ "${#OVERRIDE_ANCESTRY}" -ge 8 ] || die "--override-ancestry 需要 ≥8 字理由"; shift 2 ;;
      --allow-drop-overlay) ALLOW_DROP_OVERLAY=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) log "未知参数：$1"; usage >&2; exit 2 ;;
    esac
  done
  case "$TAG_SUFFIX" in ''|-[A-Za-z0-9._-]*) ;; *) die "--tag-suffix 须以 - 开头（例 -ui2）";; esac
}

main() {
  local sub="${1:-}"; [ $# -gt 0 ] && shift
  case "$sub" in
    engine) cmd_engine ;;
    engine-install) cmd_engine_install ;;
    engine-up) cmd_engine_up ;;
    engine-down) cmd_engine_down ;;
    status) parse_flags "$@"; cmd_status ;;
    preflight) parse_flags "$@"; cmd_preflight ;;
    build) parse_flags "$@"; with_local_lock; cmd_build ;;
    release) parse_flags "$@"; cmd_release ;;
    rollback) parse_flags "$@"; cmd_rollback ;;
    ''|-h|--help|help) usage ;;
    *) log "未知子命令：$sub"; usage >&2; exit 2 ;;
  esac
}
main "$@"
