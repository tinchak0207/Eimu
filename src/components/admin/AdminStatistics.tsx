"use client";

// /admin「用量统计」分頁（PRD REQ-C2 Statistics 統計視圖）。
//
// 本頁是既有帳本與能力表的**只讀投影**，設計紀律與後端同一條：
// 1. 展示層只說帳本說過的話——每個數字旁邊給出帳本行 id（滑過可見全部樣本）；
// 2. 樣本不足畫「資料不足」，不畫 0（0% 是一句假話）；
// 3. 渠道判活三態原樣畫出，unknown（無法判定）絕不被折疊成「不可用」或「正常」；
// 4. 空窗口不畫假曲線：沒有帳本行就直接說「窗口內沒有任何已落帳記錄」。
//
// 樣式跟隨既有 admin 面板（AdminPoolManager / AdminHome 的扁平 token），
// 不引入 Liquid Glass 材料，避免管理面出現第二套視覺語言。
//
// 文案紀律：本元件零硬編用戶可見字串，全部經 `text()` 取自 src/lib/ui-strings.ts
// （守門件 src/lib/ui-strings.test.ts 去註解後禁 CJK）。帳本／能力表回傳的字串
// （notes / reason / metric / label）是上游資料，不屬本層文案。

import { useEffect, useState } from "react";
import { BarChart3, CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { NUMBER_LOCALE, text, type UiStringKey } from "@/lib/ui-strings";
import type {
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
  sources: StatisticsSourceRow[];
  notes: string[];
}

type ModelAvailability = "available" | "unavailable" | "unknown";

const WINDOW_OPTIONS = [1, 7, 14, 30] as const;

/**
 * 三態標籤（展示層話術，只在這裡取用）。unknown 是誠實第三態，不併入任何一邊。
 * 渠道判活與模型活性是同一組三態，共用一張表＝話術只有一處。
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

/** 樣本足夠才給比率；否則明寫「資料不足（n/min）」——不回落成 0。 */
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

/** 帳本行 id 對照：顯示首條，滑過可見全部樣本。 */
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
  const [payload, setPayload] = useState<StatisticsPayload | null>(null);
  const [modelStatus, setModelStatus] = useState<Record<string, ModelAvailability> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (windowDays: number) => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, modelsRes] = await Promise.all([
        fetch(`/api/admin/statistics?days=${windowDays}`, { cache: "no-store" }),
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
      // 模型三态直接消费既有的公开端點（与 /v1/model-status 同一份判活），本页不重算。
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
    void load(days);
  }, [days]);

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
          <div className="flex items-center gap-2">
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
              onClick={() => void load(days)}
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
