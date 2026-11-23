#!/usr/bin/env bash
# Writes disk headroom as JSON for gatus to probe.
# See /usr/local/bin/disk-guard.sh for why capacity became a monitored signal.
set -uo pipefail
OUT=/opt/imagesite/certbot/www/diskz.json
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
free=$(( 100 - ${used:-100} ))
ok=false; [ "$free" -ge 15 ] && ok=true
printf '{"ok":%s,"freePercent":%s}\n' "$ok" "$free" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
