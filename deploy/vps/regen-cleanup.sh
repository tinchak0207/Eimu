#!/usr/bin/env bash
# Daily cleanup of regenerable disk usage on the VPS. Runs from regen-cleanup.timer.
#
# Why: on 2026-11-03 the root disk sat at 2.4G free (96% used), under the 3G release
# gate, and nothing ran unless disk-guard saw <20% free. This keeps the disk from
# drifting there in the first place. H16 (2026-11-04) added rollback-anchor retention
# for release backups, a dry-run mode, and report-only listing of stale site images.
#
# Touches ONLY things that can be regenerated:
#   apt package cache, dangling docker images, docker build cache older than 7 days,
#   session sandbox scratch (.run/<slug>/tmp) older than 3 days,
#   gateway release dirs beyond current + N newest others (rollback anchors, N>=1),
#   opencode release backups in $BACKUPS beyond the newest N (N>=2):
#     opencode-*-pre.tgz (+ its -AGENTS.md / -AGENTS.absent sidecar),
#     recovery-opencode-*.tgz, prompts-recovery-*.tgz (+ sidecar).
# Never touches: workspace/out, projects, any *.db (sessions.db, opencode.db),
#   uploads, /opt/image-data-api, swap files, docker images in use, anything else
#   in $BACKUPS (hardening evidence dirs, settings snapshots, prompt snapshots).
# Site images (image-control-plane-generation-api:site-*) beyond live + newest
#   previous are only LISTED; they are removed only with REGEN_SITE_IMAGE_PRUNE=1,
#   which the systemd unit does not set (deleting images needs the owner's approval).
#
# Usage: regen-cleanup.sh [--dry-run]   (or REGEN_DRY_RUN=1)
#   --dry-run prints every candidate with its byte size and deletes nothing.
# Logs df before/after each step to /var/log/regen-cleanup.log.

set -uo pipefail

DRY_RUN=${REGEN_DRY_RUN:-0}
case "${1:-}" in
  "") ;;
  -n|--dry-run) DRY_RUN=1 ;;
  -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
  *) echo "unknown argument: $1 (use --dry-run)" >&2; exit 2 ;;
esac

LOG=${REGEN_LOG:-/var/log/regen-cleanup.log}
WS=${REGEN_WS:-/opt/agent-harness/workspace}
BACKUPS=${REGEN_BACKUPS:-/opt/agent-harness/backups}
GW_RELEASES=${REGEN_GW_RELEASES:-/opt/agent-harness/releases/gateway}
GW_LINK=${REGEN_GW_LINK:-/opt/agent-harness/gateway}
ACTIVATION_LOCK=${REGEN_ACTIVATION_LOCK:-/opt/agent-harness/.harness-activation.lock}
SITE_REPO=image-control-plane-generation-api
SITE_CONTAINER=eimu-site
KEEP_ANCHORS=${REGEN_KEEP_ANCHORS:-2}          # gateway: other dirs kept besides current
KEEP_OC=${REGEN_KEEP_OC_ANCHORS:-3}            # opencode pre.tgz kept (newest = rollback target)
KEEP_RECOVERY=${REGEN_KEEP_RECOVERY:-2}        # recovery-opencode / prompts-recovery kept each
KEEP_SITE_PREV=${REGEN_KEEP_SITE_PREV:-1}      # site images kept besides live
SITE_PRUNE=${REGEN_SITE_IMAGE_PRUNE:-0}

# Floors: never fewer than current + previous rollback anchor.
int_floor() { case "$1" in ''|*[!0-9]*) echo "$2" ;; *) [ "$1" -lt "$2" ] && echo "$2" || echo "$1" ;; esac; }
KEEP_ANCHORS=$(int_floor "$KEEP_ANCHORS" 1)
KEEP_OC=$(int_floor "$KEEP_OC" 2)
KEEP_RECOVERY=$(int_floor "$KEEP_RECOVERY" 2)
KEEP_SITE_PREV=$(int_floor "$KEEP_SITE_PREV" 1)

