"use client";

// /admin「用量统计」分页（PRD REQ-C2 Statistics 统计视图）。
//
// 本页是既有帐本与能力表的**只读投影**，设计纪律与后端同一条：
// 1. 展示层只说帐本说过的话——每个数字旁边给出帐本行 id（滑过可见全部样本）；
// 2. 样本不足画「资料不足」，不画 0（0% 是一句假话）；
// 3. 渠道判活三态原样画出，unknown（无法判定）绝不被折叠成「不可用」或「正常」；
// 4. 空窗口不画假曲线：没有帐本行就直接说「窗口内没有任何已落帐记录」。
//
// 样式跟随既有 admin 面板（AdminPoolManager / AdminHome 的扁平 token），
// 不引入 Liquid Glass 材料，避免管理面出现第二套视觉语言。
//
// 文案纪律：本元件零硬编用户可见字串，全部经 `text()` 取自 src/lib/ui-strings.ts
// （守门件 src/lib/ui-strings.test.ts 去注解后禁 CJK）。帐本／能力表回传的字串
// （notes / reason / metric / label）是上游资料，不属本层文案。

import { useEffect, useState } from "react";
import { BarChart3, CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { NUMBER_LOCALE, text, type UiStringKey } from "@/lib/ui-strings";
import { UNATTRIBUTED_SOURCE } from "@/lib/first-touch-attribution";
import type {
  ActivationFunnelResult,
  DurationSummary,
  FunnelStepKey,
  ChannelHealthEntry,
  ChannelLiveness,
  ConsumptionProjection,
  RemainingQuotaProjection,
  SampleRate,
  StatisticsSourceRow,
  UsageBucket,
} from "@/lib/generation-core/statistics-projection";

interface StatisticsPayload {
  configured: boolean;
  window: { days: number; generatedAt: string; dayTimezone: string; partial: boolean; windowStartDay?: string };
  consumption: ConsumptionProjection | null;
  channelHealth: ChannelHealthEntry[];
  remainingQuota: RemainingQuotaProjection;
  traffic?: { includeInternal: boolean; internalUserIds: number[] };
  activationFunnel?: ActivationFunnelResult;
  sources: StatisticsSourceRow[];
  notes: string[];
}

type ModelAvailability = "available" | "unavailable" | "unknown";

const WINDOW_OPTIONS = [1, 7, 14, 30] as const;
const FUNNEL_WINDOW_CHOICES = [7, 30] as const;

const FUNNEL_STEP_LABEL: Record<FunnelStepKey, UiStringKey> = {
  registered: "stats.funnel.step.registered",
  generated: "stats.funnel.step.generated",
  succeeded: "stats.funnel.step.succeeded",
  returned: "stats.funnel.step.returned",
  paid: "stats.funnel.step.paid",
};

/**
 * 三态标签（展示层话术，只在这里取用）。unknown 是诚实第三态，不并入任何一边。
 * 渠道判活与模型活性是同一组三态，共用一张表＝话术只有一处。
 */
const STATUS_META: Record<ChannelLiveness, { key: UiStringKey; className: string }> = {
  available: { key: "stats.liveness.available", className: "bg-[#e7f5ec] text-[#1c7a43] border-[#bfe3cd]" },
  unavailable: { key: "stats.liveness.unavailable", className: "bg-[#fdeceb] text-[#a82d24] border-[#f3c9c5]" },
  unknown: { key: "stats.liveness.unknown", className: "bg-[#eef0f3] text-[#5b6270] border-[#d7dbe2]" },
};

const TONE_META: Record<ModelAvailability, { key: UiStringKey; className: string }> = STATUS_META;

function unwrap<T>(body: unknown, marker: string): T | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const candidate =
    record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  return marker in candidate ? (candidate as unknown as T) : null;
}

function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(NUMBER_LOCALE, options);
}

