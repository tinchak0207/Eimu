#!/usr/bin/env python3
# H50 ledger 写入自检（只读）——「ledger 不增长」时区分「确实没流量」与「写入中断」。
#
# 原理：网关 ledger.jsonl 的每条生成终态都有上游真相源先落库——
#   ① sessions.db generation_receipts（kind∈image/video/audio 的终态回执 updated_at）；
#   ② 平台 postgres music_charge（status=applied 的音乐扣费 updated_at，audio done 与之同秒写）。
# 若真相源在 ledger 最后一次写入（mtime）之后 + 宽限期内仍有新终态，而 ledger 没动 ⇒ STALL_SUSPECT。
# 真相源同样没动 ⇒ NO_TRAFFIC（静默正常）。另报 ledger 可写性、根盘空闲、journal「ledger append failed」次数。
#
# 硬纪律：只读。sessions.db 以 ?mode=ro + query_only 打开；postgres 只走
#   PGOPTIONS=default_transaction_read_only=on；不写任何档、不改帐、不触发生成。只输出计数与时间，不输出 id/提示词/秘密。
#   拿不到的源输出「未取得」（null），不以 0 代替。
# 退出码：0=OK（ledger 之后真相源无新终态＝没流量或已记）；2=STALL_SUSPECT（写入疑似中断）；3=PARTIAL（有源未取得，无法下结论）。
# 用法（VPS，以 ubuntu 身份）：python3 deploy/vps/ledger-liveness.py [--grace-min 15] [--no-pg] [--no-journal]
#   离线：--ledger F --sessions-db F --no-pg --no-journal
import argparse, datetime, json, os, shlex, shutil, sqlite3, subprocess, sys

DEFAULT_PSQL = ("sudo -n docker exec -i -e PGOPTIONS=-c\\ default_transaction_read_only=on "
                "image-control-postgres psql -X -q -At -v ON_ERROR_STOP=1 -U image_control -d image_control")
TERMINAL = ("succeeded", "failed", "refunded", "cancelled", "canceled")
SGT = datetime.timezone(datetime.timedelta(hours=8))


def iso(t):
    return None if t is None else datetime.datetime.fromtimestamp(t, SGT).isoformat(timespec="seconds")


def receipts_after(db_path, after):
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        q = ("SELECT kind, COUNT(*), MAX(updated_at) FROM generation_receipts WHERE kind IN ('image','video','audio') "
             f"AND status IN ({','.join('?' * len(TERMINAL))}) AND updated_at > ? GROUP BY kind")
        rows = db.execute(q, (*TERMINAL, int(after * 1000))).fetchall()
        last = db.execute("SELECT MAX(updated_at) FROM generation_receipts WHERE kind IN ('image','video','audio') "
                          f"AND status IN ({','.join('?' * len(TERMINAL))})", TERMINAL).fetchone()[0]
    finally:
        db.close()
    return ({k: n for k, n, _ in rows}, None if last is None else last / 1000.0)


def music_after(psql, after):
    sql = ("SELECT COUNT(*) FILTER (WHERE updated_at > to_timestamp(%f)), "
           "EXTRACT(EPOCH FROM MAX(updated_at)) FROM music_charge WHERE status='applied';" % after)
    out = subprocess.run(shlex.split(psql), input=sql, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError("psql 失败")
    n, last = out.stdout.strip().split("|")
    return int(n), (float(last) if last else None)


def journal_failures(since):
    cmd = ["journalctl", "-u", "agent-gateway", "--since", since, "--no-pager", "-o", "cat"]
    if os.geteuid() != 0:
        cmd = ["sudo", "-n"] + cmd
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError("journalctl 失败")
    return sum(1 for l in out.stdout.splitlines() if "ledger append failed" in l)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default=os.environ.get("LEDGER_PATH", "/opt/agent-harness/ledger.jsonl"))
    ap.add_argument("--sessions-db", default="/opt/agent-harness/state/sessions.db")
    ap.add_argument("--psql", default=os.environ.get("BILLING_RECON_PSQL", DEFAULT_PSQL))
    ap.add_argument("--grace-min", type=float, default=15.0)
    ap.add_argument("--no-pg", action="store_true")
    ap.add_argument("--no-journal", action="store_true")
    a = ap.parse_args()

    r = {"check": "ledger-liveness", "now": iso(datetime.datetime.now().timestamp()), "grace_min": a.grace_min}
    partial = False
    try:
        st = os.stat(a.ledger)
        mtime = st.st_mtime
        r["ledger"] = {"mtime": iso(mtime), "bytes": st.st_size, "writable": os.access(a.ledger, os.W_OK)}
    except OSError as e:
        r["ledger"] = {"error": type(e).__name__}
        print(json.dumps(r, ensure_ascii=False, indent=1)); return 2
    after = mtime + a.grace_min * 60
    try:
        r["disk_free_bytes"] = shutil.disk_usage(os.path.dirname(a.ledger) or ".").free
    except OSError:
        r["disk_free_bytes"] = None
    try:
        by_kind, last = receipts_after(a.sessions_db, after)
        r["receipts_terminal_after_ledger"] = by_kind
        r["receipts_terminal_last"] = iso(last)
    except Exception as e:
        r["receipts_terminal_after_ledger"] = None; r["receipts_error"] = type(e).__name__; partial = True
    if a.no_pg:
        r["music_applied_after_ledger"] = "skipped"
    else:
        try:
            n, last = music_after(a.psql, after)
            r["music_applied_after_ledger"] = n; r["music_applied_last"] = iso(last)
        except Exception as e:
            r["music_applied_after_ledger"] = None; r["music_error"] = type(e).__name__; partial = True
    if a.no_journal:
        r["journal_append_failed"] = "skipped"
    else:
        try:
            r["journal_append_failed"] = journal_failures(datetime.datetime.fromtimestamp(mtime, SGT).strftime("%Y-%m-%d %H:%M:%S"))
        except Exception as e:
            r["journal_append_failed"] = None; r["journal_error"] = type(e).__name__

    pending = sum((r.get("receipts_terminal_after_ledger") or {}).values())
    mus = r.get("music_applied_after_ledger")
    pending += mus if isinstance(mus, int) else 0
    jf = r.get("journal_append_failed")
    if pending > 0 or (isinstance(jf, int) and jf > 0) or r["ledger"].get("writable") is False:
        r["verdict"] = "STALL_SUSPECT"; code = 2
    elif partial:
        r["verdict"] = "PARTIAL"; code = 3
    else:
        r["verdict"] = "OK"; code = 0  # 真相源在 ledger 之后无新终态：静默即无流量
    r["upstream_terminal_after_ledger"] = pending
    print(json.dumps(r, ensure_ascii=False, indent=1))
    return code


if __name__ == "__main__":
    sys.exit(main())
