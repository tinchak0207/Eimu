"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react";
import type { PublicBizApiKey } from "@/lib/biz-api-keys";
import { AdminAccountAdjustment } from "@/components/admin/AdminAccountAdjustment";

interface Notice {
  tone: "ok" | "bad";
  text: string;
}

interface DraftState {
  label: string;
  userId: string;
  rpm: string;
  allowedModels: string[];
}

const EMPTY_DRAFT: DraftState = { label: "", userId: "", rpm: "60", allowedModels: [] };

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return "从未使用";
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AdminBizKeys() {
  const [keys, setKeys] = useState<PublicBizApiKey[]>([]);
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  /** 新签发的明文密钥。只在这一次拿得到，关掉就再也看不见。 */
  const [issuedKey, setIssuedKey] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  /** 计费账户的实时余额，避免把密钥绑到空账户上。 */
  const [balance, setBalance] = useState<{ username: string; images: number } | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  /** 开专用计费账户的表单。 */
  const [provisioning, setProvisioning] = useState(false);
  const [provisionDraft, setProvisionDraft] = useState({ username: "biz-aggregator", images: "10000" });
  const [provisioningBusy, setProvisioningBusy] = useState(false);

  const checkBalance = useCallback(async (userId: string) => {
    setBalance(null);
    setBalanceError(null);
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return;
    try {
      const res = await fetch(`/api/admin/biz-keys/provision?userId=${id}`, { cache: "no-store" });
      const json = (await res.json()) as {
        success: boolean;
        data?: { username: string; images: number };
        message?: string;
      };
      if (!json.success || !json.data) {
        setBalanceError(json.message ?? "查不到该账户。");
        return;
      }
      setBalance({ username: json.data.username, images: json.data.images });
    } catch {
      setBalanceError("查询余额失败。");
    }
  }, []);

  const provision = async () => {
    setProvisioningBusy(true);
    try {
      const res = await fetch("/api/admin/biz-keys/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: provisionDraft.username,
          images: Number(provisionDraft.images),
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        created?: boolean;
        data?: { id: number; username: string; images: number };
        message?: string;
      };
      if (!json.success || !json.data) {
        setNotice({ tone: "bad", text: json.message ?? "创建账户失败。" });
        return;
      }
      // 直接把 id 填进签发表单，省掉手抄一遍。
      setDraft((current) => ({ ...current, userId: String(json.data!.id) }));
      setBalance({ username: json.data.username, images: json.data.images });
      setBalanceError(null);
      setProvisioning(false);
      setNotice({
        tone: "ok",
        text: `${json.created ? "已创建" : "已复用"}账户 ${json.data.username}（id ${json.data.id}），额度 ${json.data.images} 张。`,
      });
    } catch {
      setNotice({ tone: "bad", text: "网络异常，创建账户失败。" });
    } finally {
      setProvisioningBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/biz-keys", { cache: "no-store" });
      const json = (await res.json()) as {
        success: boolean;
        data?: PublicBizApiKey[];
        supportedModels?: string[];
        message?: string;
      };
      if (!json.success) {
        setNotice({ tone: "bad", text: json.message ?? "读取密钥失败。" });
        return;
      }
      setKeys(json.data ?? []);
      setSupportedModels(json.supportedModels ?? []);
    } catch {
      setNotice({ tone: "bad", text: "网络异常，读取密钥失败。" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/biz-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: draft.label,
          userId: Number(draft.userId),
          rpm: Number(draft.rpm),
          allowedModels: draft.allowedModels,
        }),
      });
      const json = (await res.json()) as { success: boolean; key?: string; message?: string };
      if (!json.success || !json.key) {
        setNotice({ tone: "bad", text: json.message ?? "签发失败。" });
        return;
      }
      setIssuedKey({ key: json.key, label: draft.label });
      setCreating(false);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch {
      setNotice({ tone: "bad", text: "网络异常，签发失败。" });
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (key: PublicBizApiKey) => {
    try {
      const res = await fetch(`/api/admin/biz-keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !key.enabled }),
      });
      const json = (await res.json()) as { success: boolean; message?: string };
      if (!json.success) {
        setNotice({ tone: "bad", text: json.message ?? "操作失败。" });
        return;
      }
      setNotice({ tone: "ok", text: key.enabled ? `已停用 ${key.label}。` : `已启用 ${key.label}。` });
      await load();
    } catch {
      setNotice({ tone: "bad", text: "网络异常，操作失败。" });
    }
  };

  const revoke = async (key: PublicBizApiKey) => {
    // 吊销不可逆，而且会立刻切断客户的线上调用，必须二次确认。
    if (!window.confirm(`确定吊销「${key.label}」的密钥？该客户的调用会立即中断，且无法恢复。`)) return;
    try {
      const res = await fetch(`/api/admin/biz-keys/${key.id}`, { method: "DELETE" });
      const json = (await res.json()) as { success: boolean; message?: string };
      if (!json.success) {
        setNotice({ tone: "bad", text: json.message ?? "吊销失败。" });
        return;
      }
      setNotice({ tone: "ok", text: `已吊销 ${key.label}。` });
      await load();
    } catch {
      setNotice({ tone: "bad", text: "网络异常，吊销失败。" });
    }
  };

  const copyKey = async () => {
    if (!issuedKey) return;
    try {
      await navigator.clipboard.writeText(issuedKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({ tone: "bad", text: "复制失败，请手动选中复制。" });
    }
  };

  const activeCount = keys.filter((key) => key.enabled).length;
  const totalImages = keys.reduce((sum, key) => sum + key.totalImages, 0);

  return (
    <>
      <section className="mb-6 grid border-y border-black/10 bg-white sm:grid-cols-3">
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r">
          <p className="text-xs text-black/45">已签发</p>
          <strong className="mt-1 block text-2xl">{keys.length}</strong>
        </div>
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r">
          <p className="text-xs text-black/45">启用中</p>
          <strong className="mt-1 block text-2xl text-[#137a46]">{activeCount}</strong>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs text-black/45">累计出图</p>
          <strong className="mt-1 block text-2xl">{totalImages}</strong>
        </div>
      </section>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">B 端密钥</h2>
          <p className="mt-1 text-sm text-black/45">
            供 API 聚合平台调用。Base URL 为 <code className="rounded bg-black/5 px-1">https://eimu.dev/v1</code>
            ，计费从绑定的用户账户扣除。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7]"
        >
          <Plus className="h-4 w-4" />
          签发密钥
        </button>
      </div>

      {notice && (
        <div
          className={`mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${
            notice.tone === "ok"
              ? "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]"
              : "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]"
          }`}
        >
          {notice.tone === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {notice.text}
        </div>
      )}

      <section className="overflow-hidden rounded-md border border-black/10 bg-white">
        {loading ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-black/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            读取密钥
          </div>
        ) : keys.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
            <KeyRound className="mb-3 h-8 w-8 text-black/20" />
            <p className="text-sm font-semibold text-black/60">还没有签发任何 B 端密钥</p>
            <p className="mt-1 text-sm text-black/40">签发后把 Base URL 与密钥填进聚合平台后台即可开卖。</p>
          </div>
        ) : (
          <div className="divide-y divide-black/[0.07]">
            {keys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <strong className="truncate text-sm">{key.label}</strong>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                        key.enabled ? "bg-[#eef9f2] text-[#12643b]" : "bg-black/5 text-black/40"
                      }`}
                    >
                      {key.enabled ? "启用" : "停用"}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-black/45">{key.keyPreview}</p>
                  <p className="mt-0.5 truncate text-xs text-black/40">
                    计费用户 {key.userId} · {key.rpm} 次/分 ·{" "}
                    {key.allowedModels.length ? key.allowedModels.join("、") : "全部模型"}
                  </p>
                </div>

                <div className="shrink-0 text-right text-xs text-black/45">
                  <p>
                    {key.totalRequests} 次请求 · {key.totalImages} 张
                  </p>
                  <p className="mt-0.5">{formatTime(key.lastUsedAt)}</p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleEnabled(key)}
                    title={key.enabled ? "停用" : "启用"}
                    aria-label={key.enabled ? "停用" : "启用"}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-black/10 text-black/55 hover:bg-black/5 hover:text-black"
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => revoke(key)}
                    title="吊销"
                    aria-label="吊销"
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-black/10 text-[#a82d24] hover:bg-[#fff2f0]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <AdminAccountAdjustment />

      {/* 签发表单 */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-md border border-black/10 bg-white shadow-xl">
            <header className="flex items-center justify-between border-b border-black/10 px-5 py-3.5">
              <h3 className="text-sm font-semibold">签发 B 端密钥</h3>
              <button
                type="button"
                onClick={() => setCreating(false)}
                aria-label="关闭"
                className="flex h-8 w-8 items-center justify-center rounded-md text-black/45 hover:bg-black/5"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="space-y-4 px-5 py-4">
              <label className="block">
                <span className="text-xs font-semibold text-black/55">客户名称</span>
                <input
                  type="text"
                  value={draft.label}
                  onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
                  placeholder="例如：某某聚合平台"
                  className="mt-1 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/20"
                />
              </label>

              <div>
                <div className="flex items-end justify-between gap-2">
                  <span className="text-xs font-semibold text-black/55">计费用户 id</span>
                  <button
                    type="button"
                    onClick={() => setProvisioning(true)}
                    className="text-xs font-semibold text-[#2878d0] hover:underline"
                  >
                    新建专用账户
                  </button>
                </div>
                <input
                  type="number"
                  min={1}
                  value={draft.userId}
                  onChange={(event) => setDraft((current) => ({ ...current, userId: event.target.value }))}
                  onBlur={() => checkBalance(draft.userId)}
                  placeholder="上游 New API 的用户 id"
                  className="mt-1 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/20"
                />
                {/* 绑到空账户上，第一次调用就是 402，聚合平台会以为密钥是坏的 —— 先把余额显示出来。 */}
                {balance ? (
                  <span
                    className={`mt-1 block text-xs ${
                      balance.images > 0 ? "text-[#12643b]" : "text-[#a82d24]"
                    }`}
                  >
                    {balance.username}：余额 {balance.images} 张
                    {balance.images === 0 && "（为 0，绑上去第一次调用就会返回 402，请先充值）"}
                  </span>
                ) : (
                  <span className="mt-1 block text-xs text-black/40">
                    消耗从该账户余额扣除。填完会自动查一次余额。
                  </span>
                )}
                {balanceError && <span className="mt-1 block text-xs text-[#a82d24]">{balanceError}</span>}
              </div>

              <label className="block">
                <span className="text-xs font-semibold text-black/55">每分钟请求上限</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={draft.rpm}
                  onChange={(event) => setDraft((current) => ({ ...current, rpm: event.target.value }))}
                  className="mt-1 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/20"
                />
              </label>

              <div>
                <span className="text-xs font-semibold text-black/55">允许的模型</span>
                <p className="mt-0.5 text-xs text-black/40">全不选表示不限。</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {supportedModels.map((model) => {
                    const selected = draft.allowedModels.includes(model);
                    return (
                      <button
                        key={model}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            allowedModels: selected
                              ? current.allowedModels.filter((item) => item !== model)
                              : [...current.allowedModels, model],
                          }))
                        }
                        className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${
                          selected ? "bg-[#20242c] text-white" : "border border-black/10 text-black/55 hover:bg-black/5"
                        }`}
                      >
                        {model}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <footer className="flex justify-end gap-2 border-t border-black/10 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md border border-black/10 px-3.5 py-2 text-sm font-semibold text-black/55 hover:bg-black/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={saving || !draft.label.trim() || !draft.userId}
                className="inline-flex items-center gap-2 rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-40"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                签发
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* 明文密钥只显示这一次 */}
      {issuedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-md border border-black/10 bg-white shadow-xl">
            <header className="border-b border-black/10 px-5 py-3.5">
              <h3 className="text-sm font-semibold">「{issuedKey.label}」的密钥已签发</h3>
            </header>

            <div className="space-y-3 px-5 py-4">
              <div className="flex items-start gap-2 rounded-md border border-[#f0d9a8] bg-[#fdf7e8] px-3 py-2.5 text-sm text-[#7a5a12]">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                请立刻复制并交给客户。存储里只有哈希，关闭后无法再取回；丢了只能吊销重发。
              </div>

              <div>
                <span className="text-xs font-semibold text-black/55">API Key</span>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-black/5 px-3 py-2 font-mono text-xs">
                    {issuedKey.key}
                  </code>
                  <button
                    type="button"
                    onClick={copyKey}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[#20242c] px-3 py-2 text-xs font-semibold text-white hover:bg-black"
                  >
                    {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
              </div>

              <div>
                <span className="text-xs font-semibold text-black/55">Base URL</span>
                <code className="mt-1 block truncate rounded-md bg-black/5 px-3 py-2 font-mono text-xs">
                  https://eimu.dev/v1
                </code>
              </div>
            </div>

            <footer className="flex justify-end border-t border-black/10 px-5 py-3.5">
              <button
                type="button"
                onClick={() => {
                  setIssuedKey(null);
                  setCopied(false);
                }}
                className="rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7]"
              >
                我已保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* 开专用计费账户 */}
      {provisioning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-md border border-black/10 bg-white shadow-xl">
            <header className="flex items-center justify-between border-b border-black/10 px-5 py-3.5">
              <h3 className="text-sm font-semibold">新建专用 B 端计费账户</h3>
              <button
                type="button"
                onClick={() => setProvisioning(false)}
                aria-label="关闭"
                className="flex h-8 w-8 items-center justify-center rounded-md text-black/45 hover:bg-black/5"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="space-y-4 px-5 py-4">
              <p className="rounded-md bg-black/[0.03] px-3 py-2.5 text-xs text-black/55">
                在上游 New API 里开一个只用于 B 端计费的账户，并设定初始额度。
                同名账户已存在时会复用它，只把额度调到目标值。
                该账户不需要人工登录，密码随机生成且不保存。
              </p>

              <label className="block">
                <span className="text-xs font-semibold text-black/55">账户用户名</span>
                <input
                  type="text"
                  value={provisionDraft.username}
                  onChange={(event) =>
                    setProvisionDraft((current) => ({ ...current, username: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/20"
                />
                <span className="mt-1 block text-xs text-black/40">
                  3–20 位，小写字母、数字、下划线或短横线（上游限制 20）。
                </span>
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-black/55">初始额度（张）</span>
                <input
                  type="number"
                  min={0}
                  value={provisionDraft.images}
                  onChange={(event) =>
                    setProvisionDraft((current) => ({ ...current, images: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/20"
                />
                <span className="mt-1 block text-xs text-black/40">
                  1 张 = 500000 配额单位。自建网关，直接由管理接口加额度，不走支付。
                </span>
              </label>
            </div>

            <footer className="flex justify-end gap-2 border-t border-black/10 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setProvisioning(false)}
                className="rounded-md border border-black/10 px-3.5 py-2 text-sm font-semibold text-black/55 hover:bg-black/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={provision}
                disabled={provisioningBusy || !provisionDraft.username.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-40"
              >
                {provisioningBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                创建并充值
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