/** 样本足够才给比率；否则明写「资料不足（n/min）」——不回落成 0。 */
function RateCell({ rate }: { rate: SampleRate }) {
  if (rate.state === "insufficient") {
    return (
      <span className="text-[#8a6420]">
        {text("stats.rate.insufficient", { samples: rate.samples, minimum: rate.minimum })}
      </span>
    );
  }
  return (
    <span>
      {text("stats.rate.percent", { value: (rate.value * 100).toFixed(1) })}
      <span className="ml-1 text-black/40">{text("stats.rate.samples", { count: rate.samples })}</span>
    </span>
  );
}

/** 秒数 → 人读时长（秒 / 分钟 / 小时 / 天），单位文案取自文案表。 */
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return text("common.placeholder");
  if (seconds < 120) return text("stats.duration.seconds", { value: Math.round(seconds) });
  if (seconds < 7200) return text("stats.duration.minutes", { value: (seconds / 60).toFixed(1) });
  if (seconds < 172800) return text("stats.duration.hours", { value: (seconds / 3600).toFixed(1) });
  return text("stats.duration.days", { value: (seconds / 86400).toFixed(1) });
}

function DurationRow({ label, summary, meta }: { label: string; summary: DurationSummary; meta?: string }) {
  return (
    <div className="rounded-md border border-black/10 px-3 py-2.5">
      <p className="text-[13px] text-black/55">{label}</p>
      {summary.samples > 0 ? (
        <p className="mt-1 text-base font-semibold text-[#242830]">
          {text("stats.firstImage.percentiles", {
            p50: formatDuration(summary.p50Seconds),
            p90: formatDuration(summary.p90Seconds),
          })}
        </p>
      ) : (
        <p className="mt-1 text-[13px] font-semibold text-[#8a6420]">{text("stats.firstImage.empty")}</p>
      )}
      <p className="mt-1 text-[13px] text-black/45">
        {text("stats.firstImage.samples", { count: summary.samples })}
        {meta ? ` · ${meta}` : ""}
      </p>
    </div>
  );
}

