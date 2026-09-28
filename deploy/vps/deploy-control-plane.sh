#!/usr/bin/env bash
# 控面一鍵部署：plan（唯讀，預設）／deploy／rollback [tag]
#
# 來源＝本機 git HEAD（不是 working tree）。控面＝VPS /opt/image-control-plane（無 git 手搬副本）。
#   plan     git archive HEAD → 與 VPS app/ 做 checksum 比對 → 雙向 diff 閘（BLOCKED＝VPS 獨有修改）
#            → compose 漂移（只印鍵名）→ 磁碟。不改 VPS 任何東西。
#   deploy   plan 無 BLOCKED（或逐檔 --allow-overwrite）→ preflight → 磁碟閘 → rollback tag
#            → 同步 → compose build → git tag → up -d → 重啟 imagesite-nginx → postcheck（失敗自動回滾）
#   rollback [tag]  不給 tag 用最新的 :rollback-*
#
# 用法：
#   deploy/vps/deploy-control-plane.sh [plan]
#   deploy/vps/deploy-control-plane.sh deploy [--allow-overwrite <path>]...
#   deploy/vps/deploy-control-plane.sh rollback [rollback-YYYYmmddHHMMSS]
#
# 22443 連續快速連線會被 RST ⇒ 整次執行共用一條 SSH ControlMaster 連線。
# compose 檔 control-plane-compose.yml 是 VPS 自有（含 secret），本腳本永不覆寫、永不印值。
set -euo pipefail

VPS_HOST="${VPS_HOST:-ubuntu@43.172.85.76}"
VPS_PORT="${VPS_PORT:-22443}"
VPS_KEY="${VPS_KEY:-/home/lenovo/.ssh/new.pem}"
CP_DIR="${CP_DIR:-/opt/image-control-plane}"
APP_DIR="$CP_DIR/app"
COMPOSE_FILE="control-plane-compose.yml"
API_IMAGE="image-control-plane-generation-api"
WORKER_IMAGE="image-control-plane-generation-worker"
API_CTR="image-control-api"
WORKER_CTR="image-control-worker"
NGINX_CTR="imagesite-nginx"
SERVICES=(generation-api generation-worker)
ROLLBACK_KEEP=3

# git archive 白名單（與 .dockerignore 一致）；另 deploy/vps/Dockerfile → Dockerfile、.dockerignore → .dockerignore
ARCHIVE_PATHS=(src public worker tools db bridge skills
  deploy-staging/expert-gateway deploy-staging/gateway
  package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json
  tailwind.config.ts postcss.config.mjs components.json)
# 目的路徑（VPS app/ 相對）→ repo 路徑；未列者同名
declare -A SRC_OF=([Dockerfile]=deploy/vps/Dockerfile [.dockerignore]=.dockerignore)

SSH_OPTS=(-i "$VPS_KEY" -p "$VPS_PORT"
  -o ControlMaster=auto -o ControlPath=/tmp/cp-deploy-%C -o ControlPersist=120
  -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30)

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

