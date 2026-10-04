"use client";

// /admin「路由调度」→「模型路由」：控面调度器的真实尝试顺序（2026-10-01 路由收口）。
// 资料＝/api/admin/model-routes（控面，与 acquireSupplierLease 同一份 resolveModelRoute）。
// 调序／增删渠道＝写热覆写，立即生效不需部署；「恢复默认」＝回到 model-routes.config.ts。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, Loader2, Plus, RefreshCw, RotateCcw, Save, X } from "lucide-react";

type StepState = "ok" | "degraded" | "cooldown" | "disabled" | "no_capability" | "missing";

interface RouteStep {
  label: string;
  supplierId: string;
  state: StepState;
}

interface ModelRoute {
  modelId: string;
  modelName: string;
  kind: string;
  source: "config" | "override";
  labels: string[];
  configLabels: string[];
  override: { note: string | null; updatedBy: string | null; updatedAt: string } | null;
  steps: RouteStep[];
}

interface ChannelOption {
  label: string;
  enabled: boolean;
  healthStatus: string;
  adapterType: string;
}

interface Payload {
  routes: ModelRoute[];
  channels: ChannelOption[];
}

const STATE_META: Record<StepState, { text: string; className: string }> = {
  ok: { text: "可用", className: "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]" },
  degraded: { text: "降级", className: "border-[#d99024]/40 bg-[#d99024]/10 text-[#d99024]" },
  cooldown: { text: "冷却中", className: "border-[#d99024]/40 bg-[#d99024]/10 text-[#d99024]" },
  disabled: { text: "已停用", className: "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]" },
  no_capability: { text: "未认领该模型", className: "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]" },
  missing: { text: "渠道不存在", className: "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]" },
};

const KIND_ORDER = ["image", "video", "audio", "unknown"];
const KIND_LABELS: Record<string, string> = { image: "图片", video: "视频", audio: "语音", unknown: "其他" };

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return fallback;
}

