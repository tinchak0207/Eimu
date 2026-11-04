#!/usr/bin/env bash
# control-plane-prebuilt-release.sh — 控面（image-control-api / image-control-worker）离机预构建发版 / 回滚，本机全程免 sudo
#
# 用法：
#   bash deploy/vps/control-plane-prebuilt-release.sh status                       # 只读：线上两容器镜像/修订、cp-* 标签、盘/内存/在途、readyz
#   bash deploy/vps/control-plane-prebuilt-release.sh audit --sha <c>              # 只读：线上修订→候选的积压 diff 风险分类（UI／计费付费路径／迁移）
#   bash deploy/vps/control-plane-prebuilt-release.sh preflight --sha <c>          # 只读：引擎＋祖先＋积压审计＋VPS 上线闸＋落盘估算
#   bash deploy/vps/control-plane-prebuilt-release.sh fetch-base                   # 只读 VPS：把线上 worker 镜像流式拉到本机引擎（overlay 构建的底座）
#   bash deploy/vps/control-plane-prebuilt-release.sh build --sha <c> [--full-worker]   # 本机构建 api(runner)＋worker，冒烟
#   bash deploy/vps/control-plane-prebuilt-release.sh release --sha <c> [--ack-backlog "理由"] [--dry-run]
#   bash deploy/vps/control-plane-prebuilt-release.sh rollback [--to <sha 或 git-xxxx 标签后缀>]   # 默认回到上次发版记录的锚
#   构建引擎（rootless dockerd）沿用 site-release.sh：engine / engine-install / engine-up / engine-down 请用那支脚本。
#
# 为什么存在（加固第 26 项，2026-11-04）：deploy-control-plane.sh 的 deploy 已硬禁用（VPS 4G 原地构建＝磁盘/内存
#   事故，AGENTS.md 2026-10-18 禁令），控面自 10-29 git-910f07a4 起无合法发版路径，H21 退款重试修复（6625abf9e）
#   与之后的积压都卡住；11-03 yyds 认领靠 docker cp＋seed 热替换在跑，一旦按旧镜像重建即丢（memory
#   2026-11-03-gpt-image-yyds-retired-by-stale-worker-image）。本脚本＝离机构建 → 流式 docker load → 只改 compose
#   两行 image: → compose up --no-build。版本内的 supplier-channels.config.ts 随镜像走，worker 启动时
#   generation:bootstrap（migrate＋seed）按镜像内 registry 落库，热替换即被镜像固化。
#
# 构建：api 走 deploy/vps/Dockerfile --target runner（与线上同配方，不注入站点 env）；worker 默认 overlay：
#   FROM 线上 worker 镜像（npm ci 层 1.28GB 原样复用）＋ 清掉旧源码目录 ＋ COPY 候选源码，仅当 package.json /
#   package-lock.json 与线上修订完全一致；否则须 --full-worker（整层 npm ci，传输/落盘大得多，闸会算进去）。
#   构建上下文＝git archive <sha> -- 与 deploy-control-plane.sh 同一份 ARCHIVE_PATHS（只上已 commit 快照）。
#
# 上线闸（全部满足才动线上，任一不满足 exit 3，不重试）：VPS 根盘可用 ≥3GiB 且「可用 − 估算落盘」≥3GiB、load 后
#   复测 ≥3GiB；MemAvailable ≥400MiB、SwapFree ≥512MiB、15 分钟无 OOM、无 D 状态进程堆积；生成在途＝0
#   （generation_job queued/leased/submitting/running/pending_billing）且网关在途＝0（与 site-release 同三路只读 SQL）；
#   harness 激活锁空闲；候选含两容器线上修订（祖先闸，fail-closed）；积压审计命中 UI/付费路径/迁移 → 必须
#   --ack-backlog "理由"（暴君拍板后才给）。
# 换装：记下两容器当前 image 作回滚锚（从不 rmi，旧标签原样保留）→ compose 文件备份 → 只替换两行 image: →
#   docker compose up -d --no-build --no-deps generation-api generation-worker → readyz/代理面/env/worker 30s 稳定 →
#   nginx -t＋reload；任一不过 → 还原 compose 备份再 up --no-build（exit 20；回退后仍不健康 exit 21）。
#   只发一次：本地 flock＋远端 flock（exit 75）；没有任何重试循环（健康轮询有上界）；没有 --force。
#
# 退出码：0 成功｜1 一般失败｜2 用法｜3 上线闸不满足｜10 无可用构建引擎｜20 新版不健康已自动回退｜21 回退后仍不健康｜75 持锁
set -euo pipefail

