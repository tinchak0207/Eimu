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
#   H23 音乐：音乐不经 generation_job，扣费记 music_charge（PK charge_ref＝music:<keyId>:<ref>，
#   只在音频产出后扣 1 次；status applied＝已扣，failed＝确定性未扣，pending/unknown＝未明冻结；
#   无退款路径）＋ account_ledger consumption 行（job_id＝charge_ref，source=music-charge）。
#   music-operation 回执（task_id＝music-operation:sha256(producer\0operation)，data.operation_id）
#   的 ref＝music:<producer_oc 或 parent_gw>:<operation_id>（call_… 直调 / pg:… 工程图节点），
#   故按 (会话, operation_id) 逐笔连 music_charge，比 回执确认额 vs 实扣；music_charge 表缺失＝「未取得」。
#   H33 历史已知旧帐分栏（只分栏、不改汇总口径、不改账、不改写旧日志）：
#     A. 双费 done：同 task 有 ≥2 行带费 done/completed（H22 口径，虚高＝带费合计−平台实扣）。
#        该 task 全部带费行 ts 早于截断 A ⇒ legacy；任一行 ≥ 截断 / ts 解析不了 ⇒ 截断后新增（告警）。
#     B. 旧车道 refunded 矛盾：gw_refunded_but_charged 中「ledger.jsonl refunded」且该 task 的 refunded 行
#        全是 kind=generation、ts 早于截断 B ⇒ legacy；其余（回执 refunded、现行车道、调用方声称、≥截断）⇒ 新增。
#     C.（H35）music-op 历史卡单：music-operation 回执停在非终态（queued 等）且无 applied 扣费。
#        写入方只存在于 2a571c55b 工程图（opencode-runtime music-tools-adapter.ts），由 4af310238 撤下，
#        截断 C＝同一 release 生效时刻；回执 created_at 严格早于截断 C ⇒ legacy（历史遗留，不告警）；
#        ≥截断且超过宽限（默认 30 分钟，--music-stuck-grace-min）⇒ 截断后新增（告警）；宽限内＝在途，只计数；
#        created_at 解析不了 ⇒ 新增（不藏）。只分栏：这些回执本来只在 meta.music.receipts_unfinished_uncharged 计数，
#        不在任何汇总类别里，汇总表口径不变；不改账、不终态化、不写库。
#     截断取真实生效时刻（VPS /opt/agent-harness/releases/gateway/history.log 第 3 列 epoch，非 commit 时间）。
#     告警与退出码只看截断后新增（A＋B＋C）：加 --alert-exit 时有新增 rc=2、否则 rc=0（其他类别仍只列示，不影响退出码）；
#     不加时 rc 恒 0（兼容既有调用方/探针，rc≠0 只表示脚本出错）。
#
# 用法（VPS）：
#   python3 deploy/vps/billing-recon.py                       # 默认路径 + 只读 psql
#   python3 deploy/vps/billing-recon.py --json                # 只出汇总 JSON
#   python3 deploy/vps/billing-recon.py --pg-dir DIR ...      # 离线：DIR 下 jobs.csv / ops.csv / acct.csv
import argparse, collections, csv, datetime, io, json, os, re, shlex, sqlite3, subprocess, sys

Q = 500000.0
TOL = 0.005  # 币
DEFAULT_PSQL = ("sudo -n docker exec -i -e PGOPTIONS=-c\\ default_transaction_read_only=on "
                "image-control-postgres psql -X -q -v ON_ERROR_STOP=1 -U image_control -d image_control")
