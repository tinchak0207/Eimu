"use client";

// /admin 首屏：以可视化图表为主（矩形树状图 + 结果分布 + 渠道排行），
// 不含长文本表格——那些留给侧边栏「路由调度」分页。危险状态横幅例外：
// mock 模式之类的运营风险不能被藏进要点两次才能看到的分页里。

import { useEffect, useState } from "react";
import { CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { RoutingTreemap } from "@/components/admin/RoutingTreemap";
import { modelBaseName } from "@/lib/provider-config";
import type { ChannelAggregate, ModelBreakdown, RoutingEvent, RoutingOutcome } from "@/lib/routing-telemetry";

interface EventsPayload {
  events: RoutingEvent[];
  aggregates: ChannelAggregate[];
  modelBreakdown: ModelBreakdown[];
  sampleNote: string;
}

interface ChannelsPayload {
  dangerFlags: { mockMode: boolean; localTestMode: boolean };
  storage: "blob" | "memory";
}

const OUTCOME_META: Record<RoutingOutcome, { text: string; color: string }> = {
  delivered: { text: "已出图", color: "#20a65a" },
  exhausted: { text: "全部失败", color: "#a82d24" },
  cancelled: { text: "已取消", color: "#8a8f98" },
  "budget-exhausted": { text: "预算耗尽", color: "#d99024" },
  "no-endpoints": { text: "无可用渠道", color: "#c2478c" },
};

function unwrap<T>(body: unknown, marker: string): T | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const candidate =
    record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  return marker in candidate ? (candidate as unknown as T) : null;
}

export function AdminHome() {
  const [events, setEvents] = useState<EventsPayload | null>(null);
  const [channels, setChannels] = useState<ChannelsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [eventsRes, channelsRes] = await Promise.all([
        fetch("/api/admin/routing-events?limit=200", { cache: "no-store" }),
        fetch("/api/admin/channels", { cache: "no-store" }),
      ]);
      const eventsBody = (await eventsRes.json().catch(() => null)) as unknown;
      const channelsBody = (await channelsRes.json().catch(() => null)) as unknown;
      const eventsPayload = unwrap<EventsPayload>(eventsBody, "events");
      const channelsPayload = unwrap<ChannelsPayload>(channelsBody, "channels");
      if (!eventsRes.ok || !eventsPayload) throw new Error("读取路由事件失败。");
      setEvents(eventsPayload);
      if (channelsRes.ok && channelsPayload) setChannels(channelsPayload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取失败。");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const outcomeCounts = (Object.keys(OUTCOME_META) as RoutingOutcome[]).map((outcome) => ({
    outcome,
    count: events?.events.filter((event) => event.outcome === outcome).length ?? 0,
  }));
  const outcomeTotal = outcomeCounts.reduce((sum, item) => sum + item.count, 0);

  const topChannels = [...(events?.aggregates ?? [])]
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 6);
  const maxChannelAttempts = Math.max(1, ...topChannels.map((channel) => channel.attempts));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">路由总览</h2>
          <p className="mt-1 text-sm text-black/45">{events?.sampleNote ?? "统计窗口：最近事件"}</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          title="刷新"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-black/10 text-black/50 hover:bg-black/5"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {channels?.dangerFlags.mockMode && (
        <div className="flex items-start gap-2 rounded-md border border-[#efc3bf] bg-[#fff2f0] px-3 py-2.5 text-sm font-semibold text-[#a82d24]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          ENABLE_MOCK_MODE 开启中：生产当前返回假图，不走任何渠道。
        </div>
      )}
      {channels?.dangerFlags.localTestMode && (
        <div className="flex items-start gap-2 rounded-md border border-[#d99024]/40 bg-[#d99024]/10 px-3 py-2.5 text-sm text-[#d99024]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          NEXT_PUBLIC_LOCAL_TEST_MODE 开启中：登录鉴权被绕过，仅限本地调试。
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-[#efc3bf] bg-[#fff2f0] px-3 py-2.5 text-sm text-[#a82d24]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && !events ? (
        <div className="flex min-h-64 items-center justify-center rounded-md border border-black/10 bg-white text-sm text-black/45">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />读取路由数据
        </div>
      ) : (
        <>
          <RoutingTreemap data={events?.modelBreakdown ?? []} />

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="overflow-hidden rounded-md border border-black/10 bg-white">
              <div className="border-b border-black/10 px-5 py-4">
                <h3 className="font-semibold">结果分布</h3>
                <p className="mt-1 text-xs text-black/40">共 {outcomeTotal} 条事件的最终结果占比。</p>
              </div>
              <div className="px-5 py-4">
                {outcomeTotal === 0 ? (
                  <p className="text-sm text-black/40">暂无数据</p>
                ) : (
                  <>
                    <div className="flex h-3 w-full overflow-hidden rounded-full bg-black/5">
                      {outcomeCounts.filter((item) => item.count > 0).map((item) => (
                        <div
                          key={item.outcome}
                          style={{ width: `${(item.count / outcomeTotal) * 100}%`, backgroundColor: OUTCOME_META[item.outcome].color }}
                          title={`${OUTCOME_META[item.outcome].text} · ${item.count}`}
                        />
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-3">
                      {outcomeCounts.filter((item) => item.count > 0).map((item) => (
                        <span key={item.outcome} className="flex items-center gap-1.5 text-xs text-black/55">
                          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: OUTCOME_META[item.outcome].color }} />
                          {OUTCOME_META[item.outcome].text}（{item.count} · {((item.count / outcomeTotal) * 100).toFixed(0)}%）
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="overflow-hidden rounded-md border border-black/10 bg-white">
              <div className="border-b border-black/10 px-5 py-4">
                <h3 className="font-semibold">渠道尝试排行</h3>
                <p className="mt-1 text-xs text-black/40">按尝试次数排序的前 6 个渠道，绿色成功 / 红色失败。</p>
              </div>
              <div className="space-y-3 px-5 py-4">
                {topChannels.length === 0 ? (
                  <p className="text-sm text-black/40">暂无数据</p>
                ) : (
                  topChannels.map((channel) => (
                    <div key={`${channel.label}@${channel.host}`}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="min-w-0 truncate font-mono text-black/60" title={`${channel.label}@${channel.host}`}>
                          {channel.label}@{channel.host}
                        </span>
                        <span className="shrink-0 text-black/40">{channel.attempts} 次</span>
                      </div>
                      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-black/5" style={{ width: `${(channel.attempts / maxChannelAttempts) * 100}%` }}>
                        <div className="bg-[#20a65a]" style={{ width: `${(channel.successes / channel.attempts) * 100}%` }} />
                        <div className="bg-[#a82d24]" style={{ width: `${(channel.failures / channel.attempts) * 100}%` }} />
                        <div className="bg-black/20" style={{ width: `${(channel.cancelled / channel.attempts) * 100}%` }} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/* modelBaseName 目前仅在 RoutingTreemap 内使用；此处保留导入以避免未来在本文件内
   直接展示模型名时再补一次导入——若始终未用到会被 lint 标记，届时删除。 */
void modelBaseName;