SSH_KEY="${CP_SSH_KEY:-${GW_SSH_KEY:-$HOME/.ssh/new.pem}}"
SSH_TARGET="${CP_SSH_TARGET:-${GW_SSH_TARGET:-ubuntu@43.172.85.76}}"
SSH_PORT="${CP_SSH_PORT:-${GW_SSH_PORT:-22443}}"
CP_DIR="${CP_DIR:-/opt/image-control-plane}"
COMPOSE_FILE="${CP_COMPOSE_FILE:-control-plane-compose.yml}"
COMPOSE_PROJECT="${CP_COMPOSE_PROJECT:-image-control-plane}"
API_CTR="${CP_API_CTR:-image-control-api}"
WORKER_CTR="${CP_WORKER_CTR:-image-control-worker}"
PG_CTR="${CP_PG_CTR:-image-control-postgres}"
NGINX_CTR="${CP_NGINX_CTR:-imagesite-nginx}"
API_REPO="${CP_API_REPO:-image-control-plane-generation-api}"
WORKER_REPO="${CP_WORKER_REPO:-image-control-plane-generation-worker}"
PUBLIC_READYZ="${CP_PUBLIC_READYZ:-https://store.tinchak0207.xyz/image-control/api/readyz}"
REMOTE_LOCK="${CP_REMOTE_LOCK:-$CP_DIR/.cp-prebuilt-release.lock}"
HARNESS_ROOT="${GW_HARNESS_ROOT:-/opt/agent-harness}"
ACTIVATION_LOCK="${HARNESS_ACTIVATION_LOCK:-$HARNESS_ROOT/.harness-activation.lock}"
MIN_DISK_GIB="${CP_MIN_DISK_GIB:-3}"
MIN_MEM_MIB="${CP_MIN_MEM_MIB:-400}"
MIN_SWAP_FREE_MIB="${CP_MIN_SWAP_FREE_MIB:-512}"
HEALTH_TIMEOUT="${CP_HEALTH_TIMEOUT:-120}"
BUILD_NETWORK="${CP_BUILD_NETWORK:-host}"
STATE_DIR="${CP_STATE_DIR:-$HOME/.local/state/eimu-cp-release}"
BUILD_ROOT="${CP_BUILD_ROOT:-$HOME/.cache/eimu-cp-release}"
# 与 deploy-control-plane.sh ARCHIVE_PATHS 同一份白名单（线上 app/ 构建上下文的来源）。
ARCHIVE_PATHS=(src public worker tools db bridge skills
  deploy-staging/expert-gateway deploy-staging/gateway
  package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json
  tailwind.config.ts postcss.config.mjs components.json)
# overlay 构建时先清掉底座里的旧源码目录（node_modules 不在其中），避免已删文件残留。
OVERLAY_CLEAN=(src public worker tools db bridge skills deploy-staging)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
ROOTLESS_SOCK="unix://$RUNTIME_DIR/docker.sock"

SHA=""; FULL_SHA=""; DRY_RUN=0; ROLLBACK_TO=""; ACK_BACKLOG=""; FULL_WORKER=0
ENGINE_HOST=""; ENGINE_KIND=""; PROBE=""

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
ssh_opts() { printf '%s\n' -i "$SSH_KEY" -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o BatchMode=yes; }
remote() { local -a o; mapfile -t o < <(ssh_opts); ssh "${o[@]}" -p "$SSH_PORT" "$SSH_TARGET" "$@"; }

# ── 构建引擎（与 site-release.sh 同顺序；本脚本不装/不起引擎，那归 site-release.sh engine-*）──
engine_try() { DOCKER_HOST="$1" timeout 15 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }
resolve_engine() {
  local -a cands=(); local h
  if [ -n "${CP_DOCKER_HOST:-}" ]; then cands=("$CP_DOCKER_HOST")
  else [ -n "${DOCKER_HOST:-}" ] && cands+=("$DOCKER_HOST"); cands+=("unix:///var/run/docker.sock" "$ROOTLESS_SOCK"); fi
  for h in "${cands[@]}"; do
    if engine_try "$h"; then
      ENGINE_HOST="$h"
      if DOCKER_HOST="$h" docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then ENGINE_KIND=rootless; else ENGINE_KIND=system; fi
      return 0
    fi
  done
  return 1
}
engine_unavailable() {
  log "ENGINE_UNAVAILABLE：没有可用的本机构建引擎（本脚本不 sudo）。免 sudo：bash deploy/vps/site-release.sh engine-install && bash deploy/vps/site-release.sh engine-up"
  exit 10
}

# ── 公共 ────────────────────────────────────────────────────────────────
need_sha() {
  [ -n "$SHA" ] || die "$1 必须显式 --sha <commit>（不默认 HEAD，见 release-ancestry-guard.sh 2026-10-30 事故）"
  FULL_SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$SHA^{commit}" 2>/dev/null)" || die "不认识的 commit：$SHA（先 git fetch origin）"
}
cand_tag() { printf '%s:cp-%s\n' "$1" "${FULL_SHA:0:9}"; }

REMOTE_INFLIGHT_FN='
site_inflight() {
  local hr="$1" now W=180000 a b c
  now=$(( $(date +%s) * 1000 ))
  a="$(sqlite3 -readonly -cmd ".timeout 3000" "$hr/state/sessions.db" "SELECT COUNT(*) FROM sessions WHERE json_extract(data,'"'"'\$.lastTurnActiveAt'"'"') > 0 AND ($now - json_extract(data,'"'"'\$.lastTurnActiveAt'"'"')) < $W;" 2>/dev/null || echo ERR)"
  b="$(sqlite3 -readonly -cmd ".timeout 3000" "$hr/state/sessions.db" "SELECT COUNT(*) FROM subagent_reworks;" 2>/dev/null || echo ERR)"
  c="$(sqlite3 -readonly -cmd ".timeout 3000" "$hr/workspace/.local/share/opencode/opencode.db" "SELECT COUNT(*) FROM message WHERE json_extract(data,'"'"'\$.role'"'"')='"'"'assistant'"'"' AND json_extract(data,'"'"'\$.time.completed'"'"') IS NULL AND ($now - time_updated) < $W;" 2>/dev/null || echo ERR)"
  case "$a$b$c" in *[!0-9]*|"") echo "ERR (sessions=$a subagent_reworks=$b opencode_streaming=$c)";; *) echo "$((a+b+c)) (sessions=$a subagent_reworks=$b opencode_streaming=$c)";; esac
}
gen_inflight() {
  local n
  n="$(docker exec "$1" psql -U image_control -d image_control -At -c "SELECT count(*) FROM generation_job WHERE status IN ('"'"'queued'"'"','"'"'leased'"'"','"'"'submitting'"'"','"'"'running'"'"','"'"'pending_billing'"'"')" 2>/dev/null || echo ERR)"
  case "$n" in ""|*[!0-9]*) echo ERR;; *) echo "$n";; esac
}
'