PG_QUERIES = {
    "jobs": "SELECT id, billing_user_id, source, kind, model_id, status, billing_amount, requested_count, completed_count, created_at, idempotency_key FROM generation_job",
    "ops": "SELECT job_id, operation, amount, status, idempotency_ref, created_at FROM billing_operation",
    "acct": "SELECT id, billing_user_id, entry_type, amount, source, job_id, created_at FROM account_ledger",
}
# 可选表：缺表/无权限不终止对帐，按「未取得」输出（H23 music_charge）。
OPTIONAL_PG_QUERIES = {
    "music": "SELECT charge_ref, billing_user_id, amount_quota, status, created_at, updated_at FROM music_charge",
}
FAIL_STATES = {"failed", "cancelled", "canceled"}
UNKNOWN_STATES = {"submit_unknown", "billing_unknown"}
GEN_KINDS = ("image", "video", "audio")
# H33 截断（UTC）。A＝8cfae3979（H22 done 幂等＋refunded 以平台为准）网关 release
# 8cfae3979cdb-20261103T235628Z-304292 生效，history.log epoch 1793750220＝2026-11-04 07:57:00 SGT。
# B＝4af310238（10-30 整树还原，撤下 2a571c55b 工程图引入的 kind=generation 车道写入方，其后各 release 均无该写入方）
# 网关 release 4af310238e8f-20261030T081715Z-176185 生效，history.log epoch 1793348262＝2026-10-30 16:17:42 SGT。
LEGACY_CUTOFF_DONE_DUP = "2026-11-03T23:57:00Z"
LEGACY_CUTOFF_GEN_REFUND = "2026-10-30T08:17:42Z"
LEGACY_SRC_DONE_DUP = "8cfae3979 网关 release 8cfae3979cdb-20261103T235628Z-304292 生效（history.log epoch 1793750220）"
LEGACY_SRC_GEN_REFUND = "4af310238 撤下 generation 车道写入方，网关 release 4af310238e8f-20261030T081715Z-176185 生效（history.log epoch 1793348262）"
# H35 截断 C（UTC）＝4af310238 撤下 2a571c55b 工程图 music-operation 回执写入方（git grep：2a571c55b 有 4+3 处，4af310238 起 0 处）
# 的网关 release 生效时刻，与截断 B 同一 release。生产最后一条 music-operation 回执 created 10-30 13:51:27 SGT，早于截断。
LEGACY_CUTOFF_MUSIC_OP = "2026-10-30T08:17:42Z"
LEGACY_SRC_MUSIC_OP = "4af310238 撤下工程图 music-operation 回执写入方，网关 release 4af310238e8f-20261030T081715Z-176185 生效（history.log epoch 1793348262）"
MUSIC_STUCK_GRACE_MIN = 30
MUSIC_TERMINAL = {"succeeded", "failed", "cancelled", "canceled", "refunded"}

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
    ("music_confirmed_ne_charged", "音乐：回执确认额≠music_charge 实扣"),
    ("music_success_uncharged", "音乐：回执成功但 music_charge 无 applied 扣费（漏扣，含扣费未完成）"),
    ("music_unfinished_charged", "音乐：回执未成功（failed/queued 等）却有 applied 扣费"),
    ("music_charge_dup", "音乐：同一 operation 多笔 applied 扣费"),
    ("music_charge_unsettled", "音乐：music_charge pending/unknown（INC-0831 冻结，仅列示）"),
    ("music_ledger_ne_charge", "音乐：account_ledger music-charge 净额≠music_charge applied 额"),
    ("music_receipt_unlinked", "音乐回执无法关联（music_charge 未取得或回执缺 operation_id）"),
    ("confirm_unlinked_event", "确认事件无法逐笔关联（ledger confirm/approved 无 task_id 也无 request_id，H20 前旧行）"),
    ("confirm_rid_no_job", "确认已放行但平台无该 request_id 的 job（提交前中止/未提交，待甄别）"),
    ("confirm_event_lt_charged", "确认额<平台实扣（按 request_id 关联，实扣超出用户放行额）"),
    ("confirm_unlinked_table", "确认表无对应回执（generation_confirmations approved）"),
    ("frozen_unknown", "真相未明冻结（INC-0831，不退不重投，仅列示）"),
]


def ts_epoch(v):
    """ISO（ledger ts）或 PG timestamptz 文本 → epoch 秒；解析不了回 None（不猜）。"""
    if not isinstance(v, str) or not v:
        return None
    t = v.strip().replace(" ", "T", 1)
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    m = re.match(r"^(.*[T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$", t)
    if m:
        t = "%s%s:%s" % (m.group(1), m.group(2), m.group(3) or "00")
    t = re.sub(r"\.(\d{6})\d+", r".\1", t)
    try:
        d = datetime.datetime.fromisoformat(t)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d.timestamp()


