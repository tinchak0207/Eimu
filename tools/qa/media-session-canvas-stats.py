#!/usr/bin/env python3
import json, sqlite3
from collections import Counter
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
now = datetime.now(CST)
cut7_ms = int((now - timedelta(days=7)).timestamp() * 1000)
cut14_ms = int((now - timedelta(days=14)).timestamp() * 1000)

DB = "/opt/agent-harness/workspace/.local/share/opencode/opencode.db"
uri = f"file:{DB}?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=120)
con.execute("PRAGMA temp_store=MEMORY")
con.execute("PRAGMA query_only=ON")
con.execute("PRAGMA cache_size=-200000")

TOOLS = [
    "workflow_write", "workflow_history", "workflow_rollback",
    "canvas_get_state", "canvas_apply_ops", "canvas_generate_image", "canvas_create_generation_flow",
    "workflow_start", "workflow_status", "workflow_generate", "workflow_add_node", "workflow_connect",
    "workflow_disconnect", "workflow_update_node", "workflow_rerun_node",
    "image_generate", "video_quote", "video_upload", "image_quote",
]

def fmt(ms):
    if not ms:
        return "-"
    return datetime.fromtimestamp(ms / 1000, CST).strftime("%Y-%m-%d %H:%M")

print("NOW_CST", now.isoformat())
print("cut7_ms", cut7_ms, "cut14_ms", cut14_ms)
print("=== TOOL_COUNTS ===")
for t in TOOLS:
    pat = '%"tool":"' + t + '"%'
    all_n = con.execute("SELECT COUNT(*) FROM part WHERE data LIKE ?", (pat,)).fetchone()[0]
    n14 = con.execute(
        "SELECT COUNT(*) FROM part WHERE time_created>=? AND data LIKE ?",
        (cut14_ms, pat),
    ).fetchone()[0]
    n7 = con.execute(
        "SELECT COUNT(*) FROM part WHERE time_created>=? AND data LIKE ?",
        (cut7_ms, pat),
    ).fetchone()[0]
    row = con.execute(
        "SELECT MIN(time_created), MAX(time_created) FROM part WHERE data LIKE ?",
        (pat,),
    ).fetchone()
    print(f"{t}\tall={all_n}\t14d={n14}\t7d={n7}\tfirst={fmt(row[0])}\tlast={fmt(row[1])}")

# ledger media sessions
media_sessions_14 = set()
media_sessions_7 = set()
media_by_kind_14 = Counter()
media_by_kind_7 = Counter()
workflow_ledger_14 = 0
workflow_ledger_7 = 0
with open("/opt/agent-harness/ledger.jsonl") as f:
    for line in f:
        try:
            o = json.loads(line)
        except Exception:
            continue
        ts = o.get("ts")
        if not ts:
            continue
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(CST)
        kind = o.get("kind")
        event = o.get("event")
        sid = o.get("opencode_session_id") or o.get("session_id")
        if kind == "workflow":
            if t >= now - timedelta(days=14):
                workflow_ledger_14 += 1
            if t >= now - timedelta(days=7):
                workflow_ledger_7 += 1
        if event == "done" and kind in ("image", "video", "audio") and sid:
            if t >= now - timedelta(days=14):
                media_sessions_14.add(sid)
                media_by_kind_14[kind] += 1
            if t >= now - timedelta(days=7):
                media_sessions_7.add(sid)
                media_by_kind_7[kind] += 1

print("=== LEDGER_MEDIA ===")
print("MEDIA_DELIVERIES_14d", dict(media_by_kind_14), "sessions", len(media_sessions_14))
print("MEDIA_DELIVERIES_7d", dict(media_by_kind_7), "sessions", len(media_sessions_7))
print("LEDGER_workflow_kind_14d", workflow_ledger_14, "7d", workflow_ledger_7)

canvas_tools = {
    "workflow_write", "workflow_history", "workflow_rollback",
    "canvas_get_state", "canvas_apply_ops", "canvas_generate_image", "canvas_create_generation_flow",
    "workflow_start", "workflow_status", "workflow_generate", "workflow_add_node", "workflow_connect",
    "workflow_disconnect", "workflow_update_node", "workflow_rerun_node",
}
dsl_core = {
    "workflow_write", "workflow_history", "workflow_rollback",
    "canvas_get_state", "canvas_apply_ops",
}

def analyze(sids, label):
    with_canvas = 0
    with_dsl = 0
    tool_hits = Counter()
    examples = []
    for sid in sids:
        rows = con.execute(
            "SELECT data FROM part WHERE session_id=? AND data LIKE ?",
            (sid, '%"type":"tool"%'),
        ).fetchall()
        tools = set()
        for (data,) in rows:
            try:
                o = json.loads(data)
            except Exception:
                continue
            if o.get("type") != "tool":
                continue
            tools.add(o.get("tool"))
        hit_c = tools & canvas_tools
        hit_d = tools & dsl_core
        if hit_c:
            with_canvas += 1
            for x in hit_c:
                tool_hits[x] += 1
        if hit_d:
            with_dsl += 1
            if len(examples) < 8:
                examples.append((sid, sorted(hit_d)))
    n = len(sids) or 1
    print(f"=== MEDIA_SESSIONS_{label}_CANVAS ===")
    print("total_media_sessions", len(sids))
    print("with_any_canvas_or_workflow_tool", with_canvas, f"{with_canvas/len(sids)*100:.1f}%" if sids else "n/a")
    print("with_dsl_core", with_dsl, f"{with_dsl/len(sids)*100:.1f}%" if sids else "n/a")
    print("tool_hits_across_media_sessions", dict(tool_hits))
    print("examples", examples)

analyze(media_sessions_14, "14d")
analyze(media_sessions_7, "7d")
con.close()
print("DONE")
