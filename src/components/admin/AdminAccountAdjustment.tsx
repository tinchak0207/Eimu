"use client";

// 管理员调额表单：POST /api/admin/account-adjustments（上游 quota + account_ledger 两层一起写）。
// Idempotency-Key 每次提交生成一次；同一份表单在「网络异常/failed/结果不明」后重按提交会沿用
// 同一个键（服务端据此不双算），改了任一字段或拿到明确结果后才换新键。

import { useState } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";

interface AdjustmentResponse {
  success: boolean;
  status?: "applied" | "already_applied" | "in_flight" | "failed" | "conflict";
  userId?: number;
  coins?: number;
  balance_coins?: number;
  ledger_posted?: boolean;
  reason?: string;
  message?: string;
}

const INPUT_CLASS =
  "mt-1 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/20";

function newIdempotencyKey(): string {
  return `admin-ui-${crypto.randomUUID()}`;
}

export function AdminAccountAdjustment() {
  const [form, setForm] = useState({ userId: "", coins: "", note: "" });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const update = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setPendingKey(null);
  };

  const submit = async () => {
    const key = pendingKey ?? newIdempotencyKey();
    setPendingKey(key);
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/account-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ userId: Number(form.userId), coins: Number(form.coins), note: form.note }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as AdjustmentResponse;
      if (json.status === "applied" || json.status === "already_applied") {
        setPendingKey(null);
        const balance = typeof json.balance_coins === "number" ? `，当前余额 ${json.balance_coins} 币` : "";
        const ledger = json.ledger_posted === false ? "（帐本行未落地，待对帐）" : "";
        setNotice({
          tone: "ok",
          text: `${json.status === "applied" ? "已调额" : "该笔此前已生效"}：user ${json.userId} ${json.coins} 币${balance}${ledger}`,
        });
        setForm((current) => ({ ...current, coins: "", note: "" }));
        return;
      }
      if (json.status === "conflict") setPendingKey(null);
      setNotice({ tone: "bad", text: json.reason ?? json.message ?? `调额失败（HTTP ${res.status}）` });
    } catch {
      setNotice({ tone: "bad", text: "网络异常，结果未知；直接再按提交会沿用同一个幂等键，不会重复加额。" });
    } finally {
      setBusy(false);
    }
  };

  const coins = Number(form.coins);
  const valid =
    Number.isInteger(Number(form.userId)) &&
    Number(form.userId) > 0 &&
    Number.isFinite(coins) &&
    coins !== 0 &&
    form.note.trim().length > 0;

  return (
    <section className="mt-6 rounded-md border border-black/10 bg-white">
      <header className="border-b border-black/10 px-5 py-3.5">
        <h3 className="text-sm font-semibold">账户调额</h3>
        <p className="mt-0.5 text-xs text-black/45">
          同时写上游额度与站内帐本，客户余额立即可见。负数为扣减；1 币 = 500000 配额单位。
        </p>
      </header>
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-[8rem_8rem_1fr]">
        <label className="block">
          <span className="text-xs font-semibold text-black/55">用户 id</span>
          <input type="number" min={1} value={form.userId} onChange={(e) => update("userId", e.target.value)} className={INPUT_CLASS} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-black/55">币数（可负）</span>
          <input type="number" value={form.coins} onChange={(e) => update("coins", e.target.value)} className={INPUT_CLASS} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-black/55">备注（必填）</span>
          <input type="text" maxLength={500} value={form.note} onChange={(e) => update("note", e.target.value)} className={INPUT_CLASS} />
        </label>
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-black/10 px-5 py-3.5">
        {notice && (
          <p className={`mr-auto flex items-start gap-2 text-sm ${notice.tone === "ok" ? "text-[#12643b]" : "text-[#a82d24]"}`}>
            {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
            {notice.text}
          </p>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !valid}
          className="inline-flex items-center gap-2 rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-40"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          提交调额
        </button>
      </footer>
    </section>
  );
}