def music_ledger_link(music, events):
    """H34：ledger audio done 行 × music_charge 逐笔关联（只计数，不入金额类别、不改账）。
    按 (tool_session, tool_call_id) 归一次工具调用（多 take 不重复计）：
      exact＝行带 music_ref 且平台有 charge_ref＝music:<keyId>:<music_ref>；
      session_time＝无 music_ref，按 tool_session 在 [ts-900s, ts+60s] 唯一命中一笔；
      ambiguous＝该窗多笔；unlinked＝零笔；legacy_no_keys＝H34 前旧行（无 tool_session，无法逐笔）。"""
    by_inner, by_sess = {}, collections.defaultdict(list)
    for c in music:
        parts = (c.get("charge_ref") or "").split(":", 2)
        if len(parts) != 3:
            continue
        by_inner.setdefault(parts[2], c)
        inner = parts[2].split(":", 2)
        if len(inner) == 3 and inner[0] == "music":
            by_sess[inner[1]].append((ts_epoch(c.get("created_at")), parts[2]))
    out = collections.Counter()
    calls = {}
    for e in events:
        if e["kind"] != "audio" or e["event"] != "done":
            continue
        out["rows"] += 1
        if not e.get("tool_session"):
            out["legacy_no_keys"] += 1
            continue
        k = (e["tool_session"], e.get("tool_call_id") or ("row", out["rows"]))
        prev = calls.get(k)
        if prev is None or (not prev.get("music_ref") and e.get("music_ref")):
            calls[k] = e
    used = set()
    for e in calls.values():
        out["calls_keyed"] += 1
        if e.get("music_ref"):
            if e["music_ref"] in by_inner:
                out["exact"] += 1
                used.add(e["music_ref"])
            else:
                out["ref_no_charge"] += 1
            continue
        t = ts_epoch(e.get("ts"))
        hits = [r for (ct, r) in by_sess.get(e["tool_session"], []) if t is not None and ct is not None and t - 900 <= ct <= t + 60]
        if len(hits) == 1:
            out["session_time"] += 1
            used.add(hits[0])
        elif hits:
            out["ambiguous"] += 1
        else:
            out["unlinked"] += 1
    out["charges_linked"] = len(used)
    return {"ledger_link_" + k: out[k] for k in ("rows", "legacy_no_keys", "calls_keyed", "exact", "session_time",
                                                 "ambiguous", "unlinked", "ref_no_charge", "charges_linked")}


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
    for name, sql in OPTIONAL_PG_QUERIES.items():
        out[name] = None  # None＝未取得（不以空表冒充）
        if args.pg_dir:
            fp = os.path.join(args.pg_dir, name + ".csv")
            if os.path.exists(fp):
                with open(fp, newline="") as f:
                    out[name] = list(csv.DictReader(f))
            continue
        res = subprocess.run(shlex.split(args.psql), input="COPY (%s) TO STDOUT WITH CSV HEADER;\n" % sql,
                             capture_output=True, text=True, timeout=300)
        if res.returncode == 0:
            out[name] = list(csv.DictReader(io.StringIO(res.stdout)))
        else:
            print("注意：可选表 %s 只读导出失败，按「未取得」处理" % name, file=sys.stderr)
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
                         "request_id": d.get("request_id"), "model": d.get("model"), "created": created,
                         "operation_id": d.get("operation_id") if isinstance(d.get("operation_id"), str) else None,
                         "producer_oc": d.get("producer_oc") if isinstance(d.get("producer_oc"), str) else None,
                         "parent_gw": d.get("parent_gw") if isinstance(d.get("parent_gw"), str) else None,
                         "result_source": d.get("result_source"),
                         "submission_state": d.get("submission_state") if isinstance(d.get("submission_state"), str) else None})
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
                               "refund_claim": o.get("refund_claim") if isinstance(o.get("refund_claim"), str) else None,
                               "refund_backfill_of": o.get("refund_backfill_of") if isinstance(o.get("refund_backfill_of"), str) else None,
                               # H34：audio done 关联键（只读；旧行无＝legacy）
                               "tool_session": o.get("tool_session") if isinstance(o.get("tool_session"), str) else None,
                               "tool_call_id": o.get("tool_call_id") if isinstance(o.get("tool_call_id"), str) else None,
                               "music_ref": o.get("music_ref") if isinstance(o.get("music_ref"), str) else None})
    return receipts, confirmations, events, has_conf is not None, os.path.exists(args.ledger)