STAGE=""
WORK=""
cleanup() {
  [[ -n "$STAGE" && -d "$STAGE" ]] && rm -rf "$STAGE"
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"
  ssh "${SSH_OPTS[@]}" -O exit "$VPS_HOST" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log()  { printf '%s\n' "$*"; }
hdr()  { printf '\n==== %s ====\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

rsh() { ssh "${SSH_OPTS[@]}" "$VPS_HOST" "$@"; }

ssh_master_open() {
  if ! ssh "${SSH_OPTS[@]}" -O check "$VPS_HOST" >/dev/null 2>&1; then
    ssh "${SSH_OPTS[@]}" -fN "$VPS_HOST" || die "SSH ControlMaster 建立失敗（$VPS_HOST:$VPS_PORT）"
  fi
}

# VPS 端 checksum 比對器。stdin：每行 "<相對路徑>\t<本機md5 或 ->"。
# 輸出：NEW\t<path>｜OVER\t<path>\t<VPS md5 或 NOTFILE>（本機 md5 為 - 時一律輸出 OVER 附 VPS md5）
REMOTE_MD5_PY='
import hashlib, os, sys
root = sys.argv[1]
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    rel, local = line.split("\t", 1)
    p = os.path.join(root, rel)
    if not os.path.lexists(p):
        print("NEW\t" + rel); continue
    if os.path.islink(p) or not os.path.isfile(p):
        print("OVER\t%s\tNOTFILE" % rel); continue
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    m = h.hexdigest()
    if local == "-" or m != local:
        print("OVER\t%s\t%s" % (rel, m))
'
remote_md5() { rsh "sudo -n python3 -c $(printf '%q' "$REMOTE_MD5_PY") $(printf '%q' "$APP_DIR")"; }

# 本機 stage 清單：<path>\t<md5>（排除 node_modules/）
LOCAL_MANIFEST_PY='
import hashlib, os, sys
root = sys.argv[1]
for d, dirs, files in os.walk(root):
    dirs[:] = sorted(x for x in dirs if x != "node_modules")
    for fn in sorted(files):
        p = os.path.join(d, fn)
        h = hashlib.md5()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        print("%s\t%s" % (os.path.relpath(p, root), h.hexdigest()))
'

# compose config JSON → service 名＋environment 鍵名（永不印值）
COMPOSE_KEYS_PY='
import json, sys
d = json.load(sys.stdin)
def keys(env):
    if isinstance(env, dict):
        return sorted(env.keys())
    return sorted(e.split("=", 1)[0] for e in (env or []))
for name, svc in d.get("services", {}).items():
    k = keys(svc.get("environment"))
    print("service %s  image=%s  env_keys(%d): %s" % (name, svc.get("image", "-"), len(k), " ".join(k)))
api = keys(d.get("services", {}).get("generation-api", {}).get("environment"))
print("generation-api OPENAI_COMPAT_GENERATION_ORIGIN: " + ("present" if "OPENAI_COMPAT_GENERATION_ORIGIN" in api else "MISSING"))
'

# 該 repo 路徑歷史上所有 blob 的 md5（git log --all 逐版）
hist_md5s() {
  local src="$1"
  git log --all --format=%H -- "$src" \
    | awk -v p="$src" '{print $0 ":" p}' \
    | git cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null \
    | awk '$2=="blob"{print $1}' | sort -u \
    | while read -r blob; do git cat-file blob "$blob" | md5sum | cut -d' ' -f1; done
}

# ---------------------------------------------------------------- plan
HEAD_SHA=""; SHORT=""
NEW_FILES=(); OVER_FILES=(); OK_FILES=(); BLOCKED_FILES=(); BLOCKED_MD5=()
USE_RSYNC=0

do_plan() {
  HEAD_SHA="$(git rev-parse HEAD)"; SHORT="$(git rev-parse --short=8 HEAD)"
  hdr "來源：git HEAD $SHORT（$(git log -1 --format=%s HEAD | cut -c1-80)）"

  # 1. git archive HEAD → stage
  STAGE="$(mktemp -d /tmp/cp-deploy-stage.XXXXXX)"
  WORK="$(mktemp -d /tmp/cp-deploy-work.XXXXXX)"
  local present=() p
  for p in "${ARCHIVE_PATHS[@]}"; do
    if git cat-file -e "HEAD:$p" 2>/dev/null; then present+=("$p"); else log "略過（HEAD 無此路徑）：$p"; fi
  done
  git archive --format=tar HEAD -- "${present[@]}" | tar -x -C "$STAGE"
  git show "HEAD:deploy/vps/Dockerfile" >"$STAGE/Dockerfile"
  git show "HEAD:.dockerignore" >"$STAGE/.dockerignore"
  log "stage：$(find "$STAGE" -type f | wc -l) 檔，$(du -sh "$STAGE" | cut -f1)"

  # 2. working tree 相對 HEAD 的未提交改動（只警告）
  local dirty
  dirty="$(git status --porcelain -- "${present[@]}" deploy/vps/Dockerfile .dockerignore)"
  if [[ -n "$dirty" ]]; then
    warn "下列部署路徑在 working tree 有未提交改動（部署的是 HEAD，這些改動不會上線）："
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
  fi

  # 3. 比對 stage vs VPS app/（rsync -rlc --dry-run；本機無 rsync 時退 checksum 清單，判準等價）
  ssh_master_open
  if command -v rsync >/dev/null 2>&1 && rsh 'command -v rsync' >/dev/null 2>&1; then
    USE_RSYNC=1
  fi
  hdr "比對 stage → $VPS_HOST:$APP_DIR（$([[ $USE_RSYNC == 1 ]] && echo 'rsync -rlc --dry-run' || echo '本機無 rsync：md5 清單比對')）"
  local line kind rel md5
  if [[ $USE_RSYNC == 1 ]]; then
    local rsync_e; rsync_e="ssh $(printf '%q ' "${SSH_OPTS[@]}")"
    rsync -rlc --dry-run --itemize-changes --exclude 'node_modules/' \
      -e "$rsync_e" --rsync-path='sudo -n rsync' \
      "$STAGE/" "$VPS_HOST:$APP_DIR/" >"$WORK/itemize"
    while IFS= read -r line; do
      case "$line" in
        '<f+++++++++ '*) NEW_FILES+=("${line#* }") ;;
        '<f'*) OVER_FILES+=("${line#* }") ;;
      esac
    done <"$WORK/itemize"
    if ((${#OVER_FILES[@]})); then
      printf '%s\t-\n' "${OVER_FILES[@]}" | remote_md5 >"$WORK/over"
    else
      : >"$WORK/over"
    fi
    OVER_FILES=()
  else
    python3 -c "$LOCAL_MANIFEST_PY" "$STAGE" >"$WORK/manifest"
    remote_md5 <"$WORK/manifest" >"$WORK/diff"
    while IFS=$'\t' read -r kind rel md5; do
      [[ $kind == NEW ]] && NEW_FILES+=("$rel")
    done <"$WORK/diff"
    grep '^OVER' "$WORK/diff" >"$WORK/over" || true
  fi

  # 4. 雙向 diff 閘：VPS md5 ∈ 此路徑 repo 歷史任一版 ⇒ VPS 只是落後（可覆寫）；否則 BLOCKED
  local src hist
  while IFS=$'\t' read -r kind rel md5; do
    OVER_FILES+=("$rel")
    src="${SRC_OF[$rel]:-$rel}"
    hist="$(hist_md5s "$src")"   # 先收集再比對：grep -q 提前退出會讓 pipefail 誤判
    if [[ $md5 != NOTFILE ]] && grep -qx "$md5" <<<"$hist"; then
      OK_FILES+=("$rel")
    else
      BLOCKED_FILES+=("$rel"); BLOCKED_MD5+=("$md5")
    fi
  done <"$WORK/over"

  if ((${#NEW_FILES[@]})); then
    hdr "VPS 新增（${#NEW_FILES[@]}）"; printf '  + %s\n' "${NEW_FILES[@]}"
  fi
  if ((${#OK_FILES[@]})); then
    hdr "VPS 將被覆寫・可覆寫（VPS 版＝repo 歷史某版，只是落後）（${#OK_FILES[@]}）"; printf '  ~ %s\n' "${OK_FILES[@]}"
  fi
  if ((${#BLOCKED_FILES[@]})); then
    hdr "BLOCKED・VPS 獨有修改（VPS md5 不在 repo 歷史）（${#BLOCKED_FILES[@]}）"
    local i
    for i in "${!BLOCKED_FILES[@]}"; do printf '  ! %s  vps_md5=%s\n' "${BLOCKED_FILES[$i]}" "${BLOCKED_MD5[$i]}"; done
  fi

  # 5. compose 漂移（只報不改；只印鍵名）
  hdr "compose 漂移檢查（$CP_DIR/$COMPOSE_FILE，只印鍵名）"
  local cq; cq="cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE"
  rsh "$cq config --format json 2>/dev/null | python3 -c $(printf '%q' "$COMPOSE_KEYS_PY")" \
    || warn "compose config 解析失敗"
  # compose 插值警告（只含變數名，例如未設定的 \${VAR}）
  rsh "$cq config -q 2>&1 >/dev/null | grep -o 'msg=.*' | sort -u | sed 's/^/compose warning: /'" || true

  # 6. 磁碟
  hdr "磁碟"
  rsh 'df -h / && echo && sudo -n docker system df'

  # 7. 摘要
  hdr "摘要"
  log "HEAD：$SHORT（$HEAD_SHA）"
  log "將新增：${#NEW_FILES[@]}"
  log "將覆寫：${#OVER_FILES[@]}（可覆寫 ${#OK_FILES[@]}／BLOCKED ${#BLOCKED_FILES[@]}）"
  if ((${#BLOCKED_FILES[@]})); then
    local i
    for i in "${!BLOCKED_FILES[@]}"; do log "  BLOCKED ${BLOCKED_FILES[$i]}  vps_md5=${BLOCKED_MD5[$i]}"; done
  fi
}

# ---------------------------------------------------------------- postcheck / rollback
postcheck() {
  local ok=0 i out base now
  hdr "postcheck"
  if rsh "[ -n \"\$(sudo -n docker exec $API_CTR printenv OPENAI_COMPAT_GENERATION_ORIGIN 2>/dev/null)\" ]"; then
    log "OK   $API_CTR OPENAI_COMPAT_GENERATION_ORIGIN 非空"
  else
    log "FAIL $API_CTR OPENAI_COMPAT_GENERATION_ORIGIN 為空或容器不在"; ok=1
  fi
  out=""
  for i in $(seq 1 20); do
    if out="$(rsh "sudo -n docker exec $API_CTR wget -S -O /dev/null http://127.0.0.1:3000/api/healthz 2>&1 | grep -m1 'HTTP/'")" \
      && grep -q ' 200' <<<"$out"; then break; fi
    out="${out:-no response}"; sleep 3
  done
  if grep -q ' 200' <<<"$out"; then log "OK   healthz ${out# *}"; else log "FAIL healthz：${out}"; ok=1; fi
  base="$(rsh "sudo -n docker inspect -f '{{.State.Status}} {{.RestartCount}}' $WORKER_CTR" 2>/dev/null || echo 'missing -1')"
  sleep 30
  now="$(rsh "sudo -n docker inspect -f '{{.State.Status}} {{.RestartCount}}' $WORKER_CTR" 2>/dev/null || echo 'missing -1')"
  if [[ ${now%% *} == running && ${now##* } == "${base##* }" && ${base##* } != -1 ]]; then
    log "OK   $WORKER_CTR 30s 後 running，RestartCount=${now##* }"
  else
    log "FAIL $WORKER_CTR 前=[$base] 30s 後=[$now]"; ok=1
  fi
  return $ok
}

latest_rollback_tag() {
  rsh "sudo -n docker image ls $API_IMAGE --format '{{.Tag}}'" | grep '^rollback-' | sort -r | head -n1
}

do_rollback() {  # $1=tag（可空）；postcheck 失敗只報錯，不遞迴回滾
  local tag="${1:-}"
  ssh_master_open
  [[ -n "$tag" ]] || tag="$(latest_rollback_tag || true)"
  [[ -n "$tag" ]] || die "找不到任何 :rollback-* tag"
  hdr "rollback → :$tag"
  rsh "set -e; sudo -n docker image inspect $API_IMAGE:$tag $WORKER_IMAGE:$tag >/dev/null
       sudo -n docker tag $API_IMAGE:$tag $API_IMAGE:latest
       sudo -n docker tag $WORKER_IMAGE:$tag $WORKER_IMAGE:latest
       cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE up -d --no-build ${SERVICES[*]}
       sudo -n docker restart $NGINX_CTR >/dev/null && echo 'restarted $NGINX_CTR'"
  if postcheck; then log "rollback 完成，postcheck 通過"; else log "rollback 後 postcheck 失敗（不再遞迴回滾），請人工處理"; return 1; fi
}

# ---------------------------------------------------------------- deploy
do_deploy() {
  local allow=() a i blocked_left=()
  while (($#)); do
    case "$1" in
      --allow-overwrite) [[ $# -ge 2 ]] || die "--allow-overwrite 需要路徑"; allow+=("$2"); shift 2 ;;
      *) die "未知參數：$1" ;;
    esac
  done

  do_plan
  for i in "${!BLOCKED_FILES[@]}"; do
    local hit=0
    for a in "${allow[@]}"; do [[ $a == "${BLOCKED_FILES[$i]}" ]] && hit=1; done
    ((hit)) || blocked_left+=("${BLOCKED_FILES[$i]}")
  done
  if ((${#blocked_left[@]})); then
    printf '  %s\n' "${blocked_left[@]}" >&2
    die "有 ${#blocked_left[@]} 個 BLOCKED（VPS 獨有修改）未放行；先把 VPS 修改回灌 repo，或逐一 --allow-overwrite <path>"
  fi

  # 1. preflight
  hdr "preflight"
  if [[ -f src/lib/control-plane-proxy-routes.test.ts ]]; then
    npx tsx --test src/lib/control-plane-proxy-routes.test.ts
  else
    log "略過：src/lib/control-plane-proxy-routes.test.ts 不存在"
  fi

  # 2. 磁碟閘
  hdr "磁碟閘"
  local avail
  avail="$(rsh "df -B1G --output=avail / | tail -n1 | tr -d ' '")"
  log "可用 ${avail}G"
  if ((avail < 6)); then
    log "< 6G → prune builder cache(>72h) 與 dangling image"
    rsh "sudo -n docker builder prune -f --keep-storage 2gb && sudo -n docker image prune -f"
    avail="$(rsh "df -B1G --output=avail / | tail -n1 | tr -d ' '")"
    log "prune 後可用 ${avail}G"
    ((avail >= 4)) || die "可用空間 ${avail}G < 4G，中止"
  fi

  # 3. 版本化：現役 :latest → :rollback-<UTC>，各留最近 $ROLLBACK_KEEP 個
  local ts rb_tag
  ts="$(date -u +%Y%m%d%H%M%S)"; rb_tag="rollback-$ts"
  hdr "rollback tag :$rb_tag"
  rsh "set -e
       for img in $API_IMAGE $WORKER_IMAGE; do
         sudo -n docker tag \$img:latest \$img:$rb_tag
         for old in \$(sudo -n docker image ls \$img --format '{{.Tag}}' | grep '^rollback-' | sort -r | tail -n +$((ROLLBACK_KEEP + 1))); do
           sudo -n docker rmi \$img:\$old
         done
         sudo -n docker image ls \$img --format '  {{.Repository}}:{{.Tag}} {{.ID}}' | grep rollback- || true
       done"

  # 4. 同步 → build → git tag → up → 重啟 nginx
  hdr "同步 HEAD $SHORT → $APP_DIR"
  if [[ $USE_RSYNC == 1 ]]; then
    local rsync_e; rsync_e="ssh $(printf '%q ' "${SSH_OPTS[@]}")"
    rsync -rlc --itemize-changes --exclude 'node_modules/' \
      -e "$rsync_e" --rsync-path='sudo -n rsync' --chown=ubuntu:ubuntu \
      "$STAGE/" "$VPS_HOST:$APP_DIR/"
  else
    # 本機無 rsync：只打包 新增＋覆寫 的檔，root 解包後 chown 回 ubuntu（app/ 原屬主）
    printf '%s\0' "${NEW_FILES[@]}" "${OVER_FILES[@]}" >"$WORK/sync.lst"
    log "tar 傳送 $((${#NEW_FILES[@]} + ${#OVER_FILES[@]})) 檔"
    if ((${#NEW_FILES[@]} + ${#OVER_FILES[@]})); then
      tar -C "$STAGE" --null -T "$WORK/sync.lst" -cf - \
        | rsh "sudo -n tar -xf - -C $(printf '%q' "$APP_DIR") --no-same-owner --no-overwrite-dir"
      rsh "cd $(printf '%q' "$APP_DIR") && sudo -n xargs -0 chown ubuntu:ubuntu --" <"$WORK/sync.lst"
    fi
  fi

  hdr "compose build ${SERVICES[*]}"
  local t0 t1
  t0="$(date +%s)"
  if ! rsh "cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE build ${SERVICES[*]}"; then
    die "build 失敗；:latest 未變、容器未重建（app/ 已同步為 $SHORT，下次 deploy 會重建）"
  fi
  t1="$(date +%s)"
  rsh "sudo -n docker tag $API_IMAGE:latest $API_IMAGE:git-$SHORT && sudo -n docker tag $WORKER_IMAGE:latest $WORKER_IMAGE:git-$SHORT"
  hdr "up -d ${SERVICES[*]}"
  rsh "cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE up -d ${SERVICES[*]} && sudo -n docker restart $NGINX_CTR >/dev/null && echo 'restarted $NGINX_CTR'"

  # 5. postcheck（失敗 → 自動回滾到本次 rollback tag）
  if ! postcheck; then
    warn "postcheck 失敗 → 自動回滾到 :$rb_tag"
    do_rollback "$rb_tag" || true
    exit 1
  fi

  # 6. DEPLOYED 標記
  local stamp
  stamp="$SHORT $(date -u +%Y-%m-%dT%H:%M:%SZ) $(uname -n)"
  rsh "echo $(printf '%q' "$stamp") | sudo -n tee $(printf '%q' "$CP_DIR/DEPLOYED") >/dev/null"
  hdr "完成"
  log "DEPLOYED：$stamp"
  log "build 耗時：$((t1 - t0))s"
}

# ---------------------------------------------------------------- main
cmd="${1:-plan}"; (($#)) && shift
case "$cmd" in
  plan) do_plan ;;
  deploy) do_deploy "$@" ;;
  rollback) do_rollback "${1:-}" ;;
  -h|--help|help) sed -n '2,17p' "$0" ;;
  *) die "未知子命令：$cmd（plan｜deploy｜rollback [tag]）" ;;
esac