exec 3>&1
[ "$DRY_RUN" = 1 ] || { [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && { tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }; }

log() {
  if [ "$DRY_RUN" = 1 ]; then printf '%s DRY %s\n' "$(date -Is)" "$*" >&3
  else printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; fi
}
avail() { df -B1 --output=avail / | tail -1 | tr -dc '0-9'; }
PLANNED=0
step() {
  local name=$1; shift
  local before after
  PLANNED=0
  before=$(avail)
  "$@" >/dev/null 2>&1 || true
  after=$(avail)
  if [ "$DRY_RUN" = 1 ]; then log "$name would_free=$PLANNED"
  else log "$name before=$before after=$after freed=$((after - before)) listed_bytes=$PLANNED"; fi
}
# Remove (or, in dry-run, only report) one path, counting its bytes.
rm_path() {
  local p=$1 b
  [ -e "$p" ] || [ -L "$p" ] || return 0
  b=$(du -sb -- "$p" 2>/dev/null | cut -f1); b=${b:-0}
  PLANNED=$((PLANNED + b))
  if [ "$DRY_RUN" = 1 ]; then log "  would_remove bytes=$b $p"; return 0; fi
  rm -rf -- "$p" && log "  removed bytes=$b $p"
}
with_activation_lock() {
  exec 9>>"$ACTIVATION_LOCK" || return 0
  if ! flock -n 9; then log "  skip: activation lock held"; exec 9>&-; return 0; fi
  "$@"
  exec 9>&-
}

apt_clean() {
  if [ "$DRY_RUN" = 1 ]; then
    local b; b=$(du -sb /var/cache/apt/archives 2>/dev/null | cut -f1); PLANNED=${b:-0}
    log "  would run apt-get clean (archives=${b:-0})"; return 0
  fi
  apt-get clean
}
docker_prune() {
  command -v docker >/dev/null || return 0
  if [ "$DRY_RUN" = 1 ]; then
    log "  dangling_images=$(docker images -qf dangling=true | wc -l)"
    log "  $(docker system df --format '{{.Type}} reclaimable={{.Reclaimable}}' | tr '\n' ';')"
    return 0
  fi
  docker image prune -f                       # dangling only, never tagged/in-use images
  docker builder prune -f --filter until=168h
}
sandbox_tmp() {
  [ -d "$WS/.run" ] || return 0
  local f
  while IFS= read -r -d '' f; do rm_path "$f"; done \
    < <(find "$WS/.run" -mindepth 3 -path "$WS/.run/*/tmp/*" -type f -mtime +3 -print0)
  [ "$DRY_RUN" = 1 ] || find "$WS/.run" -mindepth 3 -path "$WS/.run/*/tmp/*" -type d -empty -delete
}
gateway_releases_locked() {
  local cur; cur=$(basename "$(dirname "$(readlink -f "$GW_LINK")")")
  [ -n "$cur" ] && [ -d "$GW_RELEASES/$cur" ] || return 0
  # Same ordering gateway-release.sh rollback uses (ls -dt), so the kept anchors are
  # exactly the dirs rollback would pick next.
  local kept=0 r
  while read -r r; do
    [ -n "$r" ] || continue
    [ "$r" = "$cur" ] && { log "  keep current $r"; continue; }
    if [ "$kept" -lt "$KEEP_ANCHORS" ]; then kept=$((kept + 1)); log "  keep anchor $r"; continue; fi
    rm_path "${GW_RELEASES:?}/$r"
  done < <(ls -1dt "$GW_RELEASES"/*/ 2>/dev/null | sed 's:/$::' | xargs -r -n1 basename)
}
gateway_releases() {
  [ -L "$GW_LINK" ] && [ -d "$GW_RELEASES" ] || return 0
  with_activation_lock gateway_releases_locked   # do not race an activation in progress
}
# Keep the newest $1 files matching the remaining glob(s) by mtime; drop older ones
# and their -AGENTS.md / -AGENTS.absent sidecars.
keep_newest() {
  local keep=$1 i=0 f; shift
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    i=$((i + 1))
    if [ "$i" -le "$keep" ]; then log "  keep anchor $(basename "$f")"; continue; fi
    rm_path "$f"
    rm_path "${f%.tgz}-AGENTS.md"
    rm_path "${f%.tgz}-AGENTS.absent"
  done < <(ls -1t -- "$@" 2>/dev/null)
}
release_backups_locked() {
  # opencode-release.sh rollback restores `ls -1t opencode-*-pre.tgz | head -1`; the
  # newest KEEP_OC stay, so rollback (and a second rollback) keep their targets.
  keep_newest "$KEEP_OC" "$BACKUPS"/opencode-*-pre.tgz
  keep_newest "$KEEP_RECOVERY" "$BACKUPS"/recovery-opencode-*.tgz
  keep_newest "$KEEP_RECOVERY" "$BACKUPS"/prompts-recovery-*.tgz
}
release_backups() {
  [ -d "$BACKUPS" ] || return 0
  with_activation_lock release_backups_locked
}
site_images() {
  command -v docker >/dev/null || return 0
  local live ref kept=0
  live=$(docker inspect -f '{{.Config.Image}}' "$SITE_CONTAINER" 2>/dev/null) || { log "  skip: $SITE_CONTAINER not found"; return 0; }
  log "  live $live writable=$(docker ps -s --filter "name=^${SITE_CONTAINER}\$" --format '{{.Size}}')"
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    [ "$ref" = "$live" ] && continue
    if [ "$kept" -lt "$KEEP_SITE_PREV" ]; then kept=$((kept + 1)); log "  keep anchor $ref"; continue; fi
    if [ "$SITE_PRUNE" = 1 ] && [ "$DRY_RUN" != 1 ]; then
      docker rmi "$ref" >/dev/null 2>&1 && log "  removed image $ref" || log "  rmi failed (in use?) $ref"
    else
      log "  candidate (report-only, needs owner approval + REGEN_SITE_IMAGE_PRUNE=1) $ref"
    fi
  done < <(docker images --format '{{.CreatedAt}}	{{.Repository}}:{{.Tag}}' "$SITE_REPO" \
             | awk -F'\t' '$2 ~ /:site-/' | sort -r | cut -f2)
}

[ "$DRY_RUN" = 1 ] && log "dry-run: nothing will be deleted (keep: gateway cur+$KEEP_ANCHORS, opencode pre $KEEP_OC, recovery $KEEP_RECOVERY, site live+$KEEP_SITE_PREV)"
step apt-clean apt_clean
step docker-dangling+buildcache docker_prune
step sandbox-tmp-3d sandbox_tmp
step gateway-releases-keep-cur+${KEEP_ANCHORS} gateway_releases
step release-backups-keep-${KEEP_OC}+recovery-${KEEP_RECOVERY} release_backups
step site-images-report-live+${KEEP_SITE_PREV} site_images