def reconcile(pg, receipts, confirmations, events, cutoffs=None):
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
    music = pg.get("music")
    mm = collections.Counter()  # 音乐对帐计数（meta）
    m_idx = collections.defaultdict(list)  # (会话, operation_id) → music_charge 行
    if music is not None:
        for c in music:
            ref = c.get("charge_ref") or ""
            parts = ref.split(":", 2)  # music:<keyId>:<ref>
            inner = parts[2].split(":", 2) if len(parts) == 3 else []
            if len(inner) == 3 and inner[0] == "music":
                m_idx[(inner[1], inner[2])].append(c)
            st = c.get("status")
            amt = num(c.get("amount_quota")) or 0
            mm["charges"] += 1
            mm["charges_" + str(st)] += 1
            if st == "applied":
                mm["_applied_q"] += amt
            mbase = dict(user=pfx(c.get("billing_user_id"), 3), charge_status=st, ts=pfx(c.get("created_at"), 16))
            if st in ("pending", "unknown"):
                add("music_charge_unsettled", coins(amt), reason="music_charge %s" % st, **mbase)
            rows = acct.get(ref, [])
            net = -sum(num(a["amount"]) or 0 for a in rows)
            exp = amt if st == "applied" else 0.0
            if rows:
                mm["_ledger_q"] += net
            if abs(net - exp) > 0.5:
                add("music_ledger_ne_charge", coins(net - exp),
                    reason="ledger=%s(%d 行) charge=%s" % (coins(net), len(rows), coins(exp)), **mbase)
    m_used = set()
    stuck = []  # H35

    def music_receipt(r):
        h = r["task_id"].split(":", 1)[-1]
        base = dict(job="mop:" + h[:8], kind=r["kind"], gw=r["status"])
        mm["receipts"] += 1
        op = r.get("operation_id")
        if music is None or not op:
            mm["receipts_unlinked"] += 1
            add("music_receipt_unlinked", r["cost"], reason="music_charge 未取得" if music is None else "回执缺 operation_id", **base)
            return
        cands, seen = [], set()
        for sess in (r.get("producer_oc"), r.get("parent_gw")):
            for c in (m_idx.get((sess, op), []) if sess else []):
                if c["charge_ref"] not in seen:
                    seen.add(c["charge_ref"]); cands.append(c)
        m_used.update(seen)
        applied = [c for c in cands if c.get("status") == "applied"]
        unsettled = [c for c in cands if c.get("status") in ("pending", "unknown")]
        ch = coins(sum(num(c.get("amount_quota")) or 0 for c in applied))
        if len(applied) > 1:
            add("music_charge_dup", coins(sum(num(c.get("amount_quota")) or 0 for c in applied[1:])),
                reason="applied×%d" % len(applied), **base)
        if r["status"] == "succeeded":
            if applied:
                mm["receipts_linked_charged"] += 1
                ch1 = coins(num(applied[0].get("amount_quota")) or 0)  # 多扣部分已入 music_charge_dup，不双计
                if r["cost"] is not None and abs(ch1 - r["cost"]) > TOL:
                    add("music_confirmed_ne_charged", ch1 - r["cost"], reason="confirmed=%s charged=%s" % (r["cost"], ch1), **base)
                else:
                    mm["_matched_coins"] += ch1
            elif unsettled:
                mm["receipts_linked_frozen"] += 1  # 已在 music_charge_unsettled 列示
            elif r["cost"] is None or r["cost"] > TOL:
                add("music_success_uncharged", r["cost"],
                    reason="回执 cost_coins=%s，music_charge 无 applied" % ("null（扣费未完成）" if r["cost"] is None else r["cost"]), **base)
            else:
                mm["receipts_succeeded_zero_cost"] += 1
        elif applied:
            add("music_unfinished_charged", ch, reason="回执 %s 但已扣 %s" % (r["status"], ch), **base)
        else:
            mm["receipts_unfinished_uncharged"] += 1  # 未出音频即不扣：正确，不计差额
            mm["receipts_unfinished_uncharged_" + str(r["status"])] += 1
            if r["status"] not in MUSIC_TERMINAL:  # H35：非终态卡单候选（分栏见 legacy_split C）
                stuck.append(dict(job=base["job"], gw=r["status"], submission_state=r.get("submission_state"),
                                  created=r.get("created"), frozen_charge=len(unsettled)))

    for r in receipts:
        j = jobs.get(r["task_id"])
        base = dict(job=pfx(r["task_id"]), kind=r["kind"], model=r["model"], gw=r["status"])
        if r.get("request_id"):
            by_req[r["request_id"]].append(r)
        if j is None and (str(r["task_id"]).startswith("music-operation:") or r.get("result_source") == "runtime_music"):
            music_receipt(r)
            continue
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
    if music is None:
        mmeta = "未取得"
    else:
        mmeta = {k: v for k, v in mm.items() if not k.startswith("_")}
        mmeta["charged_coins_applied"] = coins(mm["_applied_q"])
        mmeta["ledger_coins"] = coins(mm["_ledger_q"])
        mmeta["receipt_matched_coins"] = round(mm["_matched_coins"], 4)
        mmeta["charges_without_receipt"] = sum(1 for c in music if c.get("charge_ref") not in m_used)  # music_gen 直调不写回执，正常
        mmeta["refunds"] = "无退款路径（failed＝确定性未扣）"
        mmeta.update(music_ledger_link(music, events))  # H34
    findings["_music"] = mmeta
    # H31：ledger 退款记录完整度（只计数、不入金额类别）。failed_tasks_platform_refunded＝ledger 有 failed 行、平台 job 已 refunded
    # 的 task；其中无任一车道 refunded 行＝少报（logged_refund_missing）。backfill_rows＝网关见平台事后退款补记的行（H31 上线后才有）。
    failed_t = {e["task_id"] for e in events if e["kind"] in ("image", "video", "audio") and e["task_id"] and e["event"] == "failed"}
    pr = {t for t in failed_t if t in jobs and jobs[t]["status"] == "refunded"}
    findings["_refund_logging"] = {"failed_tasks_platform_refunded": len(pr), "with_refunded_row": len(pr & gw_ref),
                                   "logged_refund_missing": len(pr - gw_ref),
                                   "backfill_rows": sum(1 for e in events if e["event"] == "refunded" and e.get("refund_backfill_of"))}
    findings["_legacy_split"] = legacy_split(findings, jobs, charged, events, cutoffs or {}, stuck)
    findings["_confirmed_compared"] = compared[0]
    findings["_confirm_linked"] = tuple(linked)
    return findings


