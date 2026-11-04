#!/usr/bin/env python3
# H28 计费 unknown/failed 操作「对上游 new-api 核对」——只读，出拍板建议，不改账、不调 admin action。
#
# 为什么需要：new-api /api/user/manage add_quota 没有幂等键（image-billing.ts），所以 refund 遇到
# 网络错误（fetch failed／超时／5xx）时帐本按 INC-0831 冻结为 unknown，永不自动重放（防双退）。
# 人工裁决（admin /api/admin/billing-operations action=mark_applied|retry）前必须对上游账——本工具把
# 2bc5aefd（H21/27）与 b0848d23（H28）用过的核法固化：
#   1. 上游管理日志：new-api logs type=3「Increased/Decreased user quota by ＄X」，other.op.params.target_user_id
#      ＝目标用户（07-20 前旧格式「管理员增加/减少用户额度 ＄X」，user_id＝目标）。1 币＝500000 quota＝＄1（QuotaPerUnit）。
#   2. 认领：所有 applied 的 reserve/refund 先按（用户, 方向, 金额, 时间窗）各认领 1 条日志（贪心、最近优先、
#      一条只认一次），防止把相邻同额的已落地操作（例：0ae761b6 退款 4 秒前同用户同额）错算给目标操作。
#   3. 目标操作（refund unknown/failed，可选 reserve unknown）在其尝试时间窗内找「未被认领」的同额日志。
#   4. 余额闭合：同一只读快照内 users.quota 必须＝该用户全部改额日志净额（充值 type1＋消费 type2＋管理 type3
#      ＋系统 type4＋退款 type6）。闭合＝日志完整，「窗内无日志」才可推出「上游没执行」；不闭合一律转人工。
# 建议规则（refund）：
#   窗内恰 1 条未认领日志 且 窗外无其它未认领同额加项        ⇒ mark_applied（上游已退，只补帐本状态）
#   窗内 0 条 且 余额闭合 且 目标时间后无未认领同额加项        ⇒ retry（上游未退；stranded 恰退一次）
#   其余（多条候选／余额不闭合／时间后有疑似人工补偿）          ⇒ manual（不给自动建议）
# reserve unknown 只给上游是否执行的证据，建议恒为 manual：reserve 的 mark_applied 会把 job 改回 queued
# （query.ts reconcileBillingOperationManually）＝重新付费生成，按 INC-0831 由人裁决。
#
# 硬纪律：new-api one-api.db 以 file:?mode=ro 打开＋PRAGMA query_only=ON，单一读事务快照；平台 postgres 只走
# default_transaction_read_only=on 的 COPY (SELECT) TO STDOUT。不写任何档、不改帐、不发 admin action、不打上游 API。
# 输出只含 op/job id、用户 id、金额、时间——不含邮箱、token、提示词。
#
# 用法（VPS，one-api.db 属 root 0600，需 sudo）：
#   ssh … 'sudo -n python3 - --json' < deploy/vps/billing-unknown-upstream.py
#   ssh … 'sudo -n python3 - --op-id <uuid>' < …      # 指定任意操作（含 applied，用于反证）
#   离线：--newapi-db X.db --pg-dir DIR（DIR/ops.csv，列见 OPS_COLS）
import argparse, bisect, collections, csv, datetime, io, json, re, shlex, sqlite3, subprocess, sys

Q = 500000  # quota / 币（＝＄1）
DEFAULT_DB = "/opt/imagesite/new-api-data/one-api.db"
DEFAULT_PSQL = ("docker exec -i -e PGOPTIONS=-c\\ default_transaction_read_only=on "
                "image-control-postgres psql -X -q -v ON_ERROR_STOP=1 -U image_control -d image_control")
OPS_COLS = ["op_id", "job_id", "operation", "status", "amount", "attempt_count", "last_error",
            "created_at", "last_attempt_at", "applied_at", "updated_at",
            "billing_user_id", "job_status", "billing_amount", "acct_refund"]