# 远端只读：线上状态＋上线闸原料（key=value）。不读 compose/env 的值，只读 image: 行。
remote_probe() {
  { printf '%s\n' "$REMOTE_INFLIGHT_FN"; cat; } <<'REMOTE' | remote "sudo -n bash -s -- $(printf '%q ' "$CP_DIR" "$COMPOSE_FILE" "$API_CTR" "$WORKER_CTR" "$PG_CTR" "$HARNESS_ROOT" "$ACTIVATION_LOCK" "$API_REPO" "$WORKER_REPO")"
set -uo pipefail
D="$1"; CF="$2"; A="$3"; W="$4"; PG="$5"; HR="$6"; AL="$7"; AR="$8"; WR="$9"
rev_of() { local img rev; img="$(docker inspect "$1" --format '{{.Config.Image}}' 2>/dev/null)"; rev="$(docker inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)"; [ -n "$rev" ] || case "$img" in *:git-*) rev="${img##*:git-}";; *:cp-*) rev="${img##*:cp-}";; esac; echo "$rev"; }
echo "live_api_image=$(docker inspect "$A" --format '{{.Config.Image}}' 2>/dev/null || echo NONE)"
echo "live_worker_image=$(docker inspect "$W" --format '{{.Config.Image}}' 2>/dev/null || echo NONE)"
echo "live_api_rev=$(rev_of "$A")"
echo "live_worker_rev=$(rev_of "$W")"
echo "live_api_state=$(docker inspect "$A" --format '{{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' 2>/dev/null)"
echo "live_worker_state=$(docker inspect "$W" --format '{{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' 2>/dev/null)"
echo "compose_images=$(grep -E '^\s*image:\s*('"$AR"'|'"$WR"'):' "$D/$CF" 2>/dev/null | sed 's/^\s*image:\s*//' | tr '\n' ' ')"
echo "cp_images=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^($AR|$WR):(git-|cp-)" | tr '\n' ' ')"
echo "anchor_state=$(cat "$D/releases/prebuilt/state.env" 2>/dev/null | tr '\n' ' ')"
echo "disk_avail_kib=$(df -Pk / | awk 'NR==2{print $4}')"
echo "disk_human=$(df -h / | awk 'NR==2{print $4" free / "$5" used"}')"
echo "mem_avail_mib=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)"
echo "swap_free_mib=$(awk '/^SwapFree:/{print int($2/1024)}' /proc/meminfo)"
echo "dstate=$(ps -eo stat= | grep -c '^D' || true)"
echo "oom_15m=$(journalctl -k --since '-15min' --no-pager 2>/dev/null | grep -c -i 'out of memory' || true)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "gen_inflight=$(gen_inflight "$PG")"
echo "gen_stranded=$(docker exec "$PG" psql -U image_control -d image_control -At -c "SELECT string_agg(status||'='||n, ',') FROM (SELECT status, count(*) n FROM generation_job WHERE status IN ('submit_unknown','billing_unknown') GROUP BY 1) s" 2>/dev/null)"
echo "gw_inflight=$(site_inflight "$HR")"
if [ -e "$AL" ]; then if flock -n "$AL" true 2>/dev/null; then echo "activation_lock=free"; else echo "activation_lock=HELD"; fi; else echo "activation_lock=absent"; fi
echo "api_readyz=$(docker exec "$A" wget -S -O /dev/null -T 8 http://127.0.0.1:3000/api/readyz 2>&1 | grep -m1 'HTTP/' | awk '{print $2}')"
REMOTE
}
kv() { sed -n "s/^$1=//p" <<<"$PROBE" | head -1; }

# 积压审计：线上修订 → 候选，按发版风险分类（只读 git）。命中即需 --ack-backlog。
backlog_audit() {
  local live="$1" cand="$2" files ui pay mig hits=0
  files="$(git -C "$REPO_ROOT" diff --name-only "$live" "$cand" -- "${ARCHIVE_PATHS[@]}" | grep -vE '\.test\.(ts|tsx|mjs)$|/test-preload\.ts$' || true)"
  echo "AUDIT range=${live:0:9}..${cand:0:9} files(非测试)=$(grep -c . <<<"$files" || true) commits=$(git -C "$REPO_ROOT" rev-list --count "$live..$cand")"
  ui="$(grep -E '^src/(components|hooks)/|^src/app/.*(page|layout)\.tsx$|^public/' <<<"$files" || true)"
  pay="$(grep -E '^src/lib/generation-core/(billing|sync-charge|task-response|refund)|^src/lib/(supplier-channels|model-routes)\.config\.ts$|^src/lib/mcp/tools/(director|agent|settings|toolset)\.ts$|^worker/' <<<"$files" || true)"
  mig="$(grep -E '^db/|migrat' <<<"$files" || true)"
  [ -z "$ui" ]  || { echo "AUDIT_RISK ui($(grep -c . <<<"$ui"))：$(tr '\n' ' ' <<<"$ui" | cut -c1-600)"; hits=1; }
  [ -z "$pay" ] || { echo "AUDIT_RISK paid_path($(grep -c . <<<"$pay"))：$(tr '\n' ' ' <<<"$pay")"; hits=1; }
  [ -z "$mig" ] || { echo "AUDIT_RISK migration($(grep -c . <<<"$mig"))：$(tr '\n' ' ' <<<"$mig")"; hits=1; }
  if git -C "$REPO_ROOT" diff --quiet "$live" "$cand" -- package.json package-lock.json; then echo "AUDIT deps=unchanged（worker 可 overlay）"; else echo "AUDIT deps=CHANGED（worker 需 --full-worker）"; fi
  [ "$hits" -eq 0 ] && echo "AUDIT_CLEAN"
  return "$hits"
}