def created_epoch(v):
    """H35：回执 created_at（sessions.db 毫秒 epoch 整数/数字串，或 ISO 文本）→ epoch 秒；解析不了回 None。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v / 1000.0 if v > 1e11 else float(v)
    if isinstance(v, str) and re.match(r"^\d{10,13}$", v.strip()):
        return created_epoch(int(v.strip()))
    return ts_epoch(v)


def sgt(e):
    return datetime.datetime.fromtimestamp(e, datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S SGT")


def legacy_split(findings, jobs, charged, events, cutoffs, stuck=()):
    """H33：两类历史已知旧帐按真实生效时刻分栏。只读、只计数；在明细上加 legacy= 标记，不增删任何类别条目。"""
    ca_iso = cutoffs.get("done_dup") or LEGACY_CUTOFF_DONE_DUP
    cb_iso = cutoffs.get("gen_refund") or LEGACY_CUTOFF_GEN_REFUND
    cc_iso = cutoffs.get("music_op") or LEGACY_CUTOFF_MUSIC_OP
    ca, cb, cc = ts_epoch(ca_iso), ts_epoch(cb_iso), ts_epoch(cc_iso)
    if ca is None or cb is None or cc is None:
        raise SystemExit("截断时刻解析失败：%s / %s / %s" % (ca_iso, cb_iso, cc_iso))
    grace = cutoffs.get("music_grace_min")
    grace = MUSIC_STUCK_GRACE_MIN if grace is None else grace
    if grace < 0:
        raise SystemExit("--music-stuck-grace-min 不能为负：%s" % grace)
    now = cutoffs.get("now")
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    # A. 双费 done（H22 口径：带费＝cost_coins>0）
    costed = collections.defaultdict(list)
    for e in events:
        if e["kind"] in ("image", "video", "audio", "generation") and e["task_id"] and e["event"] in ("done", "completed") \
                and (e["cost"] or 0) > 0:
            costed[e["task_id"]].append(e)
    a = {"legacy": [0, 0.0, 0], "new": [0, 0.0, 0]}  # 笔数、虚高币、虚高未取得（无平台 job）
    a_new, a_legacy = [], set()
    for tid, rs in costed.items():
        if len(rs) < 2:
            continue
        tss = [ts_epoch(r["ts"]) for r in rs]
        col = "legacy" if all(t is not None and t < ca for t in tss) else "new"
        a[col][0] += 1
        if tid in jobs:
            a[col][1] += sum(r["cost"] for r in rs) - coins(charged[tid])
        else:
            a[col][2] += 1
        if col == "legacy":
            a_legacy.add(pfx(tid))
        else:
            a_new.append(dict(job=pfx(tid), rows=len(rs), last_ts=max((r["ts"] or "") for r in rs)[:19],
                              overcount=round(sum(r["cost"] for r in rs) - coins(charged[tid]), 4) if tid in jobs else None))
    # B. 旧车道 refunded 矛盾：按 gw_refunded_but_charged 条目逐笔判（legacy+new＝汇总该类别）
    ref_rows = collections.defaultdict(list)
    for e in events:
        if e["task_id"] and e["event"] == "refunded" and e["kind"] in ("image", "video", "audio", "generation"):
            ref_rows[pfx(e["task_id"])].append(e)
    b = {"legacy": [0, 0.0], "new": [0, 0.0]}
    b_new = []
    for f in findings["gw_refunded_but_charged"]:
        rs = ref_rows.get(f["job"], [])
        old = f.get("reason") == "ledger.jsonl refunded" and rs and all(
            r["kind"] == "generation" and ts_epoch(r["ts"]) is not None and ts_epoch(r["ts"]) < cb for r in rs)
        col = "legacy" if old else "new"
        b[col][0] += 1
        b[col][1] += f["coins"] or 0
        if old:
            f["legacy"] = "H33旧车道refunded"
        else:
            b_new.append(dict(job=f["job"], reason=f.get("reason"), lanes=",".join(sorted({r["kind"] or "?" for r in rs})) or "-",
                              ts=min((r["ts"] or "") for r in rs)[:19] if rs else "-", coins=f["coins"]))
    # 信息：gw_ledger_ne_charged 中属 A 类 legacy 的条目（不改该类别汇总）
    gl = [0, 0.0]
    for f in findings["gw_ledger_ne_charged"]:
        if f["job"] in a_legacy:
            f["legacy"] = "H33双费done"
            gl[0] += 1
            gl[1] += f["coins"] or 0
    # C. H35 music-op 非终态卡单（无 applied 扣费）：legacy／新增（告警）／在途
    c_legacy, c_new, c_flight = [], [], []
    for x in stuck:
        e = created_epoch(x.get("created"))
        d = dict(job=x["job"], gw=x["gw"], submission_state=x.get("submission_state"),
                 created=sgt(e) if e is not None else "未取得", frozen_charge=x.get("frozen_charge", 0))
        if e is not None and e < cc:
            c_legacy.append(d)
        elif e is not None and now - e < grace * 60:
            c_flight.append(d)
        else:
            d["age_min"] = round((now - e) / 60.0, 1) if e is not None else None
            c_new.append(d)
    r4 = lambda x: round(x, 4)
    return {
        "done_dup_costed": {"cutoff": ca_iso, "cutoff_source": LEGACY_SRC_DONE_DUP if not cutoffs.get("done_dup") else "命令行覆盖",
                            "legacy_tasks": a["legacy"][0], "legacy_overcount_coins": r4(a["legacy"][1]),
                            "legacy_overcount_missing": a["legacy"][2],
                            "new_tasks": a["new"][0], "new_overcount_coins": r4(a["new"][1]), "new_overcount_missing": a["new"][2],
                            "new_detail": sorted(a_new, key=lambda x: x["last_ts"])},
        "gen_refunded_contra": {"cutoff": cb_iso, "cutoff_source": LEGACY_SRC_GEN_REFUND if not cutoffs.get("gen_refund") else "命令行覆盖",
                                "legacy_count": b["legacy"][0], "legacy_coins": r4(b["legacy"][1]),
                                "new_count": b["new"][0], "new_coins": r4(b["new"][1]), "new_detail": b_new},
        "gw_ledger_ne_charged_in_legacy_done_dup": {"count": gl[0], "coins": r4(gl[1])},
        "music_op_stuck": {"cutoff": cc_iso, "cutoff_source": LEGACY_SRC_MUSIC_OP if not cutoffs.get("music_op") else "命令行覆盖",
                           "grace_min": grace, "charged_coins": 0.0,
                           "legacy_count": len(c_legacy), "legacy_detail": sorted(c_legacy, key=lambda x: x["created"]),
                           "new_count": len(c_new), "new_detail": sorted(c_new, key=lambda x: x["created"]),
                           "in_flight_count": len(c_flight), "in_flight_detail": c_flight},
        "alerts": a["new"][0] + b["new"][0] + len(c_new),
    }


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
    ap.add_argument("--pg-dir", help="离线：读 DIR/jobs.csv ops.csv acct.csv（可选 music.csv）取代 psql")
    ap.add_argument("--json", action="store_true", help="只输出汇总 JSON")
    ap.add_argument("--limit", type=int, default=15, help="每类明细最多列几笔")
    ap.add_argument("--cutoff-done-dup", help="H33 覆盖截断 A（ISO，默认 %s）" % LEGACY_CUTOFF_DONE_DUP)
    ap.add_argument("--cutoff-gen-refund", help="H33 覆盖截断 B（ISO，默认 %s）" % LEGACY_CUTOFF_GEN_REFUND)
    ap.add_argument("--cutoff-music-op", help="H35 覆盖截断 C（ISO，默认 %s）" % LEGACY_CUTOFF_MUSIC_OP)
    ap.add_argument("--music-stuck-grace-min", type=float, help="H35：截断后 music-op 非终态超过 N 分钟才告警（默认 %d）" % MUSIC_STUCK_GRACE_MIN)
    ap.add_argument("--now", help="H35：以该 ISO 时刻当作现在（离线复现用；默认真实当前时刻）")
    ap.add_argument("--alert-exit", action="store_true", help="H33/H35：截断后新增（双费 done／refunded 矛盾／music-op 卡单）>0 时退出码 2")
    args = ap.parse_args()
    pg = read_pg(args)
    receipts, confirmations, events, has_conf, has_ledger = read_gateway(args)
    now = None
    if args.now:
        now = ts_epoch(args.now)
        if now is None:
            raise SystemExit("--now 解析失败：%s" % args.now)
    findings = reconcile(pg, receipts, confirmations, events,
                         cutoffs={"done_dup": args.cutoff_done_dup, "gen_refund": args.cutoff_gen_refund,
                                  "music_op": args.cutoff_music_op, "music_grace_min": args.music_stuck_grace_min, "now": now})
    legacy = findings.pop("_legacy_split")
    compared = findings.pop("_confirmed_compared")
    linked_job, linked_wf = findings.pop("_confirm_linked")
    music_meta = findings.pop("_music")
    refund_logging = findings.pop("_refund_logging")
    summary = summarize(findings)
    job_ids = {j["id"] for j in pg["jobs"]}
    meta = {"jobs": len(pg["jobs"]), "ops": len(pg["ops"]), "acct": len(pg["acct"]), "receipts": len(receipts),
            "confirmations": len(confirmations) if has_conf else "未取得", "ledger_events": len(events) if has_ledger else "未取得",
            "confirmed_compared": compared, "confirm_events_linked": linked_job, "confirm_events_workflow_batch": linked_wf,
            "receipts_joined": sum(1 for r in receipts if r["task_id"] in job_ids), "music": music_meta,
            "refund_logging": refund_logging}
    rc = 2 if (args.alert_exit and legacy["alerts"]) else 0  # H33：退出码只看截断后新增（opt-in）
    if args.json:
        print(json.dumps({"meta": meta, "summary": summary, "legacy_split": legacy}, ensure_ascii=False, indent=1))
        sys.exit(rc)
    print("# H18 计费三方对帐（只读）")
    print("输入：" + "，".join("%s=%s" % kv for kv in meta.items() if kv[0] not in ("music", "refund_logging")))
    print("退款记录（ledger×平台，只计数）：" + "，".join("%s=%s" % kv for kv in refund_logging.items()))
    mmeta = meta["music"]
    print("音乐（music_charge）：" + (mmeta if isinstance(mmeta, str) else "，".join("%s=%s" % kv for kv in sorted(mmeta.items()))))
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
    A, B = legacy["done_dup_costed"], legacy["gen_refunded_contra"]
    print("\n## 历史已知旧帐（H33 截断前，仅列示，不告警；汇总表口径不变）")
    print("- 双费 done（截断 %s；%s）：legacy %d 个 task，虚高 %s 币（虚高未取得 %d）" % (
        A["cutoff"], A["cutoff_source"], A["legacy_tasks"], A["legacy_overcount_coins"], A["legacy_overcount_missing"]))
    print("- 旧车道 refunded 矛盾（截断 %s；%s）：legacy %d 笔，%s 币" % (
        B["cutoff"], B["cutoff_source"], B["legacy_count"], B["legacy_coins"]))
    g = legacy["gw_ledger_ne_charged_in_legacy_done_dup"]
    print("- 其中「%s」类别里属双费 done legacy：%d 笔，%s 币" % (dict(CATS)["gw_ledger_ne_charged"], g["count"], g["coins"]))
    C = legacy["music_op_stuck"]
    print("- music-op 历史卡单（H35，截断 %s；%s）：legacy %d 笔，均无 applied 扣费（扣费 0 币，不改账、不终态化）" % (
        C["cutoff"], C["cutoff_source"], C["legacy_count"]))
    for d in C["legacy_detail"][:args.limit]:
        print("  - " + " ".join("%s=%s" % (k, "未取得" if v is None else v) for k, v in d.items()))
    print("\n## 告警（截断后新增）：%d" % legacy["alerts"])
    print("- 双费 done 新增：%d 个 task，虚高 %s 币（未取得 %d）" % (A["new_tasks"], A["new_overcount_coins"], A["new_overcount_missing"]))
    for d in A["new_detail"][:args.limit]:
        print("  - " + " ".join("%s=%s" % (k, "未取得" if v is None else v) for k, v in d.items()))
    print("- refunded 矛盾新增（非旧车道或截断后）：%d 笔，%s 币" % (B["new_count"], B["new_coins"]))
    for d in B["new_detail"][:args.limit]:
        print("  - " + " ".join("%s=%s" % (k, "未取得" if v is None else v) for k, v in d.items()))
    print("- music-op 非终态卡单新增（截断后且超过 %s 分钟）：%d 笔；在途（宽限内，不告警）：%d 笔" % (
        C["grace_min"], C["new_count"], C["in_flight_count"]))
    for d in C["new_detail"][:args.limit]:
        print("  - " + " ".join("%s=%s" % (k, "未取得" if v is None else v) for k, v in d.items()))
    sys.exit(rc)


if __name__ == "__main__":
    main()