/** 激活漏斗卡：每步人数 + 相对上一步 / 相对注册的转化率；样本不足沿用「资料不足」。 */
function ActivationFunnelCard({
  funnel,
  funnelDays,
  onFunnelDays,
}: {
  funnel: ActivationFunnelResult | undefined;
  funnelDays: number;
  onFunnelDays: (days: number) => void;
}) {
  const registered = funnel && funnel.state === "ok" ? Math.max(1, funnel.steps[0]?.count ?? 0) : 1;
  return (
    <section className="rounded-md border border-black/10 bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-black/10 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">{text("stats.funnel.title")}</h3>
          <p className="mt-0.5 text-[13px] text-black/45">{text("stats.funnel.subtitle")}</p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-black/10 p-1">
          {FUNNEL_WINDOW_CHOICES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onFunnelDays(option)}
              className={`rounded px-2.5 py-1 text-[13px] font-semibold ${
                funnelDays === option ? "bg-[#20242c] text-white" : "text-black/55 hover:bg-black/5"
              }`}
            >
              {text("stats.funnel.window", { days: option })}
            </button>
          ))}
        </div>
      </header>
      {!funnel || funnel.state === "unavailable" ? (
        <p className="px-4 py-6 text-[13px] text-[#8a6420]">
          {text("stats.funnel.unavailable", {
            reason: funnel && funnel.state === "unavailable" ? funnel.reason : text("common.placeholder"),
          })}
        </p>
      ) : (
        <>
          <ol className="flex flex-col gap-2.5 px-4 py-3">
            {funnel.steps.map((step) => (
              <li key={step.key} className="flex flex-wrap items-center gap-3 text-[13px]">
                <span className="w-28 shrink-0 font-medium text-[#242830]">{text(FUNNEL_STEP_LABEL[step.key])}</span>
                <span className="h-2.5 min-w-[120px] flex-1 overflow-hidden rounded bg-black/5">
                  <span
                    className="block h-full rounded bg-[#20242c]"
                    style={{ width: `${step.count === 0 ? 0 : Math.max(2, (step.count / registered) * 100)}%` }}
                  />
                </span>
                <span
                  className="w-16 shrink-0 text-right font-semibold"
                  title={text("stats.funnel.userIdsTitle", { ids: step.userIds.join(", ") || text("common.placeholder") })}
                >
                  {text("stats.funnel.users", { count: step.count })}
                </span>
                <span className="w-44 shrink-0 text-black/55">
                  {step.fromPrevious ? (
                    <>
                      <span className="mr-1 text-black/40">{text("stats.funnel.fromPrevious")}</span>
                      <RateCell rate={step.fromPrevious} />
                    </>
                  ) : null}
                </span>
                <span className="w-44 shrink-0 text-black/55">
                  {step.fromRegistered ? (
                    <>
                      <span className="mr-1 text-black/40">{text("stats.funnel.fromRegistered")}</span>
                      <RateCell rate={step.fromRegistered} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <ul className="flex flex-col gap-1 border-t border-black/5 px-4 py-3 text-[13px] text-black/55">
            <li>{text("stats.funnel.d1", { count: funnel.d1Returned })}</li>
            {funnel.returnWindowImmature > 0 ? (
              <li>{text("stats.funnel.immature", { count: funnel.returnWindowImmature })}</li>
            ) : null}
            <li>{text("stats.funnel.paidAny", { count: funnel.paidAnyStage })}</li>
            {funnel.nonCashRechargesSkipped > 0 ? (
              <li>{text("stats.funnel.nonCash", { count: funnel.nonCashRechargesSkipped })}</li>
            ) : null}
            {funnel.excludedInternalRegistrations > 0 ? (
              <li>{text("stats.funnel.excludedInternal", { count: funnel.excludedInternalRegistrations })}</li>
            ) : null}
            {funnel.truncated ? <li className="text-[#8a6420]">{text("stats.funnel.truncated")}</li> : null}
          </ul>
          <div className="border-t border-black/5 px-4 py-3">
            <h4 className="text-[13px] font-semibold text-[#242830]">{text("stats.funnel.sources.title")}</h4>
            <p className="mt-0.5 text-[13px] text-black/45">{text("stats.funnel.sources.subtitle")}</p>
            {funnel.sourceBreakdownUnavailable ? (
              <p className="mt-2 text-[13px] text-[#8a6420]">{text("stats.funnel.sources.unavailable")}</p>
            ) : null}
            {funnel.sources.length === 0 ? (
              <p className="mt-2 text-[13px] text-black/45">{text("stats.funnel.sources.empty")}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-black/45">
                      <th className="py-1 pr-3 text-left font-medium">{text("stats.funnel.sources.source")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{text("stats.funnel.sources.registered")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{text("stats.funnel.sources.generated")}</th>
                      <th className="py-1 pr-3 text-right font-medium">{text("stats.funnel.sources.succeeded")}</th>
                      <th className="py-1 text-right font-medium">{text("stats.funnel.sources.paid")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.sources.map((row) => (
                      <tr key={row.source} className="border-t border-black/5">
                        <td className="py-1 pr-3 font-medium text-[#242830]">
                          {row.source === UNATTRIBUTED_SOURCE ? text("stats.funnel.sources.unknown") : row.source}
                        </td>
                        <td className="py-1 pr-3 text-right">{row.registered}</td>
                        <td className="py-1 pr-3 text-right">{row.generated}</td>
                        <td className="py-1 pr-3 text-right">{row.succeeded}</td>
                        <td className="py-1 text-right">{row.paid}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="border-t border-black/5 px-4 py-3">
            <h4 className="text-[13px] font-semibold text-[#242830]">{text("stats.firstImage.title")}</h4>
            <p className="mt-0.5 text-[13px] text-black/45">{text("stats.firstImage.subtitle")}</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <DurationRow
                label={text("stats.firstImage.registerToSuccess")}
                summary={funnel.timeToFirstImage.registerToFirstSuccess}
              />
              <DurationRow
                label={text("stats.firstImage.firstJob")}
                summary={funnel.timeToFirstImage.firstJobCreatedToFinished}
                meta={text("stats.firstImage.firstJobMeta", {
                  unfinished: funnel.timeToFirstImage.firstJobCreatedToFinished.unfinished,
                  notSucceeded: funnel.timeToFirstImage.firstJobCreatedToFinished.firstJobNotSucceeded,
                })}
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** 帐本行 id 对照：显示首条，滑过可见全部样本。 */
function RecordsCell({ recordIds, total }: { recordIds: string[]; total: number }) {
  const [first] = recordIds;
  if (!first) return <span className="text-black/35">{text("stats.records.none")}</span>;
  return (
    <span
      className="font-mono text-[11px] text-black/55"
      title={text("stats.records.sampleTitle", { ids: recordIds.join("\n") })}
    >
      {first.length > 18 ? `${first.slice(0, 18)}…` : first}
      <span className="ml-1 text-black/35">{text("stats.records.total", { total })}</span>
    </span>
  );
}

function BucketTable({
  title,
  subtitle,
  buckets,
  keyHeader,
}: {
  title: string;
  subtitle: string;
  buckets: UsageBucket[];
  keyHeader: string;
}) {
  return (
    <section className="rounded-md border border-black/10 bg-white">
      <header className="border-b border-black/10 px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-black/45">{subtitle}</p>
      </header>
      {buckets.length === 0 ? (
        <p className="px-4 py-6 text-xs text-black/45">{text("stats.bucket.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-black/45">
              <tr className="border-b border-black/5">
                <th className="px-4 py-2 font-medium">{keyHeader}</th>
                <th className="px-4 py-2 font-medium">{text("stats.bucket.colCoins")}</th>
                <th className="px-4 py-2 font-medium">{text("stats.bucket.colLedgerRows")}</th>
                <th className="px-4 py-2 font-medium">{text("stats.bucket.colRecords")}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.key} className="border-b border-black/5 last:border-0">
                  <td className="px-4 py-2 font-medium text-[#242830]">{bucket.label}</td>
                  <td className="px-4 py-2">{formatNumber(bucket.coins, { maximumFractionDigits: 6 })}</td>
                  <td className="px-4 py-2">{bucket.operations}</td>
                  <td className="px-4 py-2">
                    <RecordsCell recordIds={bucket.recordIds} total={bucket.operations} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AdminStatistics() {
  const [days, setDays] = useState<number>(7);
  const [funnelDays, setFunnelDays] = useState<number>(30);
  // 内部流量预设不计（站长自测会把「没有量」画成「有量」）。
  const [includeInternal, setIncludeInternal] = useState(false);
  const [payload, setPayload] = useState<StatisticsPayload | null>(null);
  const [modelStatus, setModelStatus] = useState<Record<string, ModelAvailability> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (windowDays: number, windowFunnelDays: number, withInternal: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, modelsRes] = await Promise.all([
        fetch(
          `/api/admin/statistics?days=${windowDays}&funnelDays=${windowFunnelDays}&includeInternal=${withInternal ? "1" : "0"}`,
          { cache: "no-store" },
        ),
        fetch("/api/user/model-status", { cache: "no-store" }),
      ]);
      const statsBody = (await statsRes.json().catch(() => null)) as unknown;
      const modelsBody = (await modelsRes.json().catch(() => null)) as unknown;
      const statsPayload = unwrap<StatisticsPayload>(statsBody, "window");
      if (!statsRes.ok || !statsPayload) {
        const message =
          statsBody && typeof statsBody === "object" && typeof (statsBody as { message?: unknown }).message === "string"
            ? String((statsBody as { message: string }).message)
            : text("stats.error.read");
        throw new Error(message);
      }
      setPayload(statsPayload);
      // 模型三态直接消费既有的公开端点（与 /v1/model-status 同一份判活），本页不重算。
      const models = (modelsBody as { models?: Record<string, ModelAvailability> } | null)?.models ?? null;
      setModelStatus(models);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : text("stats.error.generic"));
      setPayload(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(days, funnelDays, includeInternal);
  }, [days, funnelDays, includeInternal]);

  const consumption = payload?.consumption ?? null;
  const quota = payload?.remainingQuota ?? null;
  const maxDayQuota = consumption ? Math.max(1, ...consumption.byDay.map((bucket) => bucket.quota)) : 1;

  const modelEntries = Object.entries(modelStatus ?? {});
  const modelCounts: Record<ModelAvailability, number> = { available: 0, unavailable: 0, unknown: 0 };
  for (const [, availability] of modelEntries) modelCounts[availability] += 1;

  return (
    <div className="flex flex-col gap-5">
      <header className="rounded-md border border-black/10 bg-white px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#20242c] text-white">
              <BarChart3 className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">{text("stats.title")}</h2>
              <p className="mt-0.5 text-xs text-black/45">{text("stats.subtitle")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border border-black/10 p-1">
              {[false, true].map((option) => (
                <button
                  key={String(option)}
                  type="button"
                  onClick={() => setIncludeInternal(option)}
                  className={`rounded px-2.5 py-1 text-[13px] font-semibold ${
                    includeInternal === option ? "bg-[#20242c] text-white" : "text-black/55 hover:bg-black/5"
                  }`}
                >
                  {text(option ? "stats.traffic.include" : "stats.traffic.exclude")}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-md border border-black/10 p-1">
              {WINDOW_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDays(option)}
                  className={`rounded px-2.5 py-1 text-xs font-semibold ${
                    days === option ? "bg-[#20242c] text-white" : "text-black/55 hover:bg-black/5"
                  }`}
                >
                  {text("stats.window.days", { days: option })}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load(days, funnelDays, includeInternal)}
              title={text("stats.refresh")}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-black/10 text-black/55 hover:bg-black/5 hover:text-black"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {payload ? (
          <p className="mt-2 text-[11px] text-black/40">
            {text("stats.window.summary", {
              days: payload.window.days,
              timezone: payload.window.dayTimezone,
              generatedAt: new Date(payload.window.generatedAt).toLocaleString(NUMBER_LOCALE),
            })}
          </p>
        ) : null}
        {payload?.traffic ? (
          <p className="mt-1 text-[13px] text-black/45">
            {payload.traffic.internalUserIds.length > 0
              ? text("stats.traffic.summary", { ids: payload.traffic.internalUserIds.join(", ") })
              : text("stats.traffic.none")}
          </p>
        ) : null}
      </header>

      {error ? (
        <p className="flex items-center gap-2 rounded-md border border-[#f3c9c5] bg-[#fdeceb] px-4 py-3 text-xs text-[#a82d24]">
          <CircleAlert className="h-4 w-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {payload && !payload.configured ? (
        <p className="rounded-md border border-black/10 bg-white px-4 py-4 text-xs text-black/55">
          {text("stats.notConfigured")}
        </p>
      ) : null}

      {(payload?.notes ?? []).map((note) => (
        <p key={note} className="rounded-md border border-[#e8d9b5] bg-[#fdf7e7] px-4 py-3 text-xs text-[#8a6420]">
          {note}
        </p>
      ))}

      {payload?.configured ? (
        <>
          <ActivationFunnelCard funnel={payload.activationFunnel} funnelDays={funnelDays} onFunnelDays={setFunnelDays} />

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border border-black/10 bg-white px-4 py-3">
              <p className="text-xs text-black/45">{text("stats.card.windowCoins")}</p>
              <p className="mt-1 text-xl font-semibold">
                {consumption ? formatNumber(consumption.totalCoins, { maximumFractionDigits: 6 }) : text("common.placeholder")}
              </p>
              <p className="mt-1 text-[11px] text-black/40">
                {text("stats.card.totalQuota", {
                  quota: consumption ? formatNumber(consumption.totalQuota) : text("common.placeholder"),
                })}
              </p>
              {consumption && consumption.refundedOperations > 0 ? (
                <p className="mt-1 text-[11px] text-black/40">
                  {text("stats.card.windowCoinsCharged", {
                    charged: formatNumber(consumption.chargedCoins, { maximumFractionDigits: 6 }),
                    refunded: formatNumber(consumption.refundedCoins, { maximumFractionDigits: 6 }),
                  })}
                </p>
              ) : null}
            </div>
            <div className="rounded-md border border-black/10 bg-white px-4 py-3">
              <p className="text-xs text-black/45">{text("stats.card.ledgerRows")}</p>
              <p className="mt-1 text-xl font-semibold">{consumption ? consumption.operations : text("common.placeholder")}</p>
              <p className="mt-1 text-[11px] text-black/40">{text("stats.card.ledgerSource")}</p>
            </div>
            {consumption && consumption.refundedOperations > 0 ? (
              <div className="rounded-md border border-black/10 bg-white px-4 py-3">
                <p className="text-xs text-black/45">{text("stats.card.refunded")}</p>
                <p className="mt-1 text-xl font-semibold">
                  {formatNumber(consumption.refundedCoins, { maximumFractionDigits: 6 })}
                </p>
                <p className="mt-1 text-[11px] text-black/40">
                  {text("stats.refunded.breakdown", {
                    rows: consumption.refunded.operations,
                    jobs: consumption.refunded.fullyRefundedJobs,
                  })}
                </p>
                <RecordsCell recordIds={consumption.refunded.recordIds} total={consumption.refunded.operations} />
              </div>
            ) : null}
            <div className="rounded-md border border-black/10 bg-white px-4 py-3">
              <p className="text-xs text-black/45">{text("stats.card.unattributed")}</p>
              <p className="mt-1 text-xl font-semibold">
                {consumption ? formatNumber(consumption.unattributed.coins, { maximumFractionDigits: 6 }) : text("common.placeholder")}
              </p>
              <p className="mt-1 text-[11px] text-black/40">
                {consumption ? text("stats.card.unattributedNote", { rows: consumption.unattributed.operations }) : text("common.placeholder")}
              </p>
            </div>
            <div className="rounded-md border border-black/10 bg-white px-4 py-3">
              <p className="text-xs text-black/45">{text("stats.card.remainingQuota")}</p>
              {quota && quota.knownCount > 0 ? (
                <>
                  <p className="mt-1 text-xl font-semibold">
                    {formatNumber(quota.knownCoins, { maximumFractionDigits: 6 })}
                  </p>
                  <p className="mt-1 text-[11px] text-black/40">
                    {text("stats.card.knownIdentities", { count: quota.knownCount })}
                    {quota.unknownCount > 0 ? text("stats.card.unknownIdentities", { count: quota.unknownCount }) : ""}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm font-semibold text-[#8a6420]">
                  {text("stats.card.noQuota")}
                  {quota && quota.unknownCount > 0
                    ? text("stats.card.unknownIdentitiesShort", { count: quota.unknownCount })
                    : ""}
                </p>
              )}
              {quota && quota.coverage.truncated ? (
                <p className="mt-1 text-[11px] text-[#8a6420]">
                  {text("stats.card.quotaTruncated", {
                    covered: quota.coverage.coveredCount,
                    total: quota.coverage.totalIdentities,
                    limit: quota.coverage.limit,
                  })}
                </p>
              ) : null}
            </div>
          </section>

          <section className="rounded-md border border-black/10 bg-white">
            <header className="border-b border-black/10 px-4 py-3">
              <h3 className="text-sm font-semibold">{text("stats.daily.title")}</h3>
              <p className="mt-0.5 text-xs text-black/45">
                {text("stats.daily.subtitle", { timezone: payload.window.dayTimezone })}
              </p>
            </header>
            {consumption && consumption.byDay.length > 0 ? (
              <ul className="flex flex-col gap-2 px-4 py-3">
                {consumption.byDay.map((bucket) => (
                  <li key={bucket.key} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 font-mono text-[11px] text-black/55">{bucket.label}</span>
                    {bucket.partial ? (
                      <span
                        className="shrink-0 rounded border border-[#e8d9b5] bg-[#fdf7e7] px-1.5 py-0.5 text-[11px] font-semibold text-[#8a6420]"
                        title={text("stats.daily.partialTitle", {
                          day: bucket.key,
                          timezone: payload.window.dayTimezone,
                        })}
                      >
                        {text("stats.daily.partial")}
                      </span>
                    ) : null}
                    <span className="h-2 flex-1 overflow-hidden rounded bg-black/5">
                      <span
                        className="block h-full rounded bg-[#20242c]"
                        style={{ width: `${Math.max(2, (bucket.quota / maxDayQuota) * 100)}%` }}
                      />
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs">
                      {text("stats.daily.coins", { coins: formatNumber(bucket.coins, { maximumFractionDigits: 6 }) })}
                    </span>
                    <span className="w-40 shrink-0 text-right">
                      <RecordsCell recordIds={bucket.recordIds} total={bucket.operations} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-xs text-black/45">{text("stats.daily.empty")}</p>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <BucketTable
              title={text("stats.byModel.title")}
              subtitle={text("stats.byModel.subtitle")}
              buckets={consumption?.byModel ?? []}
              keyHeader={text("stats.byModel.key")}
            />
            <BucketTable
              title={text("stats.byChannel.title")}
              subtitle={text("stats.byChannel.subtitle")}
              buckets={consumption?.byChannel ?? []}
              keyHeader={text("stats.byChannel.key")}
            />
          </div>

          <section className="rounded-md border border-black/10 bg-white">
            <header className="border-b border-black/10 px-4 py-3">
              <h3 className="text-sm font-semibold">{text("stats.health.title")}</h3>
              <p className="mt-0.5 text-xs text-black/45">{text("stats.health.subtitle")}</p>
            </header>
            {payload.channelHealth.length === 0 ? (
              <p className="px-4 py-6 text-xs text-black/45">{text("stats.health.empty")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-black/45">
                    <tr className="border-b border-black/5">
                      <th className="px-4 py-2 font-medium">{text("stats.health.colChannel")}</th>
                      <th className="px-4 py-2 font-medium">{text("stats.health.colLiveness")}</th>
                      <th className="px-4 py-2 font-medium">{text("stats.health.colCapabilities")}</th>
                      <th className="px-4 py-2 font-medium">{text("stats.health.colSuccessRate")}</th>
                      <th className="px-4 py-2 font-medium">{text("stats.health.colLastSuccess")}</th>
                      <th className="px-4 py-2 font-medium">{text("stats.health.colReason")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.channelHealth.map((entry) => (
                      <tr key={entry.channelId} className="border-b border-black/5 last:border-0">
                        <td className="px-4 py-2">
                          <span className="font-medium text-[#242830]">{entry.label}</span>
                          <span className="ml-1 font-mono text-[11px] text-black/35">{entry.channelId}</span>
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_META[entry.liveness].className}`}
                          >
                            {text(STATUS_META[entry.liveness].key)}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {entry.schedulableCapabilities}/{entry.capabilities}
                        </td>
                        <td className="px-4 py-2">
                          <RateCell rate={entry.successRate} />
                        </td>
                        <td className="px-4 py-2 text-black/55">
                          {entry.lastSuccessAt
                            ? new Date(entry.lastSuccessAt).toLocaleString(NUMBER_LOCALE)
                            : text("common.noRecord")}
                        </td>
                        <td className="px-4 py-2 text-black/55">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-md border border-black/10 bg-white">
            <header className="border-b border-black/10 px-4 py-3">
              <h3 className="text-sm font-semibold">{text("stats.quota.title")}</h3>
              <p className="mt-0.5 text-xs text-black/45">{text("stats.quota.subtitle")}</p>
              {quota && quota.coverage.truncated ? (
                <p className="mt-1 text-xs text-[#8a6420]">
                  {text("stats.quota.coverage", {
                    total: quota.coverage.totalIdentities,
                    covered: quota.coverage.coveredCount,
                    limit: quota.coverage.limit,
                  })}
                </p>
              ) : null}
            </header>
            {quota && quota.entries.length > 0 ? (
              <ul className="divide-y divide-black/5">
                {quota.entries.map((entry) => (
                  <li key={entry.billingUserId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs">
                    <span className="font-mono text-black/55">{text("stats.quota.userId", { id: entry.billingUserId })}</span>
                    {entry.state === "known" ? (
                      <span className="font-medium">
                        {text("stats.quota.entryCoins", { coins: formatNumber(entry.coins ?? 0, { maximumFractionDigits: 6 }) })}
                        <span className="ml-2 text-black/40">
                          {text("stats.quota.entryRaw", { quota: formatNumber(entry.quota ?? 0) })}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[#8a6420]">
                        {text("stats.quota.unknown", { reason: entry.reason ?? text("stats.quota.unknownReason") })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-xs text-black/45">{text("stats.quota.empty")}</p>
            )}
          </section>

          <section className="rounded-md border border-black/10 bg-white">
            <header className="border-b border-black/10 px-4 py-3">
              <h3 className="text-sm font-semibold">{text("stats.models.title")}</h3>
              <p className="mt-0.5 text-xs text-black/45">{text("stats.models.subtitle")}</p>
            </header>
            {modelStatus === null ? (
              <p className="px-4 py-6 text-xs text-black/45">{text("stats.models.unavailableDict")}</p>
            ) : (
              <div className="px-4 py-3">
                <p className="text-xs text-black/55">
                  {text("stats.models.counts", {
                    availableLabel: text("stats.liveness.available"),
                    available: modelCounts.available,
                    unavailableLabel: text("stats.liveness.unavailable"),
                    unavailable: modelCounts.unavailable,
                    unknownLabel: text("stats.liveness.unknown"),
                    unknown: modelCounts.unknown,
                  })}
                </p>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {modelEntries.map(([modelId, availability]) => (
                    <li key={modelId} className="flex items-center justify-between gap-2 rounded border border-black/10 px-2.5 py-1.5">
                      <span className="truncate text-xs text-[#242830]" title={modelId}>
                        {modelId}
                      </span>
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${TONE_META[availability].className}`}
                      >
                        {text(TONE_META[availability].key)}
                      </span>
                    </li>
                  ))}
                </ul>
                {modelEntries.length === 0 ? (
                  <p className="mt-2 text-xs text-black/45">{text("stats.models.emptyDict")}</p>
                ) : null}
              </div>
            )}
          </section>

          <section className="rounded-md border border-black/10 bg-white">
            <header className="border-b border-black/10 px-4 py-3">
              <h3 className="text-sm font-semibold">{text("stats.sources.title")}</h3>
              <p className="mt-0.5 text-xs text-black/45">{text("stats.sources.subtitle")}</p>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-black/45">
                  <tr className="border-b border-black/5">
                    <th className="px-4 py-2 font-medium">{text("stats.sources.colMetric")}</th>
                    <th className="px-4 py-2 font-medium">{text("stats.sources.colSource")}</th>
                    <th className="px-4 py-2 font-medium">{text("stats.sources.colNote")}</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.sources.map((row) => (
                    <tr key={row.metric} className="border-b border-black/5 last:border-0">
                      <td className="px-4 py-2 font-medium text-[#242830]">{row.metric}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-black/55">{row.source}</td>
                      <td className="px-4 py-2 text-black/55">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
