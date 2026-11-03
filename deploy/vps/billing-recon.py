#!/usr/bin/env python3
# H18 计费三方对帐（只读）——confirmed（用户确认的预估额）/ 实际扣费 / 退款，逐笔对齐。
#
# 硬纪律：
#   1. 只读：sessions.db 以 URI ?mode=ro 打开；平台 postgres 只走
#      PGOPTIONS=default_transaction_read_only=on 的 COPY (SELECT ...) TO STDOUT；
#      不写任何档、不改帐、不退款、不触发任何生成。输出只到 stdout。
#   2. 不猜：拿不到的字段输出「未取得」，不以 0 代替。INC-0831：真相未明（submit_unknown /
#      billing_unknown / pending / unknown 操作）单独列为「冻结待人工」，不算错帐也不建议退款。
#   3. 隐私：只输出 job / 用户 id 前缀，不输出 session id、邮箱、提示词。
#
# 口径（与 src/lib/generation-core/account-reconciliation.ts expectedLedgerEntryForOperation 一致）：
#   legacy 路径：reserve applied = 真扣用户；refund applied = 退回；commit(非 projection) 只是结算凭证。
#   projection 路径：commit idempotency_ref 以 projection: 开头 = 真扣用户。
#   writeoff = 平台自损，不动用户余额。
#   用户实扣 charged = reserve - refund + projection_commit（quota 单位，1 币 = 500000）。
#   confirmed = 网关回执 generation_receipts.data.cost_coins（image_generate.ts 确认时的预估额，
#   同一值作为 cap_coins 送平台）；回执 task_id = generation_job.id。
#   H20 关联键：ledger confirm/approved 自 H20 起带 request_id（＝工具提交平台的 Idempotency-Key＝
#   generation_job.idempotency_key；upscale_audit 逐张为 <request_id>-<i>）与 workflow_id（wfgen_ 批次）。
#   旧行两键皆无＝「无法逐笔关联」；新行按 request_id 连 job，再比 确认额 vs 实扣。
#
# 用法（VPS）：
#   python3 deploy/vps/billing-recon.py                       # 默认路径 + 只读 psql
#   python3 deploy/vps/billing-recon.py --json                # 只出汇总 JSON
#   python3 deploy/vps/billing-recon.py --pg-dir DIR ...      # 离线：DIR 下 jobs.csv / ops.csv / acct.csv
import argparse, collections, csv, io, json, os, shlex, sqlite3, subprocess, sys

Q = 500000.0
TOL = 0.005  # 币
DEFAULT_PSQL = ("sudo -n docker exec -i -e PGOPTIONS=-c\\ default_transaction_read_only=on "
                "image-control-postgres psql -X -q -v ON_ERROR_STOP=1 -U image_control -d image_control")
PG_QUERIES = {
    "jobs": "SELECT id, billing_user_id, source, kind, model_id, status, billing_amount, requested_count, completed_count, created_at, idempotency_key FROM generation_job",
    "ops": "SELECT job_id, operation, amount, status, idempotency_ref, created_at FROM billing_operation",
    "acct": "SELECT id, billing_user_id, entry_type, amount, source, job_id, created_at FROM account_ledger",
}
FAIL_STATES = {"failed", "cancelled", "canceled"}
UNKNOWN_STATES = {"submit_unknown", "billing_unknown"}
GEN_KINDS = ("image", "video", "audio")

CATS = [
    ("confirmed_ne_charged_over", "confirmed≠扣费（实扣>确认）"),
    ("confirmed_ne_charged_under", "confirmed≠扣费（实扣<确认）"),
    ("failed_charged_not_refunded", "扣费后失败未退"),
    ("refunded_but_charged", "refunded 但仍扣（平台 job 状态）"),
    ("gw_refunded_but_charged", "refunded 但仍扣（网关回执/帐说已退，平台仍扣）"),
    ("gw_failed_platform_charged", "网关回执失败/取消，平台成功并扣费"),
    ("dup_charge_ops", "重复扣（同 job 多笔扣款操作 / reserve+projection 双扣）"),
    ("dup_charge_ledger", "重复扣（同 job 多条 consumption 帐本行）"),
    ("dup_charge_request", "同 request_id 多 job 均扣（含合法返工，待甄别）"),
    ("dup_refund", "重复退（同 job 多笔退款 / 退款>预扣）"),
    ("refund_without_charge", "退款无对应扣费"),
    ("settle_gap", "结算凭证缺口（reserve≠commit+refund，终态 legacy job）"),
    ("success_uncharged", "成功未扣（漏扣）"),
    ("ledger_ne_ops", "帐本≠操作（account_ledger 净额≠操作净额）"),
    ("ledger_missing", "帐本缺行（操作已扣，帐本接管后无对应行）"),
    ("gw_ledger_ne_charged", "网关 ledger.jsonl done 记帐≠平台实扣"),
    ("receipt_no_job", "回执无对应平台 job"),
    ("confirm_unlinked_event", "确认事件无法逐笔关联（ledger confirm/approved 无 task_id 也无 request_id，H20 前旧行）"),
    ("confirm_rid_no_job", "确认已放行但平台无该 request_id 的 job（提交前中止/未提交，待甄别）"),
    ("confirm_event_lt_charged", "确认额<平台实扣（按 request_id 关联，实扣超出用户放行额）"),
    ("confirm_unlinked_table", "确认表无对应回执（generation_confirmations approved）"),
    ("frozen_unknown", "真相未明冻结（INC-0831，不退不重投，仅列示）"),
]


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def pfx(v, n=8):
    return "未取得" if v in (None, "") else str(v)[:n]