gates_check() {
  local fail=0 disk mem swap oom dst gi gw lock r est="${1:-0}"
  disk="$(kv disk_avail_kib)"; mem="$(kv mem_avail_mib)"; swap="$(kv swap_free_mib)"; oom="$(kv oom_15m)"; dst="$(kv dstate)"
  gi="$(kv gen_inflight)"; gw="$(kv gw_inflight | cut -d' ' -f1)"; lock="$(kv activation_lock)"
  if [ "${disk:-0}" -ge $(( MIN_DISK_GIB * 1048576 )) ] 2>/dev/null && [ $(( ${disk:-0} - est / 1024 )) -ge $(( MIN_DISK_GIB * 1048576 )) ]; then
    echo "GATE disk OK ($(kv disk_human)；估算落盘 $(( est / 1048576 ))MiB 后剩 $(( (${disk:-0} - est / 1024) / 1024 ))MiB)"
  else echo "GATE disk FAIL ($(kv disk_human)；估算落盘 $(( est / 1048576 ))MiB 后剩 $(( (${disk:-0} - est / 1024) / 1024 ))MiB，需 ≥${MIN_DISK_GIB}GiB)"; fail=1; fi
  if [ "${mem:-0}" -ge "$MIN_MEM_MIB" ] 2>/dev/null && [ "${swap:-0}" -ge "$MIN_SWAP_FREE_MIB" ] 2>/dev/null && [ "${oom:-1}" = "0" ] && [ "${dst:-9}" -le 2 ] 2>/dev/null; then
    echo "GATE memory OK (MemAvailable=${mem}MiB SwapFree=${swap}MiB oom_15m=$oom D=$dst)"
  else echo "GATE memory FAIL (MemAvailable=${mem}MiB≥$MIN_MEM_MIB? SwapFree=${swap}MiB≥$MIN_SWAP_FREE_MIB? oom_15m=$oom=0? D=$dst≤2?)"; fail=1; fi
  if [ "$gi" = "0" ] && [ "$gw" = "0" ]; then echo "GATE inflight OK (generation=$gi gateway=$(kv gw_inflight))"; else echo "GATE inflight FAIL (generation=$gi gateway=$(kv gw_inflight))"; fail=1; fi
  if [ "$lock" != "HELD" ]; then echo "GATE activation_lock OK ($lock)"; else echo "GATE activation_lock FAIL（网关/opencode 发版进行中）"; fail=1; fi
  for r in "$(kv live_api_rev)" "$(kv live_worker_rev)"; do
    if [ -z "$r" ]; then echo "GATE ancestry FAIL（线上修订不可判定）"; fail=1
    elif ! git -C "$REPO_ROOT" cat-file -e "$r^{commit}" 2>/dev/null; then echo "GATE ancestry FAIL（本地没有线上修订 $r，先 git fetch origin）"; fail=1
    elif git -C "$REPO_ROOT" merge-base --is-ancestor "$r" "$FULL_SHA"; then echo "GATE ancestry OK (live ${r:0:9} ⊂ ${FULL_SHA:0:9})"
    else echo "GATE ancestry FAIL（候选 ${FULL_SHA:0:9} 不含线上 ${r:0:9}）"; fail=1; fi
  done
  return "$fail"
}

# 估算 VPS 新增落盘（字节）：containerd 存储下 .Size 已含压缩 blob＋解包快照（＝docker images 的 DISK USAGE）；
#   overlay worker 只算超出底座的部分；api 按整镜像算（与线上共享的 node 底层不扣，偏保守）。
estimate_bytes() {
  local a w b=0
  a="$(docker image inspect "$(cand_tag "$API_REPO")" --format '{{.Size}}' 2>/dev/null || echo 0)"
  w="$(docker image inspect "$(cand_tag "$WORKER_REPO")" --format '{{.Size}}' 2>/dev/null || echo 0)"
  [ "$(docker image inspect "$(cand_tag "$WORKER_REPO")" --format '{{index .Config.Labels "eimu.cp.worker.mode"}}' 2>/dev/null)" = overlay ] \
    && b="$(docker image inspect "$(kv live_worker_image)" --format '{{.Size}}' 2>/dev/null || echo 0)"
  echo $(( a + w - b ))
}