function sameRoute(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function AdminModelRoutesPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/model-routes", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { data?: Payload } | null;
      if (!response.ok || !body?.data) throw new Error(errorMessage(body, "读取模型路由失败。"));
      setData(body.data);
      setDrafts({});
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取模型路由失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ModelRoute[]>();
    for (const route of data?.routes ?? []) {
      const list = groups.get(route.kind) ?? [];
      list.push(route);
      groups.set(route.kind, list);
    }
    return [...groups.entries()].sort(([a], [b]) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  }, [data]);

  const draftOf = (route: ModelRoute) => drafts[route.modelId] ?? route.labels;
  const setDraft = (modelId: string, labels: string[]) => setDrafts((current) => ({ ...current, [modelId]: labels }));

  const move = (route: ModelRoute, index: number, delta: number) => {
    const labels = [...draftOf(route)];
    const target = index + delta;
    if (target < 0 || target >= labels.length) return;
    [labels[index], labels[target]] = [labels[target], labels[index]];
    setDraft(route.modelId, labels);
  };

  const mutate = async (route: ModelRoute, method: "PUT" | "DELETE") => {
    setBusyModel(route.modelId);
    try {
      const response = method === "PUT"
        ? await fetch("/api/admin/model-routes", {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelId: route.modelId, route: draftOf(route) }),
          })
        : await fetch(`/api/admin/model-routes?modelId=${encodeURIComponent(route.modelId)}`, { method });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) throw new Error(errorMessage(body, "保存失败。"));
      await load();
    } catch (mutateError) {
      setError(mutateError instanceof Error ? mutateError.message : "保存失败。");
    } finally {
      setBusyModel(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-md border border-black/10 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-black/10 px-5 py-4">
        <div>
          <h3 className="font-semibold">模型路由（真实调度顺序）</h3>
          <p className="mt-1 text-xs text-black/40">
            从左到右依次尝试。改动立即生效、无需部署；「恢复默认」回到 model-routes.config.ts。
            newapi 一步内部的渠道顺序在 new-api 后台调整。
          </p>
        </div>
        <button type="button" onClick={() => void load()} title="刷新" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/50 hover:bg-black/5">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-black/10 bg-[#fff2f0] px-5 py-2.5 text-sm text-[#a82d24]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {!data ? (
        <div className="flex min-h-32 items-center justify-center text-sm text-black/45">
          {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />读取模型路由</> : "读取失败"}
        </div>
      ) : (
        <div className="divide-y divide-black/10">
          {grouped.map(([kind, routes]) => (
            <div key={kind} className="px-5 py-4">
              <p className="mb-2 text-xs font-semibold text-black/45">{KIND_LABELS[kind] ?? kind}</p>
              <div className="space-y-2">
                {routes.map((route) => {
                  const draft = draftOf(route);
                  const dirty = !sameRoute(draft, route.labels);
                  const stepByLabel = new Map(route.steps.map((step) => [step.label, step]));
                  const addable = data.channels.filter((channel) => channel.enabled && !draft.includes(channel.label));
                  const busy = busyModel === route.modelId;
                  return (
                    <article key={route.modelId} className="grid gap-2 rounded-md border border-black/10 bg-[#f7f8f9] px-3 py-2.5 lg:grid-cols-[14rem_minmax(0,1fr)_auto] lg:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{route.modelName}</p>
                        <p className="truncate font-mono text-[11px] text-black/40">
                          {route.modelId}
                          {route.source === "override" && <span className="ml-1.5 font-sans font-semibold text-[#2878d0]">已覆写</span>}
                        </p>
                      </div>
                      <ol className="flex flex-wrap items-center gap-1.5">
                        {draft.length === 0 && <li className="text-xs text-[#a82d24]">无路由——该模型不可调度</li>}
                        {draft.map((label, index) => {
                          const meta = STATE_META[stepByLabel.get(label)?.state ?? "missing"];
                          const pending = !stepByLabel.has(label);
                          return (
                            <li key={label} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${pending ? "border-[#2878d0]/30 bg-[#2878d0]/10 text-[#2878d0]" : meta.className}`}>
                              <span className="text-black/35">{index + 1}</span>
                              <span className="font-mono font-semibold" title={label === "newapi" ? "内部顺序在 new-api 后台调整" : undefined}>{label}</span>
                              {!pending && meta.text !== "可用" && <span>· {meta.text}</span>}
                              <button type="button" onClick={() => move(route, index, -1)} disabled={index === 0} aria-label={`${label} 上移`} className="disabled:opacity-25"><ArrowUp className="h-3 w-3" /></button>
                              <button type="button" onClick={() => move(route, index, 1)} disabled={index === draft.length - 1} aria-label={`${label} 下移`} className="disabled:opacity-25"><ArrowDown className="h-3 w-3" /></button>
                              <button type="button" onClick={() => setDraft(route.modelId, draft.filter((item) => item !== label))} aria-label={`移除 ${label}`}><X className="h-3 w-3" /></button>
                            </li>
                          );
                        })}
                        {addable.length > 0 && (
                          <li className="inline-flex items-center gap-1 text-[11px] text-black/45">
                            <Plus className="h-3 w-3" />
                            <select
                              value=""
                              onChange={(event) => event.target.value && setDraft(route.modelId, [...draft, event.target.value])}
                              aria-label={`为 ${route.modelId} 添加渠道`}
                              className="rounded border border-black/10 bg-white px-1 py-0.5 font-mono text-[11px]"
                            >
                              <option value="">添加渠道</option>
                              {addable.map((channel) => <option key={channel.label} value={channel.label}>{channel.label}</option>)}
                            </select>
                          </li>
                        )}
                      </ol>
                      <div className="flex items-center gap-2 lg:justify-end">
                        {dirty && (
                          <button type="button" onClick={() => setDraft(route.modelId, route.labels)} className="text-xs text-black/45 underline hover:text-black">撤销</button>
                        )}
                        {route.source === "override" && !dirty && (
                          <button type="button" onClick={() => void mutate(route, "DELETE")} disabled={busy} title={`默认：${route.configLabels.join(" > ") || "无"}`} className="inline-flex items-center gap-1 text-xs text-black/55 hover:text-black disabled:opacity-40">
                            <RotateCcw className="h-3.5 w-3.5" />恢复默认
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void mutate(route, "PUT")}
                          disabled={!dirty || busy}
                          className="inline-flex items-center gap-1.5 rounded-md bg-[#2878d0] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-30"
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
