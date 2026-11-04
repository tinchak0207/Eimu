#!/usr/bin/env python3
"""H51 (2026-11-04) gateway error evidence that outlives the journal.

Why: the VPS journal only reaches back ~6h. disk-guard.sh vacuums it to 50M every
10 minutes (its CRIT is a percentage, 12%, and the 59G root disk always sits at ~8%
free), and per-file `sudo install` in releases plus warp-svc fill those 50M fast.
"[gateway] ledger append failed" (appendLedger console.error) and friends get rotated
away before anyone looks (H50).

What: every 5 min (eimu-gw-errlog.timer) read new journal entries of agent-gateway /
agent-poller / agent-exec-bridge after a saved cursor, keep only error-ish lines,
append them to /var/log/eimu-gateway-errors.log (logrotate: daily, 30 days).
bun writes stdout AND stderr with PRIORITY=6, so we match keywords, plus PRIORITY<=4.

Bounds (tight disk, tight RAM): one journalctl + this process, <30MB RSS, ~0.2s.
Per run at most MAX_BYTES (32 KiB) are appended, the rest is counted in one
"[h51] truncated" line => <= ~9.2 MiB/day even under an error flood. If root fs
avail < 1 GiB nothing is written and the cursor is not advanced.
Read-only towards services: never restarts or signals anything.

Usage:
  eimu-gw-errlog.py            # normal timer run
  eimu-gw-errlog.py --dry-run  # print what would be appended; no write, cursor untouched
  eimu-gw-errlog.py --selftest # emit 2 synthetic lines from a transient unit
                               #  (stdout->journald, same hop as bun), export, check capture
Exit: 0 ok, 1 error, 4 selftest failed.
"""
import fcntl, json, os, re, shutil, subprocess, sys, time, uuid

UNITS = ["agent-gateway.service", "agent-poller.service", "agent-exec-bridge.service"]
LOG = os.environ.get("EIMU_GW_ERRLOG", "/var/log/eimu-gateway-errors.log")
STATE_DIR = os.environ.get("EIMU_GW_ERRLOG_STATE", "/var/lib/eimu-gw-errlog")
CURSOR = os.path.join(STATE_DIR, "cursor")
LOCK = os.path.join(STATE_DIR, "lock")
MAX_BYTES = int(os.environ.get("EIMU_GW_ERRLOG_MAX_BYTES", str(32 * 1024)))
MIN_FREE = 1 << 30
FIRST_SINCE = "-7d"  # first run: back-fill whatever the journal still has

KEEP = re.compile(
    r"ledger append failed|E(ACCES|NOSPC|ROFS|PERM|IO|MFILE|NOMEM)\b|uncaught|unhandled|panic"
    r"|fatal|error|fail(ed|ure)?\b|warn|timed? ?out|oom|killed",
    re.I)
SKIP = re.compile(r"workflow restored from db: .*\b0 interrupted node", re.I)
# Zero counters in stats lines ("failed=0", "ledger.errors=0") are not errors.
ZERO_COUNTERS = re.compile(r"\b(failed|fail|failures?|errors?|warnings?)[=:]\s*0\b", re.I)
# Journal content is already root/adm-readable; still never copy obvious credentials.
REDACT = [(re.compile(r"(?i)\b(bearer|authorization:?)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 <redacted>"),
          (re.compile(r"\b(sk|rk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}"), r"\1-<redacted>"),
          (re.compile(r"(?i)\b(token|secret|password|api[_-]?key)=([^&\s\"']{6,})"), r"\1=<redacted>")]


def keep(prio, msg):
    if SKIP.search(msg):
        return False
    try:
        if int(prio) <= 4:
            return True
    except (TypeError, ValueError):
        pass
    return bool(KEEP.search(ZERO_COUNTERS.sub("", msg)))


def fmt(e):
    ts = int(e.get("__REALTIME_TIMESTAMP", "0")) / 1e6
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)) + "%s" % time.strftime("%z", time.localtime(ts))
    unit = (e.get("_SYSTEMD_UNIT") or "?").removesuffix(".service")
    msg = e.get("MESSAGE", "")
    if isinstance(msg, list):  # binary payload
        msg = bytes(msg).decode("utf-8", "replace")
    for rx, rep in REDACT:
        msg = rx.sub(rep, msg)
    return "%s %s[%s] p%s %s\n" % (stamp, unit, e.get("_PID", "?"), e.get("PRIORITY", "?"), msg.rstrip("\n"))