# ── 构建 ────────────────────────────────────────────────────────────────
cmd_fetch_base() {
  resolve_engine || engine_unavailable; export DOCKER_HOST="$ENGINE_HOST"
  PROBE="$(remote_probe)"; local img; img="$(kv live_worker_image)"
  case "$img" in "$WORKER_REPO":*) ;; *) die "读不到线上 worker 镜像：$img";; esac
  if docker image inspect "$img" >/dev/null 2>&1; then echo "FETCH_BASE_SKIP 本机已有 $img"; return 0; fi
  log "FETCH_BASE $img（VPS 只读 docker save 流式 → 本机 docker load，VPS 不落 tar）"
  remote "sudo -n docker save $(printf '%q' "$img")" | docker load | tail -1
  docker image inspect "$img" >/dev/null 2>&1 || die "底座拉取失败（不重试）"
  echo "FETCH_BASE_OK $img id=$(docker image inspect "$img" --format '{{.Id}}' | cut -c1-19)"
}

cmd_build() {
  need_sha build
  resolve_engine || engine_unavailable; export DOCKER_HOST="$ENGINE_HOST"
  local at wt dir p base live_rev mode t0; local -a present=()
  at="$(cand_tag "$API_REPO")"; wt="$(cand_tag "$WORKER_REPO")"
  if docker image inspect "$at" >/dev/null 2>&1 && docker image inspect "$wt" >/dev/null 2>&1; then echo "BUILD_REUSE api=$at worker=$wt"; smoke_local "$at" "$wt"; return 0; fi
  [ -n "$PROBE" ] || PROBE="$(remote_probe)"
  base="$(kv live_worker_image)"; live_rev="$(kv live_worker_rev)"
  mkdir -p "$STATE_DIR" "$BUILD_ROOT"
  dir="$BUILD_ROOT/src-${FULL_SHA:0:12}-$$"; [ ! -e "$dir" ] || die "构建目录已存在：$dir"; mkdir -p "$dir"
  for p in "${ARCHIVE_PATHS[@]}"; do git -C "$REPO_ROOT" cat-file -e "$FULL_SHA:$p" 2>/dev/null && present+=("$p"); done
  git -C "$REPO_ROOT" archive "$FULL_SHA" -- "${present[@]}" | tar -x -C "$dir"
  git -C "$REPO_ROOT" show "$FULL_SHA:deploy/vps/Dockerfile" > "$dir/Dockerfile"
  git -C "$REPO_ROOT" show "$FULL_SHA:.dockerignore" > "$dir/.dockerignore"
  local -a labels=(--label "org.opencontainers.image.revision=$FULL_SHA" --label "eimu.cp.engine=$ENGINE_KIND")
  t0=$(date +%s)
  log "BUILD api engine=$ENGINE_KIND sha=${FULL_SHA:0:9} tag=$at"
  docker build --network="$BUILD_NETWORK" -f "$dir/Dockerfile" --target runner -t "$at" "${labels[@]}" "$dir" || { rm -rf "$dir"; die "api 构建失败（不重试）"; }
  mode=full
  if [ "$FULL_WORKER" -ne 1 ]; then
    [ -n "$live_rev" ] && git -C "$REPO_ROOT" diff --quiet "$live_rev" "$FULL_SHA" -- package.json package-lock.json \
      || { rm -rf "$dir"; die "依赖与线上修订不同，worker 不能 overlay；确认要整层重建（落盘约 +1.3GB×2）请加 --full-worker"; }
    docker image inspect "$base" >/dev/null 2>&1 || { rm -rf "$dir"; die "本机没有底座 $base；先跑 fetch-base（只读 VPS）"; }
    mode=overlay
    { echo "FROM $base"; echo "WORKDIR /app"; echo "RUN rm -rf ${OVERLAY_CLEAN[*]}"; echo "COPY . ."; } > "$dir/Dockerfile.worker-overlay"
    log "BUILD worker overlay FROM $base tag=$wt"
    docker build --network="$BUILD_NETWORK" -f "$dir/Dockerfile.worker-overlay" -t "$wt" "${labels[@]}" --label "eimu.cp.worker.mode=overlay" --label "eimu.cp.worker.base=$base" "$dir" || { rm -rf "$dir"; die "worker overlay 构建失败（不重试）"; }
  else
    log "BUILD worker full tag=$wt"
    docker build --network="$BUILD_NETWORK" -f "$dir/Dockerfile" --target generation-worker -t "$wt" "${labels[@]}" --label "eimu.cp.worker.mode=full" "$dir" || { rm -rf "$dir"; die "worker 构建失败（不重试）"; }
  fi
  rm -rf "$dir"
  log "BUILD_DONE $(( $(date +%s) - t0 ))s worker_mode=$mode"
  smoke_local "$at" "$wt"
  echo "BUILD_OK api=$at($(docker image inspect "$at" --format '{{.Size}}')B) worker=$wt($(docker image inspect "$wt" --format '{{.Size}}')B mode=$mode)"
}

# 本机冒烟：不带任何 env/秘密；api 进程能起来并应答 HTTP；worker 源码与 tsx 在位、CMD 未变。
smoke_local() {
  local at="$1" wt="$2" name="cp-api-smoke-$$" code=""
  # 容器内 wget（与 VPS postcheck 同法），不经 rootless 端口转发；只认 healthz 200。
  docker run -d --rm --name "$name" "$at" >/dev/null
  for _ in $(seq 1 20); do
    code="$(docker exec "$name" wget -S -O /dev/null -T 5 http://127.0.0.1:3000/api/healthz 2>&1 | grep -m1 'HTTP/' | awk '{print $2}' || true)"
    [ "$code" = 200 ] && break; sleep 2
  done
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "SMOKE api healthz=${code:-无回应}"
  [ "$code" = 200 ] || die "api 冒烟失败：healthz≠200（镜像已建未上线）"
  docker run --rm --entrypoint sh "$wt" -c 'test -f /app/worker/generation-worker.ts && test -f /app/tools/control-plane-bootstrap.ts && test -d /app/node_modules/tsx' \
    || die "worker 冒烟失败：源码/tsx 不在位"
  [ "$(docker image inspect "$wt" --format '{{json .Config.Cmd}}')" = '["npm","run","generation:bootstrap"]' ] || die "worker CMD 与线上配方不同"
  echo "SMOKE worker OK"
}

