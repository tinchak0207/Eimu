#!/usr/bin/env bash
# 控面一键部署：plan（唯读，预设）／deploy／rollback [tag]
#
# 来源＝本机 git HEAD（不是 working tree）。控面＝VPS /opt/image-control-plane（无 git 手搬副本）。
#   plan     git archive HEAD → 与 VPS app/ 做 checksum 比对 → 双向 diff 闸（BLOCKED＝VPS 独有修改）
#            → compose 漂移（只印键名）→ 磁碟。不改 VPS 任何东西。
#   deploy   已硬停用：禁止在在线生产主机同步源码并全量构建；须改用离机预构建镜像产物。
#            本脚本尚不提供预构建产物导入发布，不能以参数绕过此限制。
#   rollback [tag]  不给 tag 用最新的 :rollback-*
#
# 用法：
#   deploy/vps/deploy-control-plane.sh [plan]
#   deploy/vps/deploy-control-plane.sh deploy [--allow-overwrite <path>]...
#   deploy/vps/deploy-control-plane.sh rollback [rollback-YYYYmmddHHMMSS]
#
# 22443 连续快速连线会被 RST ⇒ 整次执行共用一条 SSH ControlMaster 连线。
# compose 档 control-plane-compose.yml 是 VPS 自有（含 secret），本脚本永不覆写、永不印值。
set -euo pipefail

# 本脚本的目标是承载在线服务的 4GB 生产主机；源码全量构建已造成资源耗尽。
# 在 SSH、EXIT trap、plan、源码同步之前硬拒绝，不提供强制绕过开关。
if [[ "${1:-plan}" == "deploy" ]]; then
  printf '%s\n' \
    'ERROR: 禁止在承载在线服务的生产主机原地同步源码并全量构建控制面。' \
    '请在离机构建机按 deploy/vps/Dockerfile 预构建两个镜像，产物建议保存到：' \
    '  work/control-plane-prebuilt/<commit>/images.tar（docker save 镜像归档）' \
    '本脚本尚不支持预构建产物导入发布；请使用仅导入已构建镜像并切换服务的发布流程。' \
    'plan 与 rollback 命令仍保留。' >&2
  exit 1
fi

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
# 只 reload 不 restart（2026-09-28 事故）：restart 会让 nginx 在启动时重新解析 conf 内所有上游，
# 任一上游容器已被移除（当时是 adobe2api-plus-web）→ [emerg] host not found → 全站入口重启回圈 2m42s。
# reload 同样重新解析上游 IP（控面重建后 IP 会变），但设定有错时 master 保留旧 worker 继续服务。
PUBLIC_HEALTHZ="https://store.tinchak0207.xyz/image-control/api/healthz"
SERVICES=(generation-api generation-worker)
ROLLBACK_KEEP=3

# git archive 白名单（与 .dockerignore 一致）；另 deploy/vps/Dockerfile → Dockerfile、.dockerignore → .dockerignore
ARCHIVE_PATHS=(src public worker tools db bridge skills
  deploy-staging/expert-gateway deploy-staging/gateway
  package.json package-lock.json next.config.mjs next-env.d.ts tsconfig.json
  tailwind.config.ts postcss.config.mjs components.json)
# HEAD 实存的白名单路径（do_plan 填）。**必须全局**：do_deploy 的 4b 残留清理也用它，
# 若像以前那样只在 do_plan 里 local，do_deploy 读到的就是未定义数组 —— bash 5 在 set -u 下
# 对未定义数组的 "${a[*]}" 静默展开为空（不报错），find 少了路径参数就退回 `find .`，
# 整份 app/ 被判成残留删除（2026-10-08 事故，3572 档）。
PRESENT=()
# 目的路径（VPS app/ 相对）→ repo 路径；未列者同名
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
    ssh "${SSH_OPTS[@]}" -fN "$VPS_HOST" || die "SSH ControlMaster 建立失败（$VPS_HOST:$VPS_PORT）"
  fi
}

# VPS 端 checksum 比对器。stdin：每行 "<相对路径>\t<本机md5 或 ->"。
# 输出：NEW\t<path>｜OVER\t<path>\t<VPS md5 或 NOTFILE>（本机 md5 为 - 时一律输出 OVER 附 VPS md5）
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