def export(units, dry):
    os.makedirs(STATE_DIR, exist_ok=True)
    cmd = ["journalctl", "--no-pager", "-q", "-o", "json",
           "--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID,__REALTIME_TIMESTAMP"]
    for u in units:
        cmd += ["-u", u]
    cur = None
    if os.path.exists(CURSOR):
        cur = open(CURSOR).read().strip() or None
    cmd += ["--after-cursor=" + cur] if cur else ["--since", FIRST_SINCE]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        print("journalctl failed rc=%d: %s" % (p.returncode, p.stderr.strip()[:300]), file=sys.stderr)
        return None
    out, size, dropped, last, seen = [], 0, 0, None, 0
    for line in p.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        seen += 1
        last = e.get("__CURSOR", last)
        if not keep(e.get("PRIORITY"), e.get("MESSAGE") if isinstance(e.get("MESSAGE"), str) else ""):
            continue
        s = fmt(e)
        if size + len(s.encode()) > MAX_BYTES:
            dropped += 1
            continue
        out.append(s)
        size += len(s.encode())
    if dropped:
        out.append("%s h51[-] p4 [h51] truncated: %d more matching lines this run (cap %d B)\n"
                   % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), dropped, MAX_BYTES))
    if dry:
        sys.stdout.write("".join(out))
        print("[h51] DRY_RUN scanned=%d matched=%d dropped=%d cursor=%s" % (seen, len(out), dropped, "set" if cur else "none"))
        return out
    if out:
        if shutil.disk_usage("/").free < MIN_FREE:
            print("[h51] root fs < 1GiB free: not writing, cursor kept", file=sys.stderr)
            return out
        new = not os.path.exists(LOG)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("".join(out))
        if new:
            os.chmod(LOG, 0o640)
            try:
                shutil.chown(LOG, "root", "adm")
            except (LookupError, PermissionError):
                pass
    if last:
        tmp = CURSOR + ".tmp"
        with open(tmp, "w") as f:
            f.write(last)
        os.replace(tmp, CURSOR)
    print("[h51] scanned=%d appended=%d dropped=%d" % (seen, len(out), dropped))
    return out


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    selftest = "--selftest" in args
    bad = [a for a in args if a not in ("--dry-run", "--selftest")]
    if bad:
        print("unknown args: %s" % bad, file=sys.stderr)
        return 1
    os.makedirs(STATE_DIR, exist_ok=True)
    lk = open(LOCK, "w")
    try:
        fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("[h51] another run holds the lock; skip")
        return 0
    units = list(UNITS)
    marker = None
    if selftest:
        marker = "H51-SELFTEST-%s-%s" % (time.strftime("%Y%m%dT%H%M%S"), uuid.uuid4().hex[:8])
        unit = "eimu-h51-selftest-%s" % marker[-8:]
        # stdout of a service -> journald stream (PRIORITY=6), exactly like bun's console.error.
        # Text avoids "ledger append failed" so ledger-liveness.py stays clean.
        sh = ("echo '[selftest] %s-kw synthetic EACCES probe, not a real failure'; "
              "echo '%s-sev synthetic warning-priority probe' | systemd-cat -p warning" % (marker, marker))
        r = subprocess.run(["systemd-run", "--quiet", "--wait", "--collect", "--unit", unit,
                            "/bin/sh", "-c", sh], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            print("[h51] systemd-run failed: %s" % r.stderr.strip()[:300], file=sys.stderr)
            return 4
        time.sleep(1.0)
        units.append(unit + ".service")
    out = export(units, dry)
    if out is None:
        return 1
    if selftest:
        got = [s for s in out if marker in s]
        ok = any("-kw " in s for s in got) and any("-sev " in s for s in got)
        sys.stdout.write("".join(got))
        print("[h51] SELFTEST_%s %s" % ("OK" if ok else "FAIL", marker))
        return 0 if ok else 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