# ── 远端换装（release / rollback 共用）──────────────────────────────────
# $1 D $2 CF $3 PROJECT $4 NEW_API $5 NEW_WORKER $6 A $7 W $8 PG $9 NGINX ${10} HR ${11} HT ${12} MIN_DISK_KIB ${13} NOTE
REMOTE_ACTIVATE='
set -uo pipefail
D="$1"; CF="$2"; PJ="$3"; NA="$4"; NW="$5"; A="$6"; W="$7"; PG="$8"; NG="$9"; HR="${10}"; HT="${11}"; MINK="${12}"; NOTE="${13}"
cd "$D" || { echo "ABORT 无 $D"; exit 1; }
BK=""; DONE=0
dc() { docker compose -p "$PJ" -f "$CF" "$@"; }
readyz() { docker exec "$A" wget -S -O /dev/null -T 8 http://127.0.0.1:3000/api/readyz 2>&1 | grep -m1 "HTTP/" | awk "{print \$2}"; }
healthy() {
  local i=0 c=""
  while [ "$i" -lt "$HT" ]; do c="$(readyz)"; [ "$c" = 200 ] && break; sleep 3; i=$((i+3)); done
  [ "$c" = 200 ] || { echo "HEALTH readyz=${c:-无} after ${HT}s"; return 1; }
  echo "HEALTH readyz 200 after ${i}s"
  [ -n "$(docker exec "$A" printenv OPENAI_COMPAT_GENERATION_ORIGIN 2>/dev/null)" ] || { echo "HEALTH api OPENAI_COMPAT_GENERATION_ORIGIN 为空"; return 1; }
  c="$(docker exec "$A" wget -S -O /dev/null -T 10 http://127.0.0.1:3000/api/v1/models 2>&1 | grep -m1 "HTTP/" | awk "{print \$2}")"
  case "$c" in 401|200) echo "HEALTH /api/v1/models $c";; *) echo "HEALTH /api/v1/models=${c:-无}（400＝middleware 自代理回圈）"; return 1;; esac
  local b n; b="$(docker inspect -f "{{.State.Status}} {{.RestartCount}}" "$W" 2>/dev/null || echo "missing -1")"; sleep 30
  n="$(docker inspect -f "{{.State.Status}} {{.RestartCount}}" "$W" 2>/dev/null || echo "missing -1")"
  [ "${n%% *}" = running ] && [ "${n##* }" = "${b##* }" ] || { echo "HEALTH worker 前=[$b] 30s 后=[$n]"; docker logs --tail 20 "$W" 2>&1 | sed "s/^/  worker| /"; return 1; }
  echo "HEALTH worker running restarts=${n##* }（30s 稳定）"
  docker exec "$NG" nginx -t -q && docker exec "$NG" nginx -s reload && echo "NGINX reloaded" || { echo "HEALTH nginx -t/reload 失败"; return 1; }
}
swap_lines() {
  # 只替换与「旧镜像」逐字相等的两行 image:，其余字节不动（compose 内含秘密，从不打印）。
  awk -v oa="image: $1" -v na="image: $3" -v ow="image: $2" -v nw="image: $4" "{ t=\$0; sub(/^[ \t]+/, \"\", t); if (t==oa) sub(/image: .*/, na); else if (t==ow) sub(/image: .*/, nw); print }" "$CF" > "$CF.cp-new" \
    && cat "$CF.cp-new" > "$CF" && rm -f "$CF.cp-new"
}
restore() {
  [ -n "$BK" ] || return 0
  echo "ROLLBACK_BEGIN → $OA / $OW"
  cat "$BK" > "$CF"
  dc up -d --no-build --no-deps generation-api generation-worker 2>&1 | tail -3
  if healthy; then echo "ROLLED_BACK api=$OA worker=$OW"; exit 20; fi
  echo "ROLLBACK_UNHEALTHY 需人工（compose 已还原为 $BK）"; exit 21
}
trap '"'"'rc=$?; if [ "$DONE" -ne 1 ] && [ -n "$BK" ]; then restore; fi; exit $rc'"'"' EXIT
trap "exit 130" INT; trap "exit 143" TERM; trap "exit 129" HUP
OA="$(docker inspect "$A" --format "{{.Config.Image}}")"; OW="$(docker inspect "$W" --format "{{.Config.Image}}")"
docker image inspect "$NA" >/dev/null 2>&1 && docker image inspect "$NW" >/dev/null 2>&1 || { echo "ABORT 目标镜像不在 VPS：$NA / $NW"; exit 1; }
[ "$OA|$OW" != "$NA|$NW" ] || { echo "NOOP 线上已是 $NA / $NW"; DONE=1; exit 0; }
grep -Eq "^[[:space:]]*image: $OA\$" "$CF" && grep -Eq "^[[:space:]]*image: $OW\$" "$CF" || { echo "ABORT compose 的 image: 行与在跑容器不一致（有人手改过），拒发"; exit 1; }
fk="$(df -Pk / | awk "NR==2{print \$4}")"
[ "$fk" -ge "$MINK" ] || { echo "ABORT 根盘可用 $((fk/1024))MiB < 闸 $((MINK/1024))MiB"; exit 3; }
gi="$(gen_inflight "$PG")"; gw="$(site_inflight "$HR")"
[ "$gi" = 0 ] && case "$gw" in 0\ *) true;; *) false;; esac || { echo "ABORT 换装前终检在途≠0：generation=$gi gateway=$gw（新镜像留在 VPS，旧版未动；不重试）"; exit 3; }
echo "FINAL_INFLIGHT generation=0 gateway=$gw disk_free=$((fk/1024))MiB"
mkdir -p "$D/releases/prebuilt"
BK="$D/releases/prebuilt/$(basename "$CF").bak-$(date +%Y%m%d%H%M%S)"
cp -p "$CF" "$BK" && chmod 600 "$BK"
swap_lines "$OA" "$OW" "$NA" "$NW"
grep -Eq "^[[:space:]]*image: $NA\$" "$CF" && grep -Eq "^[[:space:]]*image: $NW\$" "$CF" && dc config -q || { echo "ABORT compose 改写后校验失败"; exit 1; }
echo "SWAP api $OA → $NA ; worker $OW → $NW（compose 备份 $BK）"
dc up -d --no-build --no-deps generation-api generation-worker 2>&1 | tail -4
healthy || exit 1
DONE=1
printf "ACTIVE_API=%s\nACTIVE_WORKER=%s\nANCHOR_API=%s\nANCHOR_WORKER=%s\nCOMPOSE_BACKUP=%s\nAT=%s\n" "$NA" "$NW" "$OA" "$OW" "$BK" "$(date -u +%FT%TZ)" > "$D/releases/prebuilt/state.env"
printf "%s\t%s\tapi=%s\tworker=%s\tanchor_api=%s\tanchor_worker=%s\tnote=%s\n" "$(date -u +%FT%TZ)" "$(id -un)" "$NA" "$NW" "$OA" "$OW" "$NOTE" >> "$D/releases/prebuilt/history.tsv"
echo "RELEASED api=$NA worker=$NW rollback_anchor=$OA,$OW disk_free=$(df -h / | awk "NR==2{print \$4}")"
'

