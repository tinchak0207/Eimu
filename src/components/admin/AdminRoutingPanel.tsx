"use client";

// /admin 第四分頁「路由调度」：環境真相 → 渠道總表（可啟停/調序）→ 每模型隊列
// 靜態預覽 → 真實路由事件。資料全部來自 /api/admin/channels 與
// /api/admin/routing-events；本組件只搬運 host 與開關，絕不接觸任何密鑰。

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import type { ChannelDescriptor } from "@/lib/channel-registry";
import type { ChannelOverride, ChannelOverrides } from "@/lib/channel-overrides";
import type { ChannelAggregate, RoutingEvent, RoutingOutcome } from "@/lib/routing-telemetry";
import { modelBaseName } from "@/lib/provider-config";

interface QueuePreviewEntry {
  label: string;
  host: string;
  priority?: number;
}

interface ChannelsPayload {
  channels: ChannelDescriptor[];
  queues: Record<string, QueuePreviewEntry[]>;
  overrides: ChannelOverrides;
  overridesVersion: string | null;
  storage: "blob" | "memory";
  envPresence: Record<string, boolean>;
  sub2apiEnabledState: "true" | "set-but-not-true" | "missing";
  dangerFlags: { mockMode: boolean; localTestMode: boolean };
  propagationNote: string;
}

interface EventsPayload {
  events: RoutingEvent[];
  aggregates: ChannelAggregate[];
  sampleNote: string;
}

/** 同時容忍裸 payload 與 { success, data } 包裝——以 marker 欄位辨識形狀。 */
function unwrap<T>(body: unknown, marker: string): T | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const candidate =
    record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  return marker in candidate ? (candidate as unknown as T) : null;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return fallback;
}

const KIND_LABELS: Record<ChannelDescriptor["kind"], string> = { env: "env", pool: "池" };

const OUTCOME_META: Record<RoutingOutcome, { text: string; tone: PillTone }> = {
  delivered: { text: "已出图", tone: "green" },
  exhausted: { text: "全部失败", tone: "red" },
  cancelled: { text: "已取消", tone: "gray" },
  "budget-exhausted": { text: "预算耗尽", tone: "orange" },
  "no-endpoints": { text: "无可用渠道", tone: "red" },
};

type PillTone = "green" | "red" | "gray" | "orange" | "blue";

const PILL_CLASSES: Record<PillTone, string> = {
  green: "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]",
  red: "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]",
  gray: "border-black/10 bg-black/5 text-black/50",
  orange: "border-[#d99024]/40 bg-[#d99024]/10 text-[#d99024]",
  blue: "border-[#2878d0]/30 bg-[#2878d0]/10 text-[#2878d0]",
};