# 本机 stage 清单：<path>\t<md5>（排除 node_modules/）
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

# compose config JSON → service 名＋environment 键名（永不印值）
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

# 该 repo 路径历史上所有 blob 的 md5（git log --all 逐版）
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
ALLOW_BULK=0   # 4b 残留清理的安全闸旁路（--allow-bulk-remove）；默认 0＝差集异常即中止

do_plan() {
  HEAD_SHA="$(git rev-parse HEAD)"; SHORT="${HEAD_SHA:0:8}"
  hdr "来源：git $SHORT（$(git log -1 --format=%s "$HEAD_SHA" | cut -c1-80)）"

  # 1. git archive HEAD → stage
  STAGE="$(mktemp -d /tmp/cp-deploy-stage.XXXXXX)"
  WORK="$(mktemp -d /tmp/cp-deploy-work.XXXXXX)"
  PRESENT=(); local p
  for p in "${ARCHIVE_PATHS[@]}"; do
    if git cat-file -e "$HEAD_SHA:$p" 2>/dev/null; then PRESENT+=("$p"); else log "略过（提交无此路径）：$p"; fi
  done
  git archive --format=tar "$HEAD_SHA" -- "${PRESENT[@]}" | tar -x -C "$STAGE"
  git show "$HEAD_SHA:deploy/vps/Dockerfile" >"$STAGE/Dockerfile"
  git show "$HEAD_SHA:.dockerignore" >"$STAGE/.dockerignore"
  log "stage：$(find "$STAGE" -type f | wc -l) 档，$(du -sh "$STAGE" | cut -f1)"

  # 2. working tree 相对 HEAD 的未提交改动（只警告）
  local dirty
  dirty="$(git status --porcelain -- "${PRESENT[@]}" deploy/vps/Dockerfile .dockerignore)"
  if [[ -n "$dirty" ]]; then
    warn "下列部署路径在 working tree 有未提交改动（部署的是 HEAD，这些改动不会上线）："
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
  fi

  # 3. 比对 stage vs VPS app/（rsync -rlc --dry-run；本机无 rsync 时退 checksum 清单，判准等价）
  ssh_master_open
  if command -v rsync >/dev/null 2>&1 && rsh 'command -v rsync' >/dev/null 2>&1; then
    USE_RSYNC=1
  fi
  hdr "比对 stage → $VPS_HOST:$APP_DIR（$([[ $USE_RSYNC == 1 ]] && echo 'rsync -rlc --dry-run' || echo '本机无 rsync：md5 清单比对')）"
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

  # 4. 双向 diff 闸：VPS md5 ∈ 此路径 repo 历史任一版 ⇒ VPS 只是落后（可覆写）；否则 BLOCKED
  local src hist
  while IFS=$'\t' read -r kind rel md5; do
    OVER_FILES+=("$rel")
    src="${SRC_OF[$rel]:-$rel}"
    hist="$(hist_md5s "$src")"   # 先收集再比对：grep -q 提前退出会让 pipefail 误判
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
    hdr "VPS 将被覆写・可覆写（VPS 版＝repo 历史某版，只是落后）（${#OK_FILES[@]}）"; printf '  ~ %s\n' "${OK_FILES[@]}"
  fi
  if ((${#BLOCKED_FILES[@]})); then
    hdr "BLOCKED・VPS 独有修改（VPS md5 不在 repo 历史）（${#BLOCKED_FILES[@]}）"
    local i
    for i in "${!BLOCKED_FILES[@]}"; do printf '  ! %s  vps_md5=%s\n' "${BLOCKED_FILES[$i]}" "${BLOCKED_MD5[$i]}"; done
  fi

  # 5. compose 漂移（只报不改；只印键名）
  hdr "compose 漂移检查（$CP_DIR/$COMPOSE_FILE，只印键名）"
  local cq; cq="cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE"
  rsh "$cq config --format json 2>/dev/null | python3 -c $(printf '%q' "$COMPOSE_KEYS_PY")" \
    || warn "compose config 解析失败"
  # compose 插值警告（只含变数名，例如未设定的 \${VAR}）
  rsh "$cq config -q 2>&1 >/dev/null | grep -o 'msg=.*' | sort -u | sed 's/^/compose warning: /'" || true

  # 6. 磁碟
  hdr "磁碟"
  rsh 'df -h / && echo && sudo -n docker system df'

  # 7. 摘要
  hdr "摘要"
  log "HEAD：$SHORT（$HEAD_SHA）"
  log "将新增：${#NEW_FILES[@]}"
  log "将覆写：${#OVER_FILES[@]}（可覆写 ${#OK_FILES[@]}／BLOCKED ${#BLOCKED_FILES[@]}）"
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
    log "FAIL $API_CTR OPENAI_COMPAT_GENERATION_ORIGIN 为空或容器不在"; ok=1
  fi
  out=""
  for i in $(seq 1 20); do
    if out="$(rsh "sudo -n docker exec $API_CTR wget -S -O /dev/null http://127.0.0.1:3000/api/healthz 2>&1 | grep -m1 'HTTP/'")" \
      && grep -q ' 200' <<<"$out"; then break; fi
    out="${out:-no response}"; sleep 3
  done
  if grep -q ' 200' <<<"$out"; then log "OK   healthz ${out# *}"; else log "FAIL healthz：${out}"; ok=1; fi
  # 控面自代理回圈探针（2026-10-08 事故）：src/middleware.ts 只要 GENERATION_CONTROL_PLANE_PROXY_ORIGIN
  # 非空就把 /api/v1/* 代回该 origin；若控面容器自己带着这个变数，origin 即本机 ⇒ 回圈 ⇒ nginx 回
  # 400 Request Header Or Cookie Too Large，全 B 端面不可用——而 healthz（不在代理路径表内）照样 200，
  # 上面那条闸完全看不见。故此处必须探一条**代理路径表内**的路径：预期 401（鉴权门）。
  out="$(rsh "sudo -n docker exec $API_CTR wget -S -O /dev/null -T 10 http://127.0.0.1:3000/api/v1/models 2>&1 | grep -m1 'HTTP/'")" || true
  case "$out" in
    *" 401"*|*" 200"*) log "OK   /api/v1/models 代理面可达（${out#* }）" ;;
    *) log "FAIL /api/v1/models → ${out:-无回应}（400＝控面 middleware 自代理回圈：查 compose 是否给 generation-api 设了 GENERATION_CONTROL_PLANE_PROXY_ORIGIN）"; ok=1 ;;
  esac
  # 经 nginx 的对外探测：容器内 healthz 绿不代表入口活著（09-28 nginx 重启回圈时容器内仍是 200）。
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$PUBLIC_HEALTHZ" || true)"
  if [[ $code == 200 ]]; then log "OK   public $PUBLIC_HEALTHZ 200"; else log "FAIL public $PUBLIC_HEALTHZ → ${code:-无回应}"; ok=1; fi
  base="$(rsh "sudo -n docker inspect -f '{{.State.Status}} {{.RestartCount}}' $WORKER_CTR" 2>/dev/null || echo 'missing -1')"
  sleep 30
  now="$(rsh "sudo -n docker inspect -f '{{.State.Status}} {{.RestartCount}}' $WORKER_CTR" 2>/dev/null || echo 'missing -1')"
  if [[ ${now%% *} == running && ${now##* } == "${base##* }" && ${base##* } != -1 ]]; then
    log "OK   $WORKER_CTR 30s 后 running，RestartCount=${now##* }"
  else
    log "FAIL $WORKER_CTR 前=[$base] 30s 后=[$now]"; ok=1
  fi
  return $ok
}

latest_rollback_tag() {
  rsh "sudo -n docker image ls $API_IMAGE --format '{{.Tag}}'" | grep '^rollback-' | sort -r | head -n1
}

do_rollback() {  # $1=tag（可空）；postcheck 失败只报错，不递回回滚
  local tag="${1:-}"
  ssh_master_open
  [[ -n "$tag" ]] || tag="$(latest_rollback_tag || true)"
  [[ -n "$tag" ]] || die "找不到任何 :rollback-* tag"
  hdr "rollback → :$tag"
  rsh "set -e; sudo -n docker image inspect $API_IMAGE:$tag $WORKER_IMAGE:$tag >/dev/null
       sudo -n docker tag $API_IMAGE:$tag $API_IMAGE:latest
       sudo -n docker tag $WORKER_IMAGE:$tag $WORKER_IMAGE:latest
       cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE up -d --no-build ${SERVICES[*]}
       sudo -n docker exec $NGINX_CTR nginx -t -q && sudo -n docker exec $NGINX_CTR nginx -s reload && echo 'reloaded $NGINX_CTR'"
  if postcheck; then log "rollback 完成，postcheck 通过"; else log "rollback 后 postcheck 失败（不再递回回滚），请人工处理"; return 1; fi
}

# ---------------------------------------------------------------- deploy
do_deploy() {
  local allow=() a i blocked_left=()
  while (($#)); do
    case "$1" in
      --allow-overwrite) [[ $# -ge 2 ]] || die "--allow-overwrite 需要路径"; allow+=("$2"); shift 2 ;;
      --allow-bulk-remove) ALLOW_BULK=1; shift ;;
      *) die "未知参数：$1" ;;
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
    die "有 ${#blocked_left[@]} 个 BLOCKED（VPS 独有修改）未放行；先把 VPS 修改回灌 repo，或逐一 --allow-overwrite <path>"
  fi

  # 1. preflight
  hdr "preflight"
  bash -n "${BASH_SOURCE[0]}"
  log "脚本语法通过；按 AGENTS.md 不以历史测试作部署闸门，代码由后续生产构建校验。"

  # 2. 磁碟闸
  #
  # 2026-10-08 事故（磁盘打满连带打挂别的服务）：全量重建（api+worker）实测吃 ~4.3G，而
  # 旧闸「< 6G 就 prune，prune 后 >= 4G 即放行」在 4.0G 时放行 ⇒ build 途中把根分割区吃到
  # 100%（avail 0）⇒ ① `image-data-api` 与 worker 写不进盘进入重启回圈 ② postgres 崩溃恢复
  # 期间 worker 自举报 `57P03 Consistent recovery state has not been yet reached`（症状像
  # 迁移错，真因是 DB 在恢复）③ nginx -t 解析不到停掉的 `image-data-api` ⇒ reload 未执行
  # ⇒ 上游 IP 陈旧（整片 502）。故闸必须留出「别的服务还能活」的余量，而不是「刚好够 build」。
  hdr "磁碟闸"
  local avail
  avail="$(rsh "df -B1G --output=avail / | tail -n1 | tr -d ' '")"
  log "可用 ${avail}G（全量重建实测约需 4.3G，闸要求清理后 ≥6G 以留余量）"
  if ((avail < 6)); then
    log "< 6G → prune builder cache 与 dangling image，并清掉被超越的控面旧映像（每个 repo 只留最新一个 rollback-*）"
    rsh "sudo -n docker builder prune -af >/dev/null && sudo -n docker image prune -f >/dev/null
         for repo in $API_IMAGE $WORKER_IMAGE; do
           keep=\$(sudo -n docker image ls \$repo --format '{{.Tag}}' | grep '^rollback-' | sort -r | head -n1)
           for t in \$(sudo -n docker image ls \$repo --format '{{.Tag}}' | grep '^rollback-'); do
             [ \"\$t\" = \"\$keep\" ] || sudo -n docker rmi \"\$repo:\$t\" >/dev/null 2>&1 || true
           done
         done"
    avail="$(rsh "df -B1G --output=avail / | tail -n1 | tr -d ' '")"
    log "清理后可用 ${avail}G"
    # 6G：留 ~1.7G 给 postgres/其它容器写入；低于 4G 时连「当前服务是否还能活」都不保证。
    ((avail >= 6)) || die "清理后可用仅 ${avail}G < 6G：全量重建会吃 ~4.3G 并把磁盘打满（2026-10-08 事故：连带动摇 image-data-api/postgres、nginx reload 失败）。请先人工清空间（删大档/旧备份），再重跑。"
  fi

  # 3. 版本化：现役 :latest → :rollback-<UTC>，各留最近 $ROLLBACK_KEEP 个
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

  # 4. 同步 → build → git tag → up → 重启 nginx
  hdr "同步 HEAD $SHORT → $APP_DIR"
  if [[ $USE_RSYNC == 1 ]]; then
    local rsync_e; rsync_e="ssh $(printf '%q ' "${SSH_OPTS[@]}")"
    rsync -rlc --itemize-changes --exclude 'node_modules/' \
      -e "$rsync_e" --rsync-path='sudo -n rsync' --chown=ubuntu:ubuntu \
      "$STAGE/" "$VPS_HOST:$APP_DIR/"
  else
    # 本机无 rsync：只打包 新增＋覆写 的档，root 解包后 chown 回 ubuntu（app/ 原属主）
    printf '%s\0' "${NEW_FILES[@]}" "${OVER_FILES[@]}" >"$WORK/sync.lst"
    log "tar 传送 $((${#NEW_FILES[@]} + ${#OVER_FILES[@]})) 档"
    if ((${#NEW_FILES[@]} + ${#OVER_FILES[@]})); then
      tar -C "$STAGE" --null -T "$WORK/sync.lst" -cf - \
        | rsh "sudo -n tar -xf - -C $(printf '%q' "$APP_DIR") --no-same-owner --no-overwrite-dir"
      rsh "cd $(printf '%q' "$APP_DIR") && sudo -n xargs -0 chown ubuntu:ubuntu --" <"$WORK/sync.lst"
    fi
  fi

  # 4b. 删除 APP_DIR 中 HEAD 已不存在的残留档（2026-10-08：同步只覆盖不删除 ⇒ 历史删档
  #     在控面 app/ 留存，Next.js build 编译到旧档当场失败——实测 39 档残留含已删的
  #     pro-workstation/，其旧类型错阻断整次 build）。范围严格限定 PRESENT=ARCHIVE_PATHS，
  #     Dockerfile/.dockerignore 不在此列（另行安装），不碰 app/ 下其它既有档。
  #
  #     三重防护（2026-10-08 事故：3572 档被误删，app/ 被清空）：
  #       ① scope 逐项 %q 转义后带进远程 find —— 禁 ${arr[*]} 裸展开（那会塌成单参数，
  #          find 少了路径参数就退回 `find .`，输出 `./` 前缀全量清单）；
  #       ② 两侧一律「去 ./ 前缀 + LC_ALL=C sort」—— 前缀或 collation 不同会让 comm 零交集；
  #       ③ 安全闸：任一侧清单为空、或差集 > 200 档、或 > HEAD 档数 10% ⇒ 中止不删。
  local head_lst="$WORK/head.lst" vps_lst="$WORK/vps.lst" stale_lst="$WORK/stale.lst"
  local scope_q head_n vps_n stale_n
  scope_q="$(printf '%q ' "${PRESENT[@]}")"
  [[ -n "$scope_q" ]] || die "PRESENT 为空（HEAD 白名单路径全不存在？），拒绝执行残留清理"
  (cd "$STAGE" && LC_ALL=C find $scope_q -type f 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort) >"$head_lst"
  rsh "cd $(printf '%q' "$APP_DIR") && LC_ALL=C find $scope_q -type f 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort" >"$vps_lst"
  head_n="$(grep -c . "$head_lst" || true)"; vps_n="$(grep -c . "$vps_lst" || true)"
  # comm 的排序判准是**它自己**的 LC_COLLATE（不是 sort 的）⇒ 这里也必须 LC_ALL=C，
  # 否则会喷 "not in sorted order" 并默默算出错差集（2026-10-08 离线 fixture 实测）。
  local comm_err; comm_err="$WORK/comm.err"
  LC_ALL=C comm -23 "$vps_lst" "$head_lst" 2>"$comm_err" >"$stale_lst"
  if [[ -s "$comm_err" ]]; then
    sed 's/^/  /' "$comm_err" >&2
    die "comm 报错（清单不同序）＝比对不可信，拒绝删除（未改 VPS）"
  fi
  stale_n="$(grep -c . "$stale_lst" || true)"
  log "残留清理范围：HEAD $head_n 档／VPS $vps_n 档 ⇒ 差集 $stale_n"
  ((head_n > 0 && vps_n > 0)) || die "清单为空（head=$head_n vps=$vps_n）＝比对失效，拒绝删除（未改 VPS）"
  if ((stale_n > 0)); then
    if ((stale_n > 200 || stale_n * 10 > head_n)) && [[ $ALLOW_BULK == 0 ]]; then
      sed 's/^/  /' "$stale_lst" >&2
      die "差集 $stale_n 档超过安全阈值（HEAD $head_n 档）＝疑似比对失效，已中止且未删任何档；确认无误会再加 --allow-bulk-remove 重跑"
    fi
    log "REMOVED $stale_n 个残留档（HEAD 已不存在）"
    sed 's/^/  /' "$stale_lst" >&2
    rsh "cd $(printf '%q' "$APP_DIR") && xargs -r -d '\n' sudo -n rm -f --" <"$stale_lst"
    rsh "cd $(printf '%q' "$APP_DIR") && LC_ALL=C find $scope_q -type d -empty -delete 2>/dev/null || true"
  else
    log "REMOVED 0 个残留档"
  fi
  # 灾后哨兵：同步步骤刚铺过 HEAD 全量，本步骤不该动到本体
  rsh "[ -f $(printf '%q' "$APP_DIR/Dockerfile") ] && [ -d $(printf '%q' "$APP_DIR/src") ]" \
    || die "残留清理后缺 Dockerfile 或 src/＝本步骤误删本体（已中止；重跑 deploy 会由同步步骤恢复 app/）"

  hdr "compose build ${SERVICES[*]}"
  local t0 t1
  t0="$(date +%s)"
  if ! rsh "cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE build ${SERVICES[*]}"; then
    die "build 失败；:latest 未变、容器未重建（app/ 已同步为 $SHORT，下次 deploy 会重建）"
  fi
  t1="$(date +%s)"
  rsh "sudo -n docker tag $API_IMAGE:latest $API_IMAGE:git-$SHORT && sudo -n docker tag $WORKER_IMAGE:latest $WORKER_IMAGE:git-$SHORT"
  hdr "up -d ${SERVICES[*]}"
  rsh "cd $(printf '%q' "$CP_DIR") && sudo -n docker compose -f $COMPOSE_FILE up -d ${SERVICES[*]}"
  # 上游 IP 变了 ⇒ 必须 reload。但 `nginx -t` 会重新解析 conf 里**全部**上游名，任一被引用的
  # 容器不在运行即 `host not found in upstream "X"` ⇒ 测不过（2026-10-08：磁盘打满把
  # image-data-api 打挂，reload 未执行 ⇒ 控面上游 IP 陈旧 ⇒ 整片 502，而脚本只留一行原始
  # nginx 报错，看不出「是别的容器被连带打挂了」）。失败时把成因与修法摊开。
  if ! rsh "sudo -n docker exec $NGINX_CTR nginx -t -q"; then
    warn "nginx -t 不通过——它解析 conf 里全部上游名，通常是有被引用的容器不在运行（磁盘满/崩溃回圈常见）："
    rsh "sudo -n docker exec $NGINX_CTR grep -ohE 'upstream: //[A-Za-z0-9_.-]+|upstream \"[A-Za-z0-9_.-]+\"' /etc/nginx/conf.d/default.conf | grep -ohE '[A-Za-z0-9_.-]+$' | sort -u" 2>/dev/null | sed 's/^/  conf 引用：/' >&2 || true
    rsh "sudo -n docker ps --format '{{.Names}}'" 2>/dev/null | sort | sed 's/^/  正在运行：/' >&2 || true
    die "nginx -t 失败 ⇒ **未执行 reload** ⇒ 控面上游 IP 陈旧（可能整片 502）。先修好上面缺失的容器（例如 docker start <name>；磁盘满时先 docker builder prune -af），再手动：docker exec $NGINX_CTR nginx -t -q && docker exec $NGINX_CTR nginx -s reload"
  fi
  rsh "sudo -n docker exec $NGINX_CTR nginx -s reload && echo 'reloaded $NGINX_CTR'"

  # 5. postcheck（失败 → 自动回滚到本次 rollback tag）
  if ! postcheck; then
    warn "postcheck 失败 → 自动回滚到 :$rb_tag"
    do_rollback "$rb_tag" || true
    exit 1
  fi

  # 6. DEPLOYED 标记
  local stamp
  stamp="$SHORT $(date -u +%Y-%m-%dT%H:%M:%SZ) $(uname -n)"
  rsh "echo $(printf '%q' "$stamp") | sudo -n tee $(printf '%q' "$CP_DIR/DEPLOYED") >/dev/null"
  hdr "完成"
  log "DEPLOYED：$stamp"
  log "build 耗时：$((t1 - t0))s"
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
