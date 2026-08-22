"use client";

// 代理池：adobe2api 出口代理池只读观测面板（10s 自动刷新 + 手动刷新）。
// 数据来自 /api/admin/proxy-pool；非控制面实例或上游不可达时优雅降级为一行说明。

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";

interface ProxySnapshot {
  url: string;
  status: string;
  consecutive_failures: number;
  risk_count: number;
  last_used_at: string | null;
  last_exit_ip: string | null;
  cooldown_until: string | null;
  cooldown_remaining_seconds: number | null;
}

interface PoolData {
  available: boolean;
  reason?: string;
  enabled?: boolean;
  proxies?: ProxySnapshot[];
}

const REASON_TEXT: Record<string, string> = {
  "not-running-on-control-plane": "此实例不运行在 VPS 控制面上，无法直连 adobe2api。请在控制面部署的站点查看代理池状态。",
};

function badgeTone(status: string): string {
  switch (status) {
    case "healthy":
      return "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]";
    case "cooldown":
      return "border-[#f3d9a4] bg-[#fdf6e7] text-[#8a5a0b]";
    case "unhealthy":
      return "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]";
    default:
      return "border-black/10 bg-black/5 text-black/45";
  }
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleTimeString("zh-CN", { hour12: false });
}

function portOf(url: string): string {
  try {
    return new URL(url).port || url;
  } catch {
    return url;
  }
}

export function AdminProxyPool() {
  const [data, setData] = useState<PoolData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/proxy-pool", { cache: "no-store" });
      const result = (await response.json()) as { success?: boolean; data?: PoolData; message?: string };
      if (!response.ok || !result.success || !result.data) throw new Error(result.message || "读取失败。");
      setData(result.data);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => { void load(); }, 10_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  const proxies = data?.proxies ?? [];
  const healthyCount = proxies.filter((p) => p.status === "healthy").length;
  const coolingCount = proxies.filter((p) => p.status === "cooldown").length;

  return (
    <>
      <section className="mb-6 grid border-y border-black/10 bg-white sm:grid-cols-3">
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r"><p className="text-xs text-black/45">代理总数</p><strong className="mt-1 block text-2xl">{proxies.length}</strong></div>
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r"><p className="text-xs text-black/45">可用（healthy）</p><strong className="mt-1 block text-2xl text-[#137a46]">{healthyCount}</strong></div>
        <div className="px-5 py-4"><p className="text-xs text-black/45">冷却中</p><strong className="mt-1 block text-2xl text-[#8a5a0b]">{coolingCount}</strong></div>
      </section>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">代理池</h2>
          <p className="mt-1 text-sm text-black/45">
            adobe2api 出口代理实时状态，每 10 秒自动刷新。
            {refreshedAt !== null && <span className="ml-1 text-black/35">上次更新 {new Date(refreshedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void load(); }}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-black/10 px-3.5 py-2 text-sm font-semibold text-black/60 hover:bg-black/5 disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}刷新
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-[#efc3bf] bg-[#fff2f0] px-3 py-2.5 text-sm text-[#a82d24]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {data && !data.available && (
        <section className="flex min-h-40 flex-col items-center justify-center rounded-md border border-black/10 bg-white px-5 text-center">
          <ShieldAlert className="mb-3 h-8 w-8 text-black/25" />
          <p className="font-medium">代理池状态不可用</p>
          <p className="mt-1 max-w-md text-sm text-black/45">{REASON_TEXT[data.reason ?? ""] ?? `原因：${data.reason ?? "未知"}`}</p>
        </section>
      )}

      {data?.available && (
        <section className="overflow-hidden rounded-md border border-black/10 bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-black/10 px-5 py-3">
            <h3 className="font-semibold">出口代理</h3>
            <span className={`flex items-center gap-1 text-xs ${data.enabled ? "text-[#137a46]" : "text-black/35"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${data.enabled ? "bg-[#20a65a]" : "bg-black/25"}`} />
              {data.enabled ? "代理池已启用" : "代理池已停用（直连出口）"}
            </span>
          </div>
          {proxies.length === 0 ? (
            <p className="px-5 py-6 text-sm text-black/40">代理池中没有代理。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-black/10 text-xs text-black/45">
                    <th className="px-5 py-2.5 font-medium">端口</th>
                    <th className="px-3 py-2.5 font-medium">状态</th>
                    <th className="px-3 py-2.5 font-medium">连续失败</th>
                    <th className="px-3 py-2.5 font-medium">风险计数</th>
                    <th className="px-3 py-2.5 font-medium">剩余冷却</th>
                    <th className="px-3 py-2.5 font-medium">出口 IP</th>
                    <th className="px-5 py-2.5 font-medium">最近使用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/5">
                  {proxies.map((proxy) => (
                    <tr key={proxy.url} className="align-middle">
                      <td className="px-5 py-3 font-mono text-xs font-semibold text-black/70">{portOf(proxy.url)}</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded border px-1.5 py-0.5 text-[11px] font-semibold ${badgeTone(proxy.status)}`}>{proxy.status || "unknown"}</span>
                      </td>
                      <td className={`px-3 py-3 text-xs ${proxy.consecutive_failures > 0 ? "font-semibold text-[#a82d24]" : "text-black/45"}`}>{proxy.consecutive_failures}</td>
                      <td className={`px-3 py-3 text-xs ${proxy.risk_count > 0 ? "font-semibold text-[#8a5a0b]" : "text-black/45"}`}>{proxy.risk_count}</td>
                      <td className="px-3 py-3 text-xs text-black/60">
                        {proxy.cooldown_remaining_seconds !== null && proxy.cooldown_remaining_seconds > 0
                          ? `${Math.ceil(proxy.cooldown_remaining_seconds)}s`
                          : "—"}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-black/60">{proxy.last_exit_ip ?? "—"}</td>
                      <td className="px-5 py-3 text-xs text-black/45">{formatTime(proxy.last_used_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