remote_activate() {
  remote "sudo -n flock -n -E 75 $(printf '%q' "$REMOTE_LOCK") bash -c $(printf '%q' "$REMOTE_INFLIGHT_FN$REMOTE_ACTIVATE") cp-activate $(printf '%q ' \
    "$CP_DIR" "$COMPOSE_FILE" "$COMPOSE_PROJECT" "$1" "$2" "$API_CTR" "$WORKER_CTR" "$PG_CTR" "$NGINX_CTR" "$HARNESS_ROOT" "$HEALTH_TIMEOUT" "$(( MIN_DISK_GIB * 1048576 ))" "$3")"
}

# 流式 load：本机 docker save | gzip → ssh → VPS gunzip | docker load；VPS 不落 tar（盘只多出新层）。
ship() {
  local at="$1" wt="$2" lsig rsig
  log "SHIP $at $wt（流式，VPS 不落 tar）"
  docker save "$at" "$wt" | gzip -1 | remote "sudo -n flock -n -E 75 $(printf '%q' "$REMOTE_LOCK") sh -c 'gunzip | docker load'" | tail -2 || die "传输/load 失败（不重试）"
  lsig="$(for i in "$at" "$wt"; do docker image inspect "$i" --format '{{json .RootFS.Layers}}'; done | sha256sum | cut -c1-16)"
  rsig="$(remote "sudo -n sh -c 'for i in $(printf '%q ' "$at" "$wt"); do docker image inspect \$i --format \"{{json .RootFS.Layers}}\"; done'" | sha256sum | cut -c1-16)"
  [ "$lsig" = "$rsig" ] || die "VPS 上镜像层与本机不一致（local=$lsig remote=$rsig），不换装"
  echo "SHIP_OK layers_sig=$lsig"
}

with_local_lock() { mkdir -p "$STATE_DIR"; exec 9>"$STATE_DIR/cp-release.lock"; flock -n 9 || { log "CP_RELEASE_LOCKED 本机另一控面发版进行中"; exit 75; }; }

cmd_status() { PROBE="$(remote_probe)"; printf '%s\n' "$PROBE"; }
cmd_audit() { need_sha audit; PROBE="$(remote_probe)"; backlog_audit "$(kv live_worker_rev)" "$FULL_SHA" || true; }

cmd_preflight() {
  need_sha preflight
  local est=0 rc=0
  if resolve_engine; then echo "ENGINE_OK kind=$ENGINE_KIND host=$ENGINE_HOST"; export DOCKER_HOST="$ENGINE_HOST"; else echo "ENGINE_UNAVAILABLE（build 会 exit 10）"; fi
  PROBE="$(remote_probe)"; printf '%s\n' "$PROBE"
  echo "candidate api=$(cand_tag "$API_REPO") worker=$(cand_tag "$WORKER_REPO")"
  [ -n "$ENGINE_HOST" ] && est="$(estimate_bytes)"
  [ "$est" -gt 0 ] || echo "ESTIMATE 候选镜像尚未构建，盘闸只按现值判断（release 构建后会按估算复检）"
  backlog_audit "$(kv live_worker_rev)" "$FULL_SHA" || { [ -n "$ACK_BACKLOG" ] && echo "AUDIT_ACK：$ACK_BACKLOG" || { echo "GATE backlog FAIL（需暴君拍板后 --ack-backlog \"理由\"）"; rc=3; }; }
  gates_check "$est" || rc=3
  [ "$rc" -eq 0 ] && echo "PREFLIGHT_OK" || echo "PREFLIGHT_BLOCKED"
  return "$rc"
}