OPS_SQL = ("SELECT o.id, o.job_id, o.operation, o.status, o.amount, o.attempt_count, o.last_error, "
           "extract(epoch from o.created_at), extract(epoch from o.last_attempt_at), extract(epoch from o.applied_at), "
           "extract(epoch from o.updated_at), j.billing_user_id, j.status, j.billing_amount, "
           "(SELECT count(*) FROM account_ledger a WHERE a.job_id = o.job_id::text AND a.entry_type = 'refund') "
           "FROM billing_operation o JOIN generation_job j ON j.id = o.job_id "
           "WHERE o.operation IN ('reserve','refund') AND j.billing_user_id IS NOT NULL")
WIN_BEFORE = 2     # 秒：日志可早于 last_attempt_at 的时钟偏差
WIN_AFTER = 35     # 秒：中继 AbortSignal.timeout(30s)＋余量
APPLIED_SLACK = 2  # 秒：applied 操作窗＝[last_attempt−2, applied_at+2]
NEW_RE = re.compile(r"^(Increased|Decreased) user quota by ＄([0-9.]+)")
OLD_RE = re.compile(r"^管理员(增加|减少)用户额度 ＄([0-9.]+)")
DOLLAR_RE = re.compile(r"＄([0-9.]+)")


def fnum(x):
    try:
        return float(x) if x not in (None, "") else None
    except ValueError:
        return None


def iso(ts):
    return None if ts is None else datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(timespec="seconds")


def load_ops(args):
    if args.pg_dir:
        with open(f"{args.pg_dir}/ops.csv", newline="") as fh:
            rows = list(csv.reader(fh))
        if rows and rows[0] == OPS_COLS:
            rows = rows[1:]
    else:
        res = subprocess.run(shlex.split(args.psql), input=f"COPY ({OPS_SQL}) TO STDOUT WITH CSV;\n",
                             capture_output=True, text=True)
        if res.returncode != 0:
            raise SystemExit("psql 只读导出失败：%s" % res.stderr.strip()[:300])
        rows = list(csv.reader(io.StringIO(res.stdout)))
    ops = []
    for r in rows:
        d = dict(zip(OPS_COLS, r))
        d["amount"] = int(float(d["amount"]))
        d["billing_user_id"] = int(float(d["billing_user_id"]))
        d["billing_amount"] = int(float(d["billing_amount"] or 0))
        d["attempt_count"] = int(float(d["attempt_count"] or 0))
        d["acct_refund"] = int(float(d["acct_refund"] or 0))
        for k in ("created_at", "last_attempt_at", "applied_at", "updated_at"):
            d[k] = fnum(d[k])
        ops.append(d)
    return ops


def load_newapi(path, users):
    """单一只读快照：返回 (manage_logs, balance)。manage_logs[(uid, dir, quota)] = 升序 [(ts, log_id)]。"""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.execute("PRAGMA query_only=ON")
    con.execute("BEGIN")  # 读事务：users 与 logs 同一快照，余额闭合才有意义
    manage = collections.defaultdict(list)
    net = collections.Counter()
    unparsed = collections.Counter()
    for lid, uid, ts, ty, content, quota, other in con.execute(
            "SELECT id, user_id, created_at, type, content, quota, other FROM logs WHERE type IN (1,2,3,4,6)"):
        content = content or ""
        if ty == 3:
            m = NEW_RE.match(content)
            if m:
                try:
                    tgt = int(json.loads(other or "{}")["op"]["params"]["target_user_id"])
                except (ValueError, KeyError, TypeError):
                    unparsed[None] += 1
                    continue
                direction = "add" if m.group(1) == "Increased" else "sub"
            else:
                m = OLD_RE.match(content)
                if not m:
                    if DOLLAR_RE.search(content) and uid in users:
                        unparsed[uid] += 1  # 其它带金额的管理日志：不解析，余额闭合会暴露
                    continue
                tgt, direction = int(uid), ("add" if m.group(1) == "增加" else "sub")
            q = round(float(m.group(2)) * Q)
            manage[(tgt, direction, q)].append((int(ts), int(lid)))
            if tgt in users:
                net[tgt] += q if direction == "add" else -q
        elif uid in users:
            if ty == 2:
                net[uid] -= int(quota or 0)
            elif ty == 6:
                net[uid] += int(quota or 0)
            else:  # 1 充值 / 4 系统（签到、注册赠送等）——金额只在 content 的 ＄X
                m = DOLLAR_RE.search(content)
                if m:
                    net[uid] += round(float(m.group(1)) * Q)
    balance = {}
    for uid in users:
        row = con.execute("SELECT quota FROM users WHERE id = ?", (uid,)).fetchone()
        quota = None if row is None else int(row[0])
        balance[uid] = {"quota": quota, "log_net": net[uid],
                        "residual": None if quota is None else quota - net[uid],
                        "unparsed_manage_logs": unparsed[uid]}
        balance[uid]["closed"] = quota is not None and balance[uid]["residual"] == 0 and unparsed[uid] == 0
    con.rollback()
    con.close()
    for k in manage:
        manage[k].sort()
    return manage, balance