function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${PILL_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

function envGroupName(name: string): string {
  if (name.startsWith("SUB2API")) return "sub2api";
  if (name.startsWith("FIREFLY") || name.startsWith("ADOBE")) return "firefly";
  if (name.includes("FALLBACK")) return "fallback";
  if (name.startsWith("IMAGE_API") || name.startsWith("GATEWAY")) return "primary / gateway";
  if (name.startsWith("BLOB")) return "blob 存储";
  return "其他";
}

const ENV_GROUP_ORDER = ["sub2api", "primary / gateway", "fallback", "firefly", "blob 存储", "其他"];

function groupEnvPresence(presence: Record<string, boolean>): Array<[string, Array<[string, boolean]>]> {
  const groups = new Map<string, Array<[string, boolean]>>();
  for (const [name, present] of Object.entries(presence)) {
    const group = envGroupName(name);
    const list = groups.get(group) ?? [];
    list.push([name, present]);
    groups.set(group, list);
  }
  return ENV_GROUP_ORDER.filter((group) => groups.has(group)).map((group) => [group, groups.get(group)!]);
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

export function AdminRoutingPanel({ onOpenRelays }: { onOpenRelays?: () => void }) {
  const [data, setData] = useState<ChannelsPayload | null>(null);
  const [draft, setDraft] = useState<ChannelOverrides>({});
  const [telemetry, setTelemetry] = useState<EventsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const applyChannels = useCallback((payload: ChannelsPayload) => {
    setData(payload);
    setDraft({ ...payload.overrides });
  }, []);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/channels", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as unknown;
      const payload = unwrap<ChannelsPayload>(body, "channels");
      if (!response.ok || !payload) throw new Error(errorMessage(body, "读取渠道配置失败。"));
      applyChannels(payload);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "读取渠道配置失败。" });
    } finally {
      setLoading(false);
    }
  }, [applyChannels]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const response = await fetch("/api/admin/routing-events?limit=50", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as unknown;
      const payload = unwrap<EventsPayload>(body, "events");
      if (!response.ok || !payload) throw new Error(errorMessage(body, "读取路由事件失败。"));
      setTelemetry(payload);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "读取路由事件失败。" });
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadChannels();
    void loadEvents();
  }, [loadChannels, loadEvents]);

  const updateDraft = (id: string, patch: ChannelOverride) => {
    setDraft((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };

  const clearOverride = (id: string) => {
    setDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
  };

  const setPriority = (channel: ChannelDescriptor, raw: string) => {
    if (raw === "") {
      // 清空輸入＝回到基準優先級（移除 priority 覆寫）。兩欄皆空的殼條目一併刪除，
      // 否則 {} 殘殼會讓 dirty 比對誤報「有未保存修改」。
      setDraft((current) => {
        const entry = { ...current[channel.id] };
        delete entry.priority;
        if (entry.enabled === undefined) {
          return Object.fromEntries(Object.entries(current).filter(([key]) => key !== channel.id));
        }
        return { ...current, [channel.id]: entry };
      });
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 99) return;
    updateDraft(channel.id, { priority: value });
  };

  const draftFor = (channel: ChannelDescriptor): ChannelOverride => draft[channel.id] ?? {};
  const effectiveEnabled = (channel: ChannelDescriptor): boolean =>
    channel.kind === "pool" ? channel.enabled : draftFor(channel).enabled ?? channel.defaultEnabled;
  const effectivePriority = (channel: ChannelDescriptor): number =>
    channel.kind === "pool" ? channel.priority : draftFor(channel).priority ?? channel.basePriority;
  const isOverridden = (channel: ChannelDescriptor): boolean => {
    if (channel.kind === "pool") return false;
    const entry = draftFor(channel);
    return entry.enabled !== undefined || entry.priority !== undefined;
  };

  const dirty = data !== null && JSON.stringify(draft) !== JSON.stringify(data.overrides);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // expectedVersion：樂觀併發控制；版本不符時服務端回 409 並附最新配置。
        body: JSON.stringify({ overrides: draft, expectedVersion: data.overridesVersion }),
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 409) {
        const latest = unwrap<ChannelsPayload>(body, "channels");
        if (latest) applyChannels(latest);
        else await loadChannels();
        setNotice({ tone: "error", text: "配置已被其他会话修改，已刷新。请确认最新状态后重新保存。" });
        return;
      }
      if (!response.ok) throw new Error(errorMessage(body, "保存失败。"));
      setNotice({ tone: "ok", text: "渠道配置已保存。" });
      await loadChannels();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败。" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">路由调度</h2>
        <p className="mt-1 text-sm text-black/45">环境真相、渠道开关与真实路由事件——与生产队列同一来源。</p>
      </div>

      {notice && (
        <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${notice.tone === "ok" ? "border-[#b7dfc8] bg-[#eef9f2] text-[#12643b]" : "border-[#efc3bf] bg-[#fff2f0] text-[#a82d24]"}`}>
          {notice.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          {notice.text}
        </div>
      )}

      {loading && !data ? (
        <div className="flex min-h-48 items-center justify-center rounded-md border border-black/10 bg-white text-sm text-black/45">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />读取路由配置
        </div>
      ) : !data ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-md border border-black/10 bg-white px-5 text-sm text-black/45">
          读取渠道配置失败
          <button type="button" onClick={() => void loadChannels()} className="rounded-md border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">
            重试
          </button>
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-md border border-black/10 bg-white">
            <div className="border-b border-black/10 px-5 py-4">
              <h3 className="font-semibold">环境真相</h3>
              <p className="mt-1 text-xs text-black/40">部署环境变量的实际状态——渠道行为的最终来源。</p>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-black/55">SUB2API_ENABLED</span>
                {data.sub2apiEnabledState === "true" && <Pill tone="green">已启用</Pill>}
                {data.sub2apiEnabledState === "set-but-not-true" && (
                  <Pill tone="red">已设置但值不是 true——sub2api 被静默跳过</Pill>
                )}
                {data.sub2apiEnabledState === "missing" && <Pill tone="gray">未设置</Pill>}
              </div>

              {data.dangerFlags.mockMode && (
                <div className="flex items-start gap-2 rounded-md border border-[#efc3bf] bg-[#fff2f0] px-3 py-2.5 text-sm font-semibold text-[#a82d24]">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  ENABLE_MOCK_MODE 开启中：生产当前返回假图，不走任何渠道。
                </div>
              )}
              {data.dangerFlags.localTestMode && (
                <div className="flex items-start gap-2 rounded-md border border-[#d99024]/40 bg-[#d99024]/10 px-3 py-2.5 text-sm text-[#d99024]">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  NEXT_PUBLIC_LOCAL_TEST_MODE 开启中：登录鉴权被绕过，仅限本地调试。
                </div>
              )}
              {data.storage === "memory" && (
                <div className="flex items-start gap-2 rounded-md border border-[#d99024]/40 bg-[#d99024]/10 px-3 py-2.5 text-sm text-[#d99024]">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  Blob 未配置：开关仅本实例内存暂存，重启即失。
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {groupEnvPresence(data.envPresence).map(([group, vars]) => (
                  <div key={group} className="rounded-md border border-black/10 bg-[#f7f8f9] px-3 py-2.5">
                    <p className="text-xs font-semibold text-black/55">{group}</p>
                    <ul className="mt-1.5 space-y-1">
                      {vars.map(([name, present]) => (
                        <li key={name} className="flex items-center gap-1.5 font-mono text-[11px] text-black/55">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${present ? "bg-[#20a65a]" : "bg-black/25"}`} />
                          <span className="min-w-0 truncate" title={present ? "已设置" : "缺失"}>{name}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-md border border-black/10 bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-black/10 px-5 py-4">
              <div>
                <h3 className="font-semibold">渠道总表</h3>
                <p className="mt-1 text-xs text-black/40">env 渠道可在此启停、调优先级（0 最高、99 最低）；池渠道在中转渠道页维护。</p>
              </div>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#2878d0] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7] disabled:opacity-40"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存
              </button>
            </div>
            <div className="divide-y divide-black/10">
              {data.channels.map((channel) => (
                <article key={channel.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={channel.kind === "env" ? "blue" : channel.kind === "pool" ? "gray" : "orange"}>
                        {KIND_LABELS[channel.kind]}
                      </Pill>
                      <strong className="text-sm">{channel.label}</strong>
                      {!channel.configured ? (
                        <Pill tone="gray">未配置</Pill>
                      ) : effectiveEnabled(channel) ? (
                        <Pill tone="green">生效</Pill>
                      ) : (
                        <Pill tone="red">已停用</Pill>
                      )}
                      {isOverridden(channel) && <Pill tone="blue">已覆写</Pill>}
                      {channel.coolingDown && <Pill tone="orange">本实例冷却中</Pill>}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-black/45">{channel.host || "—"}</p>
                    <p className="mt-1 text-xs text-black/45">
                      {channel.supportedModels.length > 0 ? channel.supportedModels.map(modelBaseName).join("、") : "—"}
                    </p>
                    <p className="mt-1 text-xs text-black/40">
                      来源：{channel.source}
                      {channel.usesBillingGateway && <span className="ml-1.5 font-semibold text-[#a82d24]">计费网关兼职生图</span>}
                    </p>
                  </div>
                  {channel.kind === "pool" ? (
                    <div className="flex items-center gap-3 md:justify-end">
                      <span className="inline-flex rounded bg-black/5 px-2 py-1 font-mono text-xs font-semibold text-black/55">P{channel.priority}</span>
                      <button type="button" onClick={() => onOpenRelays?.()} className="text-xs font-semibold text-[#2878d0] hover:underline">
                        在中转渠道页管理
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 md:justify-end">
                      {isOverridden(channel) && (
                        <button type="button" onClick={() => clearOverride(channel.id)} className="text-xs text-black/45 underline hover:text-black">
                          清除覆写
                        </button>
                      )}
                      <label className="flex items-center gap-2 text-xs text-black/55">
                        优先级
                        <input
                          type="number"
                          min={0}
                          max={99}
                          value={effectivePriority(channel)}
                          onChange={(event) => setPriority(channel, event.target.value)}
                          aria-label={`${channel.label} 优先级`}
                          className="admin-field mt-0 w-20 text-center"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => updateDraft(channel.id, { enabled: !effectiveEnabled(channel) })}
                        title={effectiveEnabled(channel) ? "停用" : "启用"}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${effectiveEnabled(channel) ? "bg-[#20a65a]" : "bg-black/15"}`}
                      >
                        <span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${effectiveEnabled(channel) ? "left-6" : "left-1"}`} />
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="relative overflow-hidden rounded-md border border-black/10 bg-white">
            {data.dangerFlags.mockMode && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#a82d24]/90 px-6 text-center">
                <p className="text-sm font-bold text-white">ENABLE_MOCK_MODE 开启中：生产当前返回假图，不走任何渠道</p>
              </div>
            )}
            <div className="border-b border-black/10 px-5 py-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="font-semibold">每模型队列预览</h3>
                <span className="text-xs text-[#d99024]">静态顺序：不含各实例的冷却降级——实际尝试顺序见下方路由事件</span>
              </div>
              {dirty && <p className="mt-1 text-xs text-black/40">当前有未保存的修改：预览基于已保存配置。</p>}
            </div>
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              {Object.entries(data.queues).map(([modelId, entries]) => (
                <div key={modelId} className="rounded-md border border-black/10 bg-[#f7f8f9] px-4 py-3">
                  <p className="text-sm font-semibold">{modelBaseName(modelId)}</p>
                  <p className="font-mono text-[11px] text-black/40">{modelId}</p>
                  {entries.length === 0 ? (
                    <p className="mt-2 text-xs text-[#a82d24]">无可用渠道</p>
                  ) : (
                    <ol className="mt-2 space-y-1">
                      {entries.map((entry, index) => (
                        <li key={`${entry.label}-${entry.host}-${index}`} className="flex items-baseline gap-2 font-mono text-xs text-black/60">
                          <span className="shrink-0 text-black/35">{index + 1}.</span>
                          <span className="min-w-0 truncate">{entry.label}@{entry.host}</span>
                          {entry.priority !== undefined && <span className="shrink-0 text-black/40">P{entry.priority}</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="overflow-hidden rounded-md border border-black/10 bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-black/10 px-5 py-4">
          <div>
            <h3 className="font-semibold">路由事件</h3>
            <p className="mt-1 text-xs text-black/40">样本窗口：{telemetry?.sampleNote ?? "—"}</p>
          </div>
          <button type="button" onClick={() => void loadEvents()} title="刷新" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/50 hover:bg-black/5">
            <RefreshCw className={`h-4 w-4 ${eventsLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {telemetry && telemetry.aggregates.length > 0 && (
          <div className="grid gap-3 border-b border-black/10 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
            {telemetry.aggregates.map((aggregate) => (
              <div key={`${aggregate.label}@${aggregate.host}`} className="rounded-md border border-black/10 bg-[#f7f8f9] px-4 py-3">
                <p className="truncate font-mono text-xs font-semibold text-black/70" title={`${aggregate.label}@${aggregate.host}`}>
                  {aggregate.label}@{aggregate.host}
                </p>
                <p className="mt-1.5 text-xs">
                  <span className="text-[#137a46]">成功 {aggregate.successes}</span>
                  <span className="mx-1.5 text-black/20">·</span>
                  <span className="text-[#a82d24]">失败 {aggregate.failures}</span>
                  <span className="mx-1.5 text-black/20">·</span>
                  <span className="text-black/45">取消 {aggregate.cancelled}</span>
                </p>
                <p className="mt-1 text-xs text-black/45">
                  平均成功耗时 {aggregate.avgOkMs === null ? "—" : formatMs(aggregate.avgOkMs)}
                </p>
              </div>
            ))}
          </div>
        )}

        {eventsLoading && !telemetry ? (
          <div className="flex min-h-32 items-center justify-center text-sm text-black/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />读取路由事件
          </div>
        ) : !telemetry || telemetry.events.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center px-5 text-center text-sm text-black/45">
            暂无路由事件（部署本版本后产生的生成请求才会记录）
          </div>
        ) : (
          <div className="divide-y divide-black/10">
            {telemetry.events.map((event) => {
              const outcome = OUTCOME_META[event.outcome] ?? { text: event.outcome, tone: "gray" as PillTone };
              const expanded = expandedId === event.id;
              return (
                <div key={event.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : event.id)}
                    className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 px-5 py-3 text-left hover:bg-black/[0.02] sm:grid-cols-[16px_120px_52px_minmax(0,1fr)_auto]"
                  >
                    {expanded ? <ChevronDown className="h-4 w-4 text-black/35" /> : <ChevronRight className="h-4 w-4 text-black/35" />}
                    <span className="hidden font-mono text-xs text-black/55 sm:block">{formatTime(event.ts)}</span>
                    <span className="hidden sm:block">
                      <Pill tone={event.pipeline === "biz" ? "orange" : "blue"}>{event.pipeline === "biz" ? "B端" : "用户"}</Pill>
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-xs">{modelBaseName(event.modelId)}</span>
                      <Pill tone={outcome.tone}>{outcome.text}</Pill>
                      {event.deliveredBy && <span className="truncate font-mono text-[11px] text-black/45">→ {event.deliveredBy}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-black/45">{formatMs(event.totalMs)}</span>
                  </button>
                  {expanded && (
                    <div className="border-t border-black/5 bg-[#f7f8f9] px-5 py-3">
                      <p className="font-mono text-[11px] text-black/40 sm:hidden">{formatTime(event.ts)} · {event.pipeline === "biz" ? "B端" : "用户"}</p>
                      {event.attempts.length === 0 ? (
                        <p className="text-xs text-black/45">无尝试记录。</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {event.attempts.map((attempt, index) => (
                            <li key={`${event.id}-${index}`} className="flex flex-wrap items-center gap-2 font-mono text-xs">
                              <span className="text-black/35">{index + 1}.</span>
                              <span className={attempt.ok ? "text-[#137a46]" : "text-[#a82d24]"}>{attempt.ok ? "成功" : "失败"}</span>
                              <span className="min-w-0 truncate text-black/60">{attempt.label}@{attempt.host}</span>
                              <span className="text-black/40">{formatMs(attempt.ms)}</span>
                              {attempt.status !== undefined && <span className="text-black/40">HTTP {attempt.status}</span>}
                              {attempt.reason && <span className="text-black/45">{attempt.reason}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {data && (
        <section className="rounded-md border border-black/10 bg-white px-5 py-4">
          <p className="text-xs text-black/45">{data.propagationNote}</p>
          <p className="mt-2 text-xs text-black/45">
            仍需改环境变量并重新部署的操作：env 渠道地址/密钥更换、firefly 支持模型清单、计费网关地址。
          </p>
        </section>
      )}
    </div>
  );
}
