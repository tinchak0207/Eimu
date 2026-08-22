"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, Copy, KeyRound, Loader2, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { PublicBizApiKey } from "@/lib/biz-api-keys";
import { cn } from "@/lib/utils";

const BIZ_BASE_URL = "https://eimu.dev/v1";

interface Notice {
  tone: "ok" | "bad";
  text: string;
}

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

/** 顶部高光：Liquid Glass 材质的标准顶边反射线。 */
function Specular() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
  );
}

export function ApiKeysClient() {
  const { user, token, isLoggedIn, isLoading: authLoading } = useAuth();
  const [keys, setKeys] = useState<PublicBizApiKey[]>([]);
  const [limit, setLimit] = useState(3);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  /** 新签发的明文密钥，只在这一次拿得到。 */
  const [issued, setIssued] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const authHeaders = useCallback((): Record<string, string> | null => {
    if (!token || !user) return null;
    return { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) };
  }, [token, user]);

  const load = useCallback(async () => {
    const headers = authHeaders();
    if (!headers) return;
    setLoading(true);
    try {
      const res = await fetch("/api/user/biz-keys", { headers, cache: "no-store" });
      const json = (await res.json()) as {
        success: boolean;
        data?: { keys?: PublicBizApiKey[]; limit?: number };
        message?: string;
      };
      if (!json.success) {
        setNotice({ tone: "bad", text: json.message ?? "读取密钥失败。" });
        return;
      }
      setKeys(json.data?.keys ?? []);
      if (typeof json.data?.limit === "number") setLimit(json.data.limit);
    } catch {
      setNotice({ tone: "bad", text: "网络异常，读取密钥失败。" });
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    if (isLoggedIn) void load();
  }, [isLoggedIn, load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const createKey = async () => {
    const headers = authHeaders();
    if (!headers) return;
    setSaving(true);
    try {
      const res = await fetch("/api/user/biz-keys", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      const json = (await res.json()) as { success: boolean; key?: string; message?: string };
      if (!json.success || !json.key) {
        setNotice({ tone: "bad", text: json.message ?? "签发失败。" });
        return;
      }
      setIssued({ key: json.key, label: label.trim() || "DSH 插件" });
      setCreating(false);
      setLabel("");
      await load();
    } catch {
      setNotice({ tone: "bad", text: "网络异常，签发失败。" });
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (key: PublicBizApiKey) => {
    const headers = authHeaders();
    if (!headers) return;
    if (!window.confirm(`确定吊销「${key.label}」？该密钥会立即失效，且无法恢复。`)) return;
    try {
      const res = await fetch(`/api/user/biz-keys/${key.id}`, { method: "DELETE", headers });
      const json = (await res.json()) as { success: boolean; message?: string };
      if (!json.success) {
        setNotice({ tone: "bad", text: json.message ?? "吊销失败。" });
        return;
      }
      setNotice({ tone: "ok", text: `已吊销「${key.label}」。` });
      await load();
    } catch {
      setNotice({ tone: "bad", text: "网络异常，吊销失败。" });
    }
  };

  const copyKey = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({ tone: "bad", text: "复制失败，请手动选中复制。" });
    }
  };

  const remaining = Math.max(0, limit - keys.length);

  if (!isLoggedIn && !authLoading) {
    return (
      <div className="page-shell min-h-screen pb-28 pt-24">
        <div className="mx-auto w-full max-w-3xl">
          <header className="mb-8">
            <h1 className="text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
              API 密钥
            </h1>
            <p className="mt-2 text-ios-footnote text-[rgba(0,0,0,0.58)] sm:text-ios-body">
              登录后即可创建用于 DSH 插件等第三方工具的密钥
            </p>
          </header>
          <section className="lg-card relative overflow-hidden rounded-ios-3xl p-8 text-center">
            <Specular />
            <KeyRound className="mx-auto h-10 w-10 text-[rgba(0,0,0,0.20)]" aria-hidden="true" />
            <p className="mt-4 text-ios-body font-semibold text-[rgba(0,0,0,0.72)]">请先登录</p>
            <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.52)]">
              登录后才能查看和管理你自己的 API 密钥。
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center rounded-full bg-[#007AFF] px-6 py-3 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD]"
            >
              返回首页登录
            </Link>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell min-h-screen pb-28 pt-24">
      <div className="mx-auto w-full max-w-3xl">
        {/* 页首 — 全站统一的 iOS 大标题版式 */}
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
          <div>
            <h1 className="text-ios-title1 font-bold tracking-tight text-[rgba(0,0,0,0.85)] sm:text-ios-largetitle">
              API 密钥
            </h1>
            <p className="mt-2 text-ios-footnote text-[rgba(0,0,0,0.58)] sm:text-ios-body">
              供 DSH 插件等第三方工具调用 /v1 接口，扣费从你的账户余额扣除
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={remaining <= 0 || loading}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full bg-[#007AFF] px-5 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            创建密钥
          </button>
        </header>

        {notice && (
          <div
            className={cn(
              "mb-5 flex items-start gap-2.5 rounded-ios-xl px-4 py-3 text-ios-footnote",
              notice.tone === "ok" ? "lg-tint-green text-[#1a7a3a]" : "lg-tint-red text-[#b3271c]",
            )}
          >
            {notice.tone === "ok" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            {notice.text}
          </div>
        )}

        <section className="lg-card relative overflow-hidden rounded-ios-3xl">
          <Specular />
          <div className="flex items-center justify-between border-b border-[rgba(0,0,0,0.05)] px-5 py-4 sm:px-7">
            <p className="text-ios-footnote font-medium text-[rgba(0,0,0,0.58)]">
              已创建 {keys.length} / {limit}
            </p>
            <p className="text-ios-footnote text-[rgba(0,0,0,0.44)]">
              {remaining > 0 ? `还可创建 ${remaining} 个` : "已达上限"}
            </p>
          </div>

          {loading ? (
            <div className="flex min-h-48 items-center justify-center text-ios-footnote text-[rgba(0,0,0,0.44)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              读取密钥…
            </div>
          ) : keys.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center px-5 py-12 text-center">
              <KeyRound className="mb-3 h-9 w-9 text-[rgba(0,0,0,0.18)]" aria-hidden="true" />
              <p className="text-ios-body font-semibold text-[rgba(0,0,0,0.68)]">还没有创建任何密钥</p>
              <p className="mt-1.5 max-w-sm text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.50)]">
                创建后把 Base URL 与密钥填进 DSH 插件等工具的设置里即可调用 /v1 接口。
              </p>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mt-6 inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#007AFF] px-5 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD]"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                创建第一个密钥
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-[rgba(0,0,0,0.05)]">
              {keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 sm:px-7">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-ios-body font-semibold text-[rgba(0,0,0,0.78)]">
                        {key.label}
                      </span>
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-ios-caption1 font-semibold",
                          key.enabled ? "lg-tint-green text-[#1a7a3a]" : "bg-[rgba(0,0,0,0.06)] text-[rgba(0,0,0,0.44)]",
                        )}
                      >
                        {key.enabled ? "启用中" : "已停用"}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-ios-footnote text-[rgba(0,0,0,0.50)]">
                      {key.keyPreview}
                    </p>
                    <p className="mt-1 text-ios-caption1 text-[rgba(0,0,0,0.44)]">
                      {formatTime(key.createdAt)} 创建 · {key.totalRequests} 次请求 · {key.totalImages} 张
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => revoke(key)}
                    title="吊销"
                    aria-label={`吊销 ${key.label}`}
                    className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-[rgba(255,59,48,0.10)] hover:text-[#c72a1e] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,59,48,0.35)]"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-5 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.46)]">
          密钥只在此页面显示一次，存储中仅保留哈希，关闭后无法再次查看；遗失只能吊销后重新创建。
          使用方式见 <Link href="/docs" className="text-[#007AFF] hover:underline">接入文档</Link>。
        </p>
      </div>

      {/* 创建对话框 */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="lg-sheet animate-lg-appear relative w-full max-w-md overflow-hidden rounded-ios-3xl p-6">
            <Specular />
            <header className="flex items-center justify-between">
              <h2 className="text-ios-body font-semibold text-[rgba(0,0,0,0.82)]">创建 API 密钥</h2>
              <button
                type="button"
                onClick={() => setCreating(false)}
                aria-label="关闭"
                className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:bg-[rgba(0,0,0,0.06)]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>

            <div className="mt-5">
              <label className="block">
                <span className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)]">密钥名称（可选）</span>
                <input
                  type="text"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={60}
                  placeholder="默认：DSH 插件"
                  className="mt-2 w-full rounded-ios-xl border border-[rgba(0,0,0,0.10)] bg-[rgba(255,255,255,0.72)] px-4 py-3 text-ios-body text-[rgba(0,0,0,0.80)] outline-none transition-colors placeholder:text-[rgba(0,0,0,0.30)] focus:border-[rgba(0,122,255,0.45)] focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]"
                />
              </label>
              <p className="mt-3 rounded-ios-xl bg-[rgba(0,0,0,0.04)] px-4 py-3 text-ios-footnote leading-relaxed text-[rgba(0,0,0,0.52)]">
                密钥绑定当前登录账户计费，额度从你的余额扣除；每分钟限 60 次请求，可用全部模型。
              </p>
            </div>

            <footer className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="cursor-pointer rounded-full px-5 py-2.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.56)] transition-colors hover:bg-[rgba(0,0,0,0.06)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={createKey}
                disabled={saving}
                className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-[#007AFF] px-5 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                创建
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* 明文密钥只显示这一次 */}
      {issued && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="lg-sheet animate-lg-appear relative w-full max-w-lg overflow-hidden rounded-ios-3xl p-6">
            <Specular />
            <header>
              <h2 className="text-ios-body font-semibold text-[rgba(0,0,0,0.82)]">
                密钥「{issued.label}」已创建
              </h2>
            </header>

            <div className="mt-4 flex items-start gap-2.5 rounded-ios-xl px-4 py-3 text-ios-footnote leading-relaxed text-[#8a6410] lg-tint-gold">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              请立即复制并妥善保存。存储中只有哈希，关闭此窗口后无法再取回；遗失只能吊销后重新创建。
            </div>

            <div className="mt-4">
              <span className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)]">API Key</span>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-4 py-3 font-mono text-ios-footnote text-[rgba(0,0,0,0.80)]">
                  {issued.key}
                </code>
                <button
                  type="button"
                  onClick={copyKey}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-[#2d3142] px-4 py-3 text-ios-footnote font-semibold text-white transition-colors hover:bg-[#272b39]"
                >
                  {copied ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
            </div>

            <div className="mt-4">
              <span className="text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)]">Base URL</span>
              <code className="mt-1.5 block truncate rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-4 py-3 font-mono text-ios-footnote text-[rgba(0,0,0,0.80)]">
                {BIZ_BASE_URL}
              </code>
            </div>

            <footer className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setIssued(null);
                  setCopied(false);
                }}
                className="cursor-pointer rounded-full bg-[#007AFF] px-6 py-2.5 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.26)] transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#0066DD]"
              >
                我已保存
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