def coins(q):
    return round(q / Q, 4)


def read_pg(args):
    out = {}
    for name, sql in PG_QUERIES.items():
        if args.pg_dir:
            with open(os.path.join(args.pg_dir, name + ".csv"), newline="") as f:
                out[name] = list(csv.DictReader(f))
            continue
        cmd = shlex.split(args.psql)
        res = subprocess.run(cmd, input="COPY (%s) TO STDOUT WITH CSV HEADER;\n" % sql,
                             capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            raise SystemExit("psql 只读导出失败（%s）：%s" % (name, res.stderr.strip()[:300]))
        out[name] = list(csv.DictReader(io.StringIO(res.stdout)))
    return out


def read_gateway(args):
    db = sqlite3.connect("file:%s?mode=ro" % args.sessions_db, uri=True)
    db.execute("PRAGMA query_only=ON")
    receipts = []
    for task_id, kind, status, data, created in db.execute(
            "SELECT task_id, kind, status, data, created_at FROM generation_receipts WHERE kind IN ('image','video','audio')"):
        try:
            d = json.loads(data or "{}")
        except ValueError:
            d = {}
        receipts.append({"task_id": task_id, "kind": kind, "status": status, "cost": num(d.get("cost_coins")),
                         "request_id": d.get("request_id"), "model": d.get("model"), "created": created})
    confirmations = []
    has_conf = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_confirmations'").fetchone()
    if has_conf:
        for rid, amt, outcome, created in db.execute(
                "SELECT request_id, amount_coins, outcome, created_at FROM generation_confirmations"):
            confirmations.append({"request_id": rid, "amount": num(amt), "outcome": outcome, "created": created})
    db.close()
    events = []
    if os.path.exists(args.ledger):
        with open(args.ledger) as f:
            for line in f:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(o, dict):
                    continue
                events.append({"kind": o.get("kind"), "event": o.get("event"), "task_id": o.get("task_id"),
                               "cost": num(o.get("cost_coins")), "ts": o.get("ts"),
                               "request_id": o.get("request_id") if isinstance(o.get("request_id"), str) else None,
                               "workflow_id": o.get("workflow_id") if isinstance(o.get("workflow_id"), str) else None,
                               "refund_claim": o.get("refund_claim") if isinstance(o.get("refund_claim"), str) else None})
    return receipts, confirmations, events, has_conf is not None, os.path.exists(args.ledger)


def reconcile(pg, receipts, confirmations, events):
    findings = {k: [] for k, _ in CATS}

    def add(cat, amount_coins, **detail):
        findings[cat].append(dict(coins=round(amount_coins, 4) if amount_coins is not None else None, **detail))

    jobs = {r["id"]: r for r in pg["jobs"]}
    ops = collections.defaultdict(list)
    for o in pg["ops"]:
        ops[o["job_id"]].append(o)
    acct = collections.defaultdict(list)
    user_first = {}
    for a in pg["acct"]:
        uid = a.get("billing_user_id")
        if uid and (uid not in user_first or a["created_at"] < user_first[uid]):
            user_first[uid] = a["created_at"]
        if a.get("job_id"):
            acct[a["job_id"]].append(a)

    charged = {}
    for jid, j in jobs.items():
        jo = ops.get(jid, [])
        applied = [o for o in jo if o["status"] == "applied"]
        s = lambda op, proj=None: sum(num(o["amount"]) or 0 for o in applied if o["operation"] == op and (
            proj is None or o["idempotency_ref"].startswith("projection:") == proj))
        R, F, Cp, Cl, W = s("reserve"), s("refund"), s("commit", True), s("commit", False), s("writeoff")
        ch = R - F + Cp
        charged[jid] = ch
        status = j["status"]
        base = dict(job=pfx(jid), user=pfx(j.get("billing_user_id"), 3), kind=j["kind"], model=j["model_id"], status=status)
        # 同 job 同种操作多笔 applied
        # 只有真动用户余额的操作才算重复扣：reserve 与 projection commit（legacy commit 只是凭证）
        cnt = collections.Counter(o["operation"] for o in applied)
        n_proj = sum(1 for o in applied if o["operation"] == "commit" and o["idempotency_ref"].startswith("projection:"))
        if cnt["reserve"] > 1:
            add("dup_charge_ops", coins(R / cnt["reserve"] * (cnt["reserve"] - 1)), reason="reserve×%d" % cnt["reserve"], **base)
        if n_proj > 1:
            add("dup_charge_ops", coins(Cp / n_proj * (n_proj - 1)), reason="projection commit×%d" % n_proj, **base)
        if R > 0 and Cp > 0:
            add("dup_charge_ops", coins(min(R - F, Cp)), reason="reserve+projection 双扣", **base)
        if cnt["refund"] > 1:
            add("dup_refund", coins(F / cnt["refund"] * (cnt["refund"] - 1)), reason="refund×%d" % cnt["refund"], **base)
        elif R > 0 and F > R + 0.5:
            add("dup_refund", coins(F - R), reason="退款>预扣", **base)
        if F > 0 and R == 0 and Cp == 0:
            ghost = ",".join("reserve:%s" % o["status"] for o in jo if o["operation"] == "reserve" and o["status"] != "applied")
            add("refund_without_charge", coins(F), reason=ghost or "无 reserve 行", **base)
        # 冻结（INC-0831）
        pend = [o for o in jo if o["status"] in ("pending", "unknown")]
        if status in UNKNOWN_STATES or pend:
            add("frozen_unknown", coins(ch + sum(num(o["amount"]) or 0 for o in pend if o["operation"] == "reserve")),
                reason="job=%s ops=%s" % (status, ",".join("%s:%s" % (o["operation"], o["status"]) for o in pend) or "-"), **base)
        elif status == "refunded" and ch > 0.5:
            add("refunded_but_charged", coins(ch), **base)
        elif status in FAIL_STATES and ch > 0.5 and not (num(j.get("completed_count")) or 0) > 0:
            add("failed_charged_not_refunded", coins(ch), **base)
        if R > 0 and status in ({"succeeded", "refunded"} | FAIL_STATES) and not pend and abs(R - Cl - F) > 0.5:
            add("settle_gap", coins(R - Cl - F), reason="reserve=%s commit=%s refund=%s" % (coins(R), coins(Cl), coins(F)), **base)
        if status == "succeeded" and j.get("billing_user_id") and ch <= 0.5 and W == 0 and j.get("source") != "canary":
            add("success_uncharged", None, reason="billing_amount=%s" % coins(num(j["billing_amount"]) or 0), **base)
        # 帐本层
        rows = acct.get(jid, [])
        cons = [a for a in rows if a["entry_type"] == "consumption"]
        refs = [a for a in rows if a["entry_type"] == "refund"]
        if len(cons) > 1:
            add("dup_charge_ledger", coins(-sum(num(a["amount"]) or 0 for a in cons[1:])), reason="consumption×%d" % len(cons), **base)
        if len(refs) > 1:
            add("dup_refund", coins(sum(num(a["amount"]) or 0 for a in refs[1:])), reason="ledger refund×%d" % len(refs), **base)
        if refs and not cons and R == 0 and Cp == 0:
            add("refund_without_charge", coins(sum(num(a["amount"]) or 0 for a in refs)), reason="帐本退款无扣款", **base)
        # 帐本接管边界：只有该用户帐本首行之后 applied 的操作才「应该」有帐本行
        # （lazy 种帐：opening 已吸收接管前的预扣，接管后只记退款是正确的）。
        uid = j.get("billing_user_id")
        first = user_first.get(uid)
        exp = 0.0
        if first is not None:
            for o in applied:
                if o["created_at"] < first:
                    continue
                a = num(o["amount"]) or 0
                if o["operation"] == "reserve":
                    exp += a
                elif o["operation"] == "refund":
                    exp -= a
                elif o["operation"] == "commit" and o["idempotency_ref"].startswith("projection:"):
                    exp += a
        if rows:
            net = -sum(num(a["amount"]) or 0 for a in cons + refs)
            if abs(net - exp) > 0.5:
                add("ledger_ne_ops", coins(net - exp), reason="ledger=%s ops(接管后)=%s" % (coins(net), coins(exp)), **base)
        elif exp > 0.5:
            add("ledger_missing", coins(exp), **base)

    # 网关回执 × 平台
    by_req = collections.defaultdict(list)
    compared = [0]
    for r in receipts:
        j = jobs.get(r["task_id"])
        base = dict(job=pfx(r["task_id"]), kind=r["kind"], model=r["model"], gw=r["status"])
        if r.get("request_id"):
            by_req[r["request_id"]].append(r)
        if j is None:
            add("receipt_no_job", r["cost"], **base)
            continue
        ch = coins(charged[r["task_id"]])
        base.update(user=pfx(j.get("billing_user_id"), 3), status=j["status"])
        if j["status"] == "succeeded" and r["cost"] is not None:
            compared[0] += 1
        if j["status"] == "succeeded" and r["cost"] is not None and abs(ch - r["cost"]) > TOL:
            add("confirmed_ne_charged_over" if ch > r["cost"] else "confirmed_ne_charged_under", ch - r["cost"],
                reason="confirmed=%s charged=%s" % (r["cost"], ch), **base)
        if r["status"] == "refunded" and ch > TOL and j["status"] not in {"refunded"} | UNKNOWN_STATES:
            add("gw_refunded_but_charged", ch, reason="回执 refunded", **base)
        if r["status"] in ("failed", "cancelled") and j["status"] == "succeeded" and ch > TOL:
            add("gw_failed_platform_charged", ch, **base)
    for rid, rs in by_req.items():
        tids = {r["task_id"] for r in rs}
        paid = sorted((coins(charged[t]) for t in tids if t in jobs and charged[t] > 0.5), reverse=True)
        if len(paid) > 1:
            add("dup_charge_request", sum(paid[1:]), req=pfx(rid, 12), reason="%d job 均扣" % len(paid))

    # 网关 ledger.jsonl × 平台
    done = collections.defaultdict(float)
    done_n = collections.Counter()
    gw_ref = set()
    gw_claim = set()
    confirm_rids = []
    linked = [0, 0]
    for e in events:
        if e["kind"] in ("image", "video", "audio", "generation") and e["task_id"]:
            if e["event"] in ("done", "completed") and e["cost"] is not None:
                done[e["task_id"]] += e["cost"]
                done_n[e["task_id"]] += 1
            if e["event"] == "refunded":
                gw_ref.add(e["task_id"])
            # H22：网关只在平台证实时记 refunded；调用方声称已退记 failed+refund_claim，仍查「声称已退但平台仍扣」
            elif e["event"] == "failed" and e.get("refund_claim"):
                gw_claim.add(e["task_id"])
        if e["kind"] == "confirm" and e["event"] == "approved":
            rid = e.get("request_id")
            if not e["task_id"] and not rid:
                add("confirm_unlinked_event", e["cost"], ts=pfx(e["ts"], 10))
            elif rid:
                confirm_rids.append(e)
    for tid, c in done.items():
        if tid in jobs and abs(coins(charged[tid]) - c) > TOL:
            add("gw_ledger_ne_charged", coins(charged[tid]) - c, job=pfx(tid), status=jobs[tid]["status"],
                reason="ledger=%s(done×%d) charged=%s" % (round(c, 4), done_n[tid], coins(charged[tid])))
    rec_rids = set(by_req)
    seen_ref = {f["job"] for f in findings["gw_refunded_but_charged"]}
    for tid in gw_ref:
        if pfx(tid) in seen_ref:
            continue
        if tid in jobs and charged[tid] > 0.5 and jobs[tid]["status"] not in {"refunded"} | UNKNOWN_STATES:
            add("gw_refunded_but_charged", coins(charged[tid]), job=pfx(tid), status=jobs[tid]["status"], reason="ledger.jsonl refunded")
    for tid in gw_claim - gw_ref:
        if pfx(tid) in seen_ref:
            continue
        if tid in jobs and charged[tid] > 0.5 and jobs[tid]["status"] not in {"refunded"} | UNKNOWN_STATES:
            add("gw_refunded_but_charged", coins(charged[tid]), job=pfx(tid), status=jobs[tid]["status"], reason="ledger.jsonl 调用方声称已退（平台未证实）")
    for c in confirmations:
        if c["outcome"] == "approved" and c["request_id"] not in rec_rids:
            add("confirm_unlinked_table", c["amount"], req=pfx(c["request_id"], 12))
    # H20：confirm/approved 按 request_id 逐笔连 generation_job.idempotency_key
    by_key = collections.defaultdict(list)
    for j in jobs.values():
        k = j.get("idempotency_key")
        if k:
            by_key[k].append(j["id"])
    rec_by_rid = collections.defaultdict(set)
    for r in receipts:
        if r.get("request_id"):
            rec_by_rid[r["request_id"]].add(r["task_id"])
    for e in confirm_rids:
        rid = e["request_id"]
        if rid.startswith("wfgen_") or e.get("workflow_id"):
            linked[1] += 1  # 工作流批次：批次级关联（节点 job 用 pg: 键），不逐笔比额
            continue
        tids = set(by_key.get(rid, [])) | {t for t in rec_by_rid.get(rid, ()) if t in jobs}
        if not tids:  # upscale_audit 逐张 <rid>-<i>
            pre = rid + "-"
            tids = {t for k, ts in by_key.items() if k.startswith(pre) and k[len(pre):].isdigit() for t in ts}
        if not tids:
            add("confirm_rid_no_job", e["cost"], req=pfx(rid, 12), ts=pfx(e["ts"], 10))
            continue
        linked[0] += 1
        ch = sum(coins(charged[t]) for t in tids)
        if e["cost"] is not None and ch - e["cost"] > TOL:
            add("confirm_event_lt_charged", ch - e["cost"], req=pfx(rid, 12), jobs=len(tids),
                reason="confirmed=%s charged=%s" % (e["cost"], round(ch, 4)))
    findings["_confirmed_compared"] = compared[0]
    findings["_confirm_linked"] = tuple(linked)
    return findings


def summarize(findings):
    rows = []
    for k, label in CATS:
        fs = findings[k]
        amts = [f["coins"] for f in fs if f["coins"] is not None]
        rows.append({"category": k, "label": label, "count": len(fs),
                     "coins": round(sum(amts), 4) if amts else (0 if not fs else None),
                     "coins_missing": len(fs) - len(amts)})
    return rows


def main():
    ap = argparse.ArgumentParser(description="H18 计费三方对帐（只读）")
    ap.add_argument("--sessions-db", default="/opt/agent-harness/state/sessions.db")
    ap.add_argument("--ledger", default="/opt/agent-harness/ledger.jsonl")
    ap.add_argument("--psql", default=os.environ.get("BILLING_RECON_PSQL", DEFAULT_PSQL))
    ap.add_argument("--pg-dir", help="离线：读 DIR/jobs.csv ops.csv acct.csv 取代 psql")
    ap.add_argument("--json", action="store_true", help="只输出汇总 JSON")
    ap.add_argument("--limit", type=int, default=15, help="每类明细最多列几笔")
    args = ap.parse_args()
    pg = read_pg(args)
    receipts, confirmations, events, has_conf, has_ledger = read_gateway(args)
    findings = reconcile(pg, receipts, confirmations, events)
    compared = findings.pop("_confirmed_compared")
    linked_job, linked_wf = findings.pop("_confirm_linked")
    summary = summarize(findings)
    job_ids = {j["id"] for j in pg["jobs"]}
    meta = {"jobs": len(pg["jobs"]), "ops": len(pg["ops"]), "acct": len(pg["acct"]), "receipts": len(receipts),
            "confirmations": len(confirmations) if has_conf else "未取得", "ledger_events": len(events) if has_ledger else "未取得",
            "confirmed_compared": compared, "confirm_events_linked": linked_job, "confirm_events_workflow_batch": linked_wf,
            "receipts_joined": sum(1 for r in receipts if r["task_id"] in job_ids)}
    if args.json:
        print(json.dumps({"meta": meta, "summary": summary}, ensure_ascii=False, indent=1))
        return
    print("# H18 计费三方对帐（只读）")
    print("输入：" + "，".join("%s=%s" % kv for kv in meta.items()))
    print("\n| 类别 | 笔数 | 金额(币) | 金额未取得 |\n|---|---:|---:|---:|")
    for r in summary:
        print("| %s | %d | %s | %d |" % (r["label"], r["count"], "未取得" if r["coins"] is None else r["coins"], r["coins_missing"]))
    for k, label in CATS:
        fs = findings[k]
        if not fs:
            continue
        print("\n## %s（%d 笔，列前 %d）" % (label, len(fs), min(args.limit, len(fs))))
        for f in sorted(fs, key=lambda x: -abs(x["coins"] or 0))[:args.limit]:
            print("- " + " ".join("%s=%s" % (kk, "未取得" if vv is None else vv) for kk, vv in f.items()))


if __name__ == "__main__":
    main()
