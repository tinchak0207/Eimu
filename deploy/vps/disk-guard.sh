#!/usr/bin/env bash
# Reclaims regenerable disk space before the VPS hits 100%.
#
# Why this exists: 2026-10-24 the root filesystem filled to 100%, generation-postgres
# could not write postmaster.pid, restarted forever, the control-plane API lost its
# database, and eimu.dev agent key relay failed with "Agent 服务暂不可用". No monitor
# was watching capacity, so the outage was reported by a user screenshot instead.
#
# What it will and will not touch:
#   - Container logs / journal / apt cache / old buildkit cache: regenerable, freed first.
#   - /opt/agent-harness/workspace/out: creation work. NEVER deleted here — a finished
#     cut or reference sheet can be the only copy. Only reported so a human decides.
#   - /opt/agent-harness/workspace/.local/share/opencode/opencode.db: live SQLite in
#     use by the opencode server. Never touched while opencode runs.
#
# It frees at most what is safe and logs the rest, so "disk still tight after cleanup"
# stays a visible signal rather than turning into silent data loss.

set -uo pipefail

WARN_PCT=${DISK_GUARD_WARN_PCT:-20}   # report when free drops below this
CRIT_PCT=${DISK_GUARD_CRIT_PCT:-12}   # start reclaiming below this
LOG=/var/log/disk-guard.log

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

# This script can be the last thing writing to a full disk; keep its own log capped.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 1048576 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

free_pct() {
  # Root filesystem only: that is the one postgres and docker write to.
  # `df --output=pcent` reports USED percent, so invert it.
  local used
  used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
  echo $(( 100 - ${used:-100} ))
}

FREE_BEFORE=$(free_pct)

if [ "$FREE_BEFORE" -ge "$WARN_PCT" ]; then
  exit 0
fi

log "free=${FREE_BEFORE}% warn=${WARN_PCT}% crit=${CRIT_PCT}%"

# --- Tier 1: always safe, do it whenever we are below the warn line -----------
journalctl --vacuum-size=50M >/dev/null 2>&1 || true
apt-get clean >/dev/null 2>&1 || true

if [ "$FREE_BEFORE" -lt "$CRIT_PCT" ]; then
  # --- Tier 2 (critical only): reclaim docker build cache, keep running images ---
  # `docker builder prune` never touches images a container is running from.
  docker builder prune -af >/dev/null 2>&1 || true
  # Dangling images are layers nothing references; running containers are not dangling.
  docker image prune -f >/dev/null 2>&1 || true
fi

FREE_AFTER=$(free_pct)
log "reclaim done: free=${FREE_BEFORE}% -> ${FREE_AFTER}%"

if [ "$FREE_AFTER" -lt "$CRIT_PCT" ]; then
  # Report what a human would have to decide on. Do not act on it here.
  WS=/opt/agent-harness/workspace
  OUT_MB=$(du -sm "$WS/out" 2>/dev/null | cut -f1)
  DB_MB=$(du -sm "$WS/.local/share/opencode/opencode.db" 2>/dev/null | cut -f1)
  OUT_OLD_MB=$(find "$WS/out" -maxdepth 1 -mindepth 1 ! -newermt '-7 days' \
    -exec du -sm {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')
  log "STILL TIGHT: out=${OUT_MB:-?}MB (older-than-7d=${OUT_OLD_MB}MB, human decision), opencode.db=${DB_MB:-?}MB (live)"
  logger -t disk-guard "root filesystem free ${FREE_AFTER}% — manual cleanup needed"
fi
