#!/usr/bin/env bash
# H51 (2026-11-04): install / rollback the gateway error-log exporter on the VPS.
# Stage this dir's files (eimu-gw-errlog.py, systemd/eimu-gw-errlog.{service,timer},
# logrotate/eimu-gateway-errors) in SRC_DIR, then on the VPS:
#   sudo bash install-gw-errlog.sh --dry-run   # gates + checks + exporter dry-run, changes nothing
#   sudo bash install-gw-errlog.sh apply       # gates, backup, install, daemon-reload, enable timer, selftest
#   sudo bash install-gw-errlog.sh rollback    # disable timer, restore backup (log file kept as evidence)
# Touches no business service (no restart of agent-gateway/poller/opencode, no rsyslog/journald
# restart). daemon-reload only re-reads unit files.
# Gates: root fs avail >= 3GiB and MemAvailable >= 300MiB, else exit 3 with no change.
set -euo pipefail
MODE="${1:-}"
SRC_DIR="${SRC_DIR:-$(cd "$(dirname "$0")" && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/opt/agent-harness/backups/$(date +%Y%m%d)-hardening51}"
MAP=(
  "eimu-gw-errlog.py:/usr/local/bin/eimu-gw-errlog.py:755"
  "systemd/eimu-gw-errlog.service:/etc/systemd/system/eimu-gw-errlog.service:644"
  "systemd/eimu-gw-errlog.timer:/etc/systemd/system/eimu-gw-errlog.timer:644"
  "logrotate/eimu-gateway-errors:/etc/logrotate.d/eimu-gateway-errors:644"
)
say() { printf '[h51] %s\n' "$*"; }
case "$MODE" in --dry-run|apply|rollback) ;; *) echo "usage: $0 --dry-run|apply|rollback" >&2; exit 2;; esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
gates() {
  local a m; a=$(df -B1 --output=avail / | tail -1 | tr -dc 0-9); m=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  say "gate disk_avail=${a}B mem_available=${m}kB"
  [ "$a" -ge $((3*1024*1024*1024)) ] || { say GATE_FAIL_disk; exit 3; }
  [ "$m" -ge $((300*1024)) ] || { say GATE_FAIL_mem; exit 3; }
}
case "$MODE" in
--dry-run)
  gates
  for e in "${MAP[@]}"; do IFS=: read -r s d _ <<<"$e"; [ -f "$SRC_DIR/$s" ] || { say "missing $s"; exit 2; }
    if [ -e "$d" ]; then say "would replace $d (backup)"; else say "would create $d"; fi; done
  python3 -m py_compile "$SRC_DIR/eimu-gw-errlog.py"
  systemd-analyze verify "$SRC_DIR/systemd/eimu-gw-errlog.service" 2>&1 | grep -v "^$" | grep -iv "ExecStart.*not executable\|/usr/local/bin/eimu-gw-errlog.py" || true
  logrotate -d "$SRC_DIR/logrotate/eimu-gateway-errors" 2>&1 | tail -4
  EIMU_GW_ERRLOG_STATE=$(mktemp -d) python3 "$SRC_DIR/eimu-gw-errlog.py" --dry-run | tail -3
  ;;
apply)
  gates; mkdir -p "$BACKUP_DIR"
  for e in "${MAP[@]}"; do IFS=: read -r s d mode <<<"$e"; b="$BACKUP_DIR/$(basename "$d")"
    if [ -e "$d" ]; then [ -e "$b.orig" ] || cp -a "$d" "$b.orig"; else [ -e "$b.orig" ] || : > "$b.absent"; fi
    install -m "$mode" "$SRC_DIR/$s" "$d"; done
  systemctl daemon-reload
  logrotate -d /etc/logrotate.d/eimu-gateway-errors > "$BACKUP_DIR/logrotate-d.out" 2>&1 || { say "logrotate -d failed"; cat "$BACKUP_DIR/logrotate-d.out"; exit 4; }
  systemctl start eimu-gw-errlog.service        # first run: back-fills what the journal still has
  python3 /usr/local/bin/eimu-gw-errlog.py --selftest || { say "selftest failed (timer NOT enabled)"; exit 4; }
  systemctl enable --now eimu-gw-errlog.timer
  md5sum /usr/local/bin/eimu-gw-errlog.py /etc/systemd/system/eimu-gw-errlog.{service,timer} /etc/logrotate.d/eimu-gateway-errors
  say "APPLIED backup=$BACKUP_DIR"
  ;;
rollback)
  systemctl disable --now eimu-gw-errlog.timer 2>/dev/null || true
  for e in "${MAP[@]}"; do IFS=: read -r s d mode <<<"$e"; b="$BACKUP_DIR/$(basename "$d")"
    if [ -e "$b.orig" ]; then install -m "$mode" "$b.orig" "$d"; elif [ -e "$b.absent" ]; then rm -f -- "$d"; fi; done
  systemctl daemon-reload
  say "ROLLED_BACK (kept /var/log/eimu-gateway-errors.log* and /var/lib/eimu-gw-errlog as evidence)"
  ;;
esac
