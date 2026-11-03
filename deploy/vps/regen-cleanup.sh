#!/usr/bin/env bash
# Daily cleanup of regenerable disk usage on the VPS. Runs from regen-cleanup.timer.
#
# Why: on 2026-11-03 the root disk sat at 2.4G free (96% used), under the 3G release
# gate, and nothing ran unless disk-guard saw <20% free. This keeps the disk from
# drifting there in the first place.
#
# Touches ONLY things that can be regenerated:
#   apt package cache, dangling docker images, docker build cache older than 7 days,
#   session sandbox scratch (.run/<slug>/tmp) older than 3 days,
#   gateway release dirs beyond current + 2 newest others (rollback anchors).
# Never touches: workspace/out, projects, any *.db (sessions.db, opencode.db),
#   uploads, /opt/image-data-api, backups, swap files, docker images in use.
# Logs df before/after each step to /var/log/regen-cleanup.log.

set -uo pipefail

LOG=/var/log/regen-cleanup.log
WS=/opt/agent-harness/workspace
GW_RELEASES=/opt/agent-harness/releases/gateway
GW_LINK=/opt/agent-harness/gateway
ACTIVATION_LOCK=/opt/agent-harness/.harness-activation.lock
KEEP_ANCHORS=${REGEN_KEEP_ANCHORS:-2}

[ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ] && { tail -n 400 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }

avail() { df -B1 --output=avail / | tail -1 | tr -dc '0-9'; }
step() {
  local name=$1; shift
  local before after
  before=$(avail)
  "$@" >/dev/null 2>&1 || true
  after=$(avail)
  printf '%s %s before=%s after=%s freed=%s\n' "$(date -Is)" "$name" "$before" "$after" "$((after - before))" >> "$LOG"
}

apt_clean() { apt-get clean; }
docker_prune() {
  command -v docker >/dev/null || return 0
  docker image prune -f                       # dangling only, never tagged/in-use images
  docker builder prune -f --filter until=168h
}
sandbox_tmp() {
  [ -d "$WS/.run" ] || return 0
  find "$WS/.run" -mindepth 3 -path "$WS/.run/*/tmp/*" -type f -mtime +3 -delete
  find "$WS/.run" -mindepth 3 -path "$WS/.run/*/tmp/*" -type d -empty -delete
}
gateway_releases() {
  [ -L "$GW_LINK" ] && [ -d "$GW_RELEASES" ] || return 0
  # Do not race an activation in progress.
  exec 9>>"$ACTIVATION_LOCK" || return 0
  flock -n 9 || { echo "skip: activation lock held"; return 0; }
  local cur; cur=$(basename "$(dirname "$(readlink -f "$GW_LINK")")")
  [ -n "$cur" ] && [ -d "$GW_RELEASES/$cur" ] || return 0
  # Same ordering gateway-release.sh rollback uses (ls -dt), so the kept anchors are
  # exactly the dirs rollback would pick next.
  local kept=0 r
  while read -r r; do
    [ "$r" = "$cur" ] && continue
    if [ "$kept" -lt "$KEEP_ANCHORS" ]; then kept=$((kept + 1)); continue; fi
    rm -rf -- "${GW_RELEASES:?}/$r"
  done < <(ls -1dt "$GW_RELEASES"/*/ 2>/dev/null | sed 's:/$::' | xargs -r -n1 basename)
  exec 9>&-
}

step apt-clean apt_clean
step docker-dangling+buildcache docker_prune
step sandbox-tmp-3d sandbox_tmp
step gateway-releases-keep-cur+${KEEP_ANCHORS} gateway_releases
