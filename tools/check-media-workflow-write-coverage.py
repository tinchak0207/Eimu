#!/usr/bin/env python3
"""发版门：近 N 天「媒体会话」workflow_write 覆盖率门槛（2026-10-11 修画布裁定 #3）。

媒体会话＝ledger.jsonl 中 event=done 且 kind∈{image,video,audio} 的 opencode_session_id。
覆盖率＝这些会话中至少成功调用过一次 workflow_write 的占比。

生产基线约 1%；门槛默认 15%（可用环境变量抬升）。未达 → exit 2。

用法（在 VPS 或已挂载同源档案的机器）：
  python3 tools/check-media-workflow-write-coverage.py
  MEDIA_WF_DAYS=7 MEDIA_WF_MIN_COVERAGE=0.15 python3 tools/check-media-workflow-write-coverage.py
  OPENCODE_DB=/path/to/opencode.db LEDGER=/path/to/ledger.jsonl python3 ...

只读；不写生产。
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CST = timezone(timedelta(hours=8))

DAYS = int(os.environ.get("MEDIA_WF_DAYS", "7"))
MIN_COV = float(os.environ.get("MEDIA_WF_MIN_COVERAGE", "0.15"))
MIN_SESSIONS = int(os.environ.get("MEDIA_WF_MIN_SESSIONS", "5"))
DB = os.environ.get(
    "OPENCODE_DB",
    "/opt/agent-harness/workspace/.local/share/opencode/opencode.db",
)
LEDGER = os.environ.get("LEDGER", "/opt/agent-harness/ledger.jsonl")


def main() -> int:
    now = datetime.now(CST)
    cut = now - timedelta(days=DAYS)
    print(f"NOW_CST={now.isoformat()} days={DAYS} min_coverage={MIN_COV} min_sessions={MIN_SESSIONS}")
    print(f"DB={DB}")
    print(f"LEDGER={LEDGER}")

    if not Path(DB).is_file():
        print(f"FAIL: opencode.db 不存在：{DB}", file=sys.stderr)
        return 2
    if not Path(LEDGER).is_file():
        print(f"FAIL: ledger.jsonl 不存在：{LEDGER}", file=sys.stderr)
        return 2

    media_sids: set[str] = set()
    with open(LEDGER, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            ts = o.get("ts")
            if not ts:
                continue
            try:
                t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(CST)
            except Exception:
                continue
            if t < cut:
                continue
            if o.get("event") != "done":
                continue
            if o.get("kind") not in ("image", "video", "audio"):
                continue
            sid = o.get("opencode_session_id") or o.get("session_id")
            if isinstance(sid, str) and sid:
                media_sids.add(sid)

    print(f"media_sessions_{DAYS}d={len(media_sids)}")
    if len(media_sids) < MIN_SESSIONS:
        print(
            f"SKIP: 媒体会话数 {len(media_sids)} < {MIN_SESSIONS}（样本不足，不挡发版；请确认 ledger 路径）"
        )
        return 0

    uri = f"file:{DB}?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=120)
    con.execute("PRAGMA query_only=ON")
    con.execute("PRAGMA temp_store=MEMORY")

    with_write = 0
    for sid in media_sids:
        n = con.execute(
            "SELECT COUNT(*) FROM part WHERE session_id=? AND data LIKE ?",
            (sid, '%"tool":"workflow_write"%'),
        ).fetchone()[0]
        if n > 0:
            with_write += 1
    con.close()

    cov = with_write / len(media_sids)
    print(f"with_workflow_write={with_write} coverage={cov:.1%}")
    if cov + 1e-12 < MIN_COV:
        print(
            f"FAIL: 媒体会话 workflow_write 覆盖率 {cov:.1%} < 门槛 {MIN_COV:.0%} "
            f"（近 {DAYS} 天；修画布发版门）",
            file=sys.stderr,
        )
        return 2
    print(f"PASS: coverage {cov:.1%} >= {MIN_COV:.0%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