cmd_release() {
  need_sha release
  with_local_lock
  PROBE="$(remote_probe)"
  backlog_audit "$(kv live_worker_rev)" "$FULL_SHA" || { [ -n "$ACK_BACKLOG" ] || { echo "RELEASE_BLOCKED 积压含 UI/付费路径/迁移改动，需暴君拍板后带 --ack-backlog \"理由\"（未构建/未上传/未换装）"; exit 3; }; echo "AUDIT_ACK：$ACK_BACKLOG"; }
  gates_check 0 || { echo "RELEASE_BLOCKED（上线闸不满足，未构建/未上传/未换装）"; exit 3; }
  cmd_build
  local at wt est rc=0
  at="$(cand_tag "$API_REPO")"; wt="$(cand_tag "$WORKER_REPO")"
  PROBE="$(remote_probe)"; est="$(estimate_bytes)"
  gates_check "$est" || { echo "RELEASE_BLOCKED（构建后复检闸不满足，未上传/未换装；镜像留在本机 $at $wt）"; exit 3; }
  if [ "$DRY_RUN" -eq 1 ]; then echo "DRY_RUN 构建＋冒烟＋闸已过，未上传：api=$at worker=$wt"; return 0; fi
  ship "$at" "$wt"
  remote_activate "$at" "$wt" "release ${FULL_SHA:0:12} ack=${ACK_BACKLOG:-none}" || rc=$?
  [ "$rc" -eq 0 ] || { echo "RELEASE_FAILED rc=$rc（见上方 ROLLED_BACK/ROLLBACK_UNHEALTHY；不重试）"; exit "$rc"; }
  local code; code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$PUBLIC_READYZ" || echo ERR)"
  [ "$code" = 200 ] && echo "RELEASE_OK api=$at worker=$wt public_readyz=200 rollback：bash deploy/vps/control-plane-prebuilt-release.sh rollback" \
    || { echo "RELEASE_VERIFY_FAIL public_readyz=$code（容器内健康已过；回滚：bash deploy/vps/control-plane-prebuilt-release.sh rollback）"; exit 1; }
}

cmd_rollback() {
  with_local_lock
  PROBE="$(remote_probe)"; printf '%s\n' "$PROBE" | grep -E '^(live_api_image|live_worker_image|cp_images|anchor_state|gen_inflight|gw_inflight|disk_human)='
  local ta tw suf
  if [ -n "$ROLLBACK_TO" ]; then
    case "$ROLLBACK_TO" in git-*|cp-*) suf="$ROLLBACK_TO";; *) suf="cp-${ROLLBACK_TO:0:9}";; esac
    ta="$API_REPO:$suf"; tw="$WORKER_REPO:$suf"
  else
    ta="$(kv anchor_state | tr ' ' '\n' | sed -n 's/^ANCHOR_API=//p')"; tw="$(kv anchor_state | tr ' ' '\n' | sed -n 's/^ANCHOR_WORKER=//p')"
    [ -n "$ta" ] && [ -n "$tw" ] || die "VPS 没有发版记录（releases/prebuilt/state.env）；请 --to <git-xxxx|cp-xxxx|sha>"
  fi
  [ "$(kv gen_inflight)" = 0 ] && [ "$(kv gw_inflight | cut -d' ' -f1)" = 0 ] || { echo "ROLLBACK_BLOCKED inflight≠0（不重试）"; exit 3; }
  remote_activate "$ta" "$tw" "rollback"
}

usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

parse_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --sha) SHA="${2:-}"; shift 2 ;;
      --to) ROLLBACK_TO="${2:-}"; shift 2 ;;
      --ack-backlog) ACK_BACKLOG="$(printf '%s' "${2:-}" | tr '\n\r\t' '   ')"; [ "${#ACK_BACKLOG}" -ge 8 ] || die "--ack-backlog 需要 ≥8 字理由"; shift 2 ;;
      --full-worker) FULL_WORKER=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --force) die "本脚本没有 --force（闸不满足就停，见 AGENTS.md）" ;;
      -h|--help) usage; exit 0 ;;
      *) log "未知参数：$1"; usage >&2; exit 2 ;;
    esac
  done
}

main() {
  local sub="${1:-}"; [ $# -gt 0 ] && shift
  case "$sub" in
    status) parse_flags "$@"; cmd_status ;;
    audit) parse_flags "$@"; cmd_audit ;;
    preflight) parse_flags "$@"; cmd_preflight ;;
    fetch-base) parse_flags "$@"; with_local_lock; cmd_fetch_base ;;
    build) parse_flags "$@"; with_local_lock; cmd_build ;;
    release) parse_flags "$@"; cmd_release ;;
    rollback) parse_flags "$@"; cmd_rollback ;;
    ''|-h|--help|help) usage ;;
    *) log "未知子命令：$sub"; usage >&2; exit 2 ;;
  esac
}
main "$@"