def key_of(op):
    return (op["billing_user_id"], "add" if op["operation"] == "refund" else "sub", op["amount"])


def window_of(op):
    start = op["last_attempt_at"] or op["created_at"]
    if op["status"] == "applied":
        end = (op["applied_at"] or start) + APPLIED_SLACK
        return start - WIN_BEFORE if start else end - WIN_AFTER, end
    return start - WIN_BEFORE, start + WIN_AFTER


def claim_applied(ops, manage, exclude):
    """applied 操作逐笔认领最近的 1 条日志；返回 {op_id: log_id}（值集合＝已认领日志）。"""
    claimed = {}
    applied = [o for o in ops if o["status"] == "applied" and o["amount"] > 0 and o["op_id"] not in exclude]
    applied.sort(key=lambda o: o["applied_at"] or o["last_attempt_at"] or 0)
    for op in applied:
        arr = manage.get(key_of(op), [])
        lo, hi = window_of(op)
        i = bisect.bisect_left(arr, (int(lo // 1), -1))
        best = None
        anchor = op["applied_at"] or op["last_attempt_at"]
        while i < len(arr) and arr[i][0] <= hi:
            if arr[i][1] not in claimed and (best is None or abs(arr[i][0] - anchor) < abs(best[0] - anchor)):
                best = arr[i]
            i += 1
        if best:
            claimed[op["op_id"]] = best[1]
    return claimed


def verdict_for(op, manage, claimed_map, balance, targets=(), sibling=None):
    claimed = set(claimed_map.values())
    arr = manage.get(key_of(op), [])
    lo, hi = window_of(op)
    in_win = [l for l in arr if lo // 1 <= l[0] <= hi and l[1] not in claimed]
    # 同用户同方向同额、窗口重叠的其它目标操作会争同一批日志（例：08-28 三笔 45 币 reserve 同秒 unknown，
    # 窗内只有 1 条日志＝至多 1 笔落地，不能三笔都算 yes）——有竞争者且候选不够一人一条 ⇒ 不唯一。
    rivals = [t for t in targets if t is not op and key_of(t) == key_of(op)
              and window_of(t)[0] <= hi and lo <= window_of(t)[1]]
    claimed_in_win = [l for l in arr if lo // 1 <= l[0] <= hi and l[1] in claimed]
    after = [l for l in arr if l[0] > hi and l[1] not in claimed]
    bal = balance[op["billing_user_id"]]
    ev = {"window_utc": [iso(lo), iso(hi)], "unclaimed_logs_in_window": [{"log_id": l[1], "at": iso(l[0])} for l in in_win],
          "claimed_by_applied_in_window": len(claimed_in_win),
          "unclaimed_same_amount_after_window": [{"log_id": l[1], "at": iso(l[0])} for l in after[:5]],
          "rival_targets_same_window": len(rivals),
          "sibling": None if sibling is None else {"op_id": sibling["op_id"], "operation": sibling["operation"],
                                                   "status": sibling["status"], "amount_quota": sibling["amount"],
                                                   "upstream_log": claimed_map.get(sibling["op_id"])},
          "balance": bal, "account_ledger_refund_rows": op["acct_refund"]}
    contested = bool(rivals) and len(in_win) < len(rivals) + 1
    if op["operation"] == "reserve":
        if contested and in_win:
            executed = f"至多 {len(in_win)}/{len(rivals) + 1} 笔（同窗竞争，不能逐笔认定）"
        else:
            executed = "yes" if len(in_win) == 1 else ("no" if not in_win and bal["closed"] else "unclear")
        if sibling is not None and sibling["status"] == "applied" and executed == "no":
            return "manual", (f"reserve：上游执行=no，但同 job refund 已 applied（上游日志 {claimed_map.get(sibling['op_id'])}）"
                              "＝疑似没扣就退（多退），需人工核"), ev
        return "manual", f"reserve：上游执行={executed}；reserve 的 mark_applied 会把 job 改回 queued（重新付费生成），按 INC-0831 人工裁决", ev
    if op["status"] == "applied":
        if len(in_win) + len(claimed_in_win) >= 1:
            return "consistent", "已 applied，上游有对应日志", ev
        return "manual", "已 applied 但上游窗内无日志", ev
    # 扣过才退：同 job 的 reserve 必须 applied 且在上游认领到扣款日志，否则 retry 可能「没扣就退」＝多退。
    debit_ok = (sibling is not None and sibling["operation"] == "reserve" and sibling["status"] == "applied"
                and sibling["amount"] >= op["amount"] and sibling["op_id"] in claimed_map)
    ev["reserve_debit_confirmed"] = debit_ok
    if contested and in_win:
        return "manual", f"同窗另有 {len(rivals)} 笔同额目标操作争 {len(in_win)} 条日志，无法逐笔认定", ev
    if len(in_win) == 1 and not after:
        return "mark_applied", "上游窗内恰 1 条未认领同额加项日志＝退款已到账；只补帐本状态（mark_applied 不写 account_ledger refund 行，需另补）", ev
    if len(in_win) > 1:
        return "manual", "窗内多条未认领同额加项，无法唯一认定", ev
    if in_win and after:
        return "manual", "窗内有 1 条，但窗后另有未认领同额加项（疑似人工补偿），需人看", ev
    if not bal["closed"]:
        return "manual", f"窗内无日志，但该用户余额与日志不闭合（residual={bal['residual']}，未解析管理日志 {bal['unparsed_manage_logs']}），不能推出未执行", ev
    if after:
        return "manual", "窗内无日志，但目标时间后有未认领同额加项（疑似已人工补退），需人看", ev
    if not debit_ok:
        return "manual", "窗内无退款日志，但同 job 的 reserve 扣款未在上游确认（非 applied 或无扣款日志），retry 可能没扣就退", ev
    return "retry", "上游窗内无加项日志且余额与日志完全闭合＝退款未到账；admin action=retry 后 stranded 恰退一次", ev


def main(argv=None):
    ap = argparse.ArgumentParser(description="unknown/failed 计费操作对上游 new-api 只读核对")
    ap.add_argument("--newapi-db", default=DEFAULT_DB)
    ap.add_argument("--psql", default=DEFAULT_PSQL)
    ap.add_argument("--pg-dir")
    ap.add_argument("--op-id", action="append", default=[], help="指定操作 id（可多次；可为 applied，用于反证）")
    ap.add_argument("--include-reserve", action="store_true", help="同时列 reserve unknown（只给证据，建议恒 manual）")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    ops = load_ops(args)
    if args.op_id:
        targets = [o for o in ops if o["op_id"] in args.op_id or any(o["op_id"].startswith(p) for p in args.op_id)]
    else:
        targets = [o for o in ops if (o["operation"] == "refund" and o["status"] in ("unknown", "failed"))
                   or (args.include_reserve and o["operation"] == "reserve" and o["status"] == "unknown")]
    users = {o["billing_user_id"] for o in targets}
    manage, balance = load_newapi(args.newapi_db, users)
    claimed = claim_applied(ops, manage, {o["op_id"] for o in targets})
    by_job = {(o["job_id"], o["operation"]): o for o in ops}
    counts = collections.Counter((o["operation"], o["status"]) for o in ops if o["status"] in ("unknown", "failed", "pending", "executing"))
    out = []
    for op in sorted(targets, key=lambda o: o["last_attempt_at"] or o["created_at"] or 0):
        sib = by_job.get((op["job_id"], "refund" if op["operation"] == "reserve" else "reserve"))
        v, why, ev = verdict_for(op, manage, claimed, balance, targets, sib)
        item = {"op_id": op["op_id"], "job_id": op["job_id"], "operation": op["operation"], "status": op["status"],
                "user": op["billing_user_id"], "amount_quota": op["amount"], "coins": op["amount"] / Q,
                "last_error": (op["last_error"] or "")[:120], "attempted_at": iso(op["last_attempt_at"]),
                "job_status": op["job_status"], "verdict": v, "reason": why, "evidence": ev}
        if v in ("retry", "mark_applied"):
            item["admin_action"] = {"method": "POST", "path": "/api/admin/billing-operations",
                                    "body": {"operationId": op["op_id"], "action": v,
                                             "note": f"H28 上游核对：{why}（{iso(op['last_attempt_at'])}）"}}
        out.append(item)
    summary = {"generated_at": iso(datetime.datetime.now(datetime.timezone.utc).timestamp()),
               "nonfinal_ops": {f"{k[0]}:{k[1]}": v for k, v in sorted(counts.items())},
               "targets": len(out), "verdicts": dict(collections.Counter(i["verdict"] for i in out)),
               "applied_logs_claimed": len(claimed)}
    if args.json:
        json.dump({"summary": summary, "items": out}, sys.stdout, ensure_ascii=False, indent=1)
        print()
        return 0
    print("# 计费 unknown/failed 上游核对（只读）\n")
    print("非终态操作：" + "，".join(f"{k}={v}" for k, v in summary["nonfinal_ops"].items()))
    print(f"目标 {summary['targets']}；建议分布 {summary['verdicts']}；applied 已认领日志 {len(claimed)}\n")
    for i in out:
        b = i["evidence"]["balance"]
        print(f"- op {i['op_id']} job {i['job_id'][:8]} {i['operation']}:{i['status']} 用户 {i['user']} {i['coins']} 币 "
              f"@{i['attempted_at']} job={i['job_status']} err={i['last_error'][:60]!r}")
        print(f"  ⇒ **{i['verdict']}**：{i['reason']}")
        print(f"  窗 {i['evidence']['window_utc']}：未认领 {len(i['evidence']['unclaimed_logs_in_window'])}、"
              f"已被 applied 认领 {i['evidence']['claimed_by_applied_in_window']}、同窗竞争目标 {i['evidence']['rival_targets_same_window']}；窗后未认领同额 "
              f"{len(i['evidence']['unclaimed_same_amount_after_window'])}；同 job 对侧 {(i['evidence']['sibling'] or {}).get('operation')}:"
              f"{(i['evidence']['sibling'] or {}).get('status')} 上游日志 {(i['evidence']['sibling'] or {}).get('upstream_log')}；余额 quota={b['quota']} 日志净额={b['log_net']} "
              f"residual={b['residual']} closed={b['closed']}；account_ledger refund 行 {i['evidence']['account_ledger_refund_rows']}")
        if "admin_action" in i:
            print(f"  拍板后操作：POST /api/admin/billing-operations {json.dumps(i['admin_action']['body'], ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
