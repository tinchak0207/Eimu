import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@/lib/blob-backend";
import type { GenerationAttemptSummary } from "./generation-core/job-repository";
import type { GenerationJob } from "./generation-core/types";

/**
 * Routing telemetry: the persistence layer behind "/admin shows what production
 * actually routed". Every generation request records one event here; /admin reads
 * them back. This module is the evidence chain, so it must never lie by omission
 * (drop events silently) and never get in the way (block generation on a
 * telemetry failure).
 */

// @vercel/blob 預設重試 10 次（指數退避總計可達 ~17 分鐘）。遙測是可觀測性，
// 不是正確性——絕不允許它把生成請求拖進 maxDuration 硬殺（那會反過來吞掉退款）。
// 每個 Blob 操作都帶硬超時，超時就放棄這筆遙測。
const TELEMETRY_BLOB_TIMEOUT_MS = 5_000;

const EVENT_PREFIX = "admin/routing-events/";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** Prune target: keep at most this many event blobs under the prefix. */
const MAX_STORED_EVENTS = 400;
/** Each write rolls this dice to prune, so cleanup cost is amortized across lambdas. */
const PRUNE_PROBABILITY = 0.05;
/**
 * Without BLOB_READ_WRITE_TOKEN we keep a module-scoped ring buffer instead of
 * throwing — telemetry is observability, and missing storage must never block
 * generation. (Deliberately different from config stores, which throw in prod:
 * losing telemetry is survivable, silently running on wrong config is not.)
 */
const MEMORY_RING_LIMIT = 100;

export interface RoutingAttempt {
  label: string;
  host: string;
  ok: boolean;
  ms: number;
  status?: number;
  reason?: string;
}

export interface RoutingQueueEntry {
  label: string;
  host: string;
  priority?: number;
  cooling?: boolean;
}

export type RoutingOutcome = "delivered" | "exhausted" | "cancelled" | "budget-exhausted" | "no-endpoints";

export interface RoutingEvent {
  id: string;
  ts: number;
  requestId: string;
  pipeline: "user" | "biz";
  modelId: string;
  qualityMode: string;
  /** 真实分辨率档位（1k/2k/4k/360p 等），供 /admin 首屏矩形树状图按模型细分参数占比。旧事件或不带分辨率概念的管线（biz 聚合 API）留空。 */
  resolution?: string;
  queue: RoutingQueueEntry[];
  attempts: RoutingAttempt[];
  outcome: RoutingOutcome;
  deliveredBy?: string;
  totalMs: number;
  coins: number;
  refunded: boolean;
  bypassBilling?: boolean;
  /** 真實產出圖片的 public URL（來自 job.result.artifacts）。只有成功且帶 artifact 的事件才有；無則缺省。 */
  imageUrls?: string[];
}

export interface ChannelAggregate {
  label: string;
  host: string;
  attempts: number;
  successes: number;
  failures: number;
  cancelled: number;
  avgOkMs: number | null;
  lastOkTs: number | null;
  lastFailTs: number | null;
}

const memoryEvents: RoutingEvent[] = [];

type EventBlobRef = { url: string; pathname: string };

/** Blob paginates by pathname; ignoring hasMore would silently drop older pages. Walk them all. */
async function listEventBlobs(): Promise<EventBlobRef[]> {
  const blobs: EventBlobRef[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: EVENT_PREFIX, cursor, abortSignal: AbortSignal.timeout(TELEMETRY_BLOB_TIMEOUT_MS) });
    for (const blob of page.blobs) {
      blobs.push({ url: blob.url, pathname: blob.pathname });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

/**
 * Shared by recordRoutingEvent (5% dice) and listRoutingEvents (opportunistic,
 * reusing its already-fetched listing). Deletes the oldest blobs beyond
 * MAX_STORED_EVENTS; the 13-digit timestamp prefix makes pathname order = time
 * order, so a lexicographic sort is a chronological sort. Errors are swallowed —
 * pruning is housekeeping, never worth failing a request over.
 */
async function pruneRoutingEventBlobs(prefetched?: EventBlobRef[]): Promise<void> {
  try {
    const blobs = prefetched ?? (await listEventBlobs());
    if (blobs.length <= MAX_STORED_EVENTS) return;
    const oldestFirst = [...blobs].sort((a, b) => a.pathname.localeCompare(b.pathname));
    const stale = oldestFirst.slice(0, blobs.length - MAX_STORED_EVENTS);
    await del(stale.map((blob) => blob.url), { abortSignal: AbortSignal.timeout(TELEMETRY_BLOB_TIMEOUT_MS) });
  } catch (error) {
    console.error("[routing-telemetry] Failed to prune routing events.", error);
  }
}

/**
 * One blob per event, at a pathname that is unique per write. This is deliberate:
 * concurrent lambdas each append their own blob, so there is no shared document
 * and therefore no read-modify-write race. The zero-padded 13-digit epoch-ms
 * prefix keeps lexicographic pathname order equal to chronological order.
 *
 * Never throws: telemetry failures are logged and dropped, never propagated into
 * the generation path.
 */
export async function recordRoutingEvent(event: RoutingEvent): Promise<void> {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      memoryEvents.push(event);
      if (memoryEvents.length > MEMORY_RING_LIMIT) {
        memoryEvents.splice(0, memoryEvents.length - MEMORY_RING_LIMIT);
      }
      return;
    }

    const pathname = `${EVENT_PREFIX}${String(event.ts).padStart(13, "0")}-${randomBytes(4).toString("hex")}.json`;
    await put(pathname, JSON.stringify(event), {
      abortSignal: AbortSignal.timeout(TELEMETRY_BLOB_TIMEOUT_MS),
      access: "public",
      contentType: "application/json",
      // 60s is the platform floor; pathnames are write-once so staleness cannot occur.
      cacheControlMaxAge: 60,
    });

    if (Math.random() < PRUNE_PROBABILITY) {
      await pruneRoutingEventBlobs();
    }
  } catch (error) {
    console.error("[routing-telemetry] Failed to record routing event.", error);
  }
}

export async function listRoutingEvents(limit: number = DEFAULT_LIST_LIMIT): Promise<RoutingEvent[]> {
  const effectiveLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_LIST_LIMIT);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return [...memoryEvents].sort((a, b) => b.ts - a.ts).slice(0, effectiveLimit);
  }

  const blobs = await listEventBlobs();
  const newestFirst = [...blobs].sort((a, b) => b.pathname.localeCompare(a.pathname)).slice(0, effectiveLimit);

  const parsed = await Promise.all(
    newestFirst.map(async (ref): Promise<RoutingEvent | null> => {
      try {
        const result = await get(ref.url, { access: "public", abortSignal: AbortSignal.timeout(TELEMETRY_BLOB_TIMEOUT_MS) });
        if (!result || result.statusCode !== 200) return null;
        return JSON.parse(await new Response(result.stream).text()) as RoutingEvent;
      } catch {
        // One corrupt blob must not take down the whole admin view.
        return null;
      }
    })
  );

  await pruneRoutingEventBlobs(blobs);

  return parsed.filter((event): event is RoutingEvent => event !== null).sort((a, b) => b.ts - a.ts);
}

/**
 * Pure aggregation, grouped by label+host. A "cancelled" attempt
 * (reason === "cancelled") counts toward `cancelled`, never `failures`: the user
 * closing the page is not the channel's fault, and folding cancellations into
 * failures would make success rates lie. avgOkMs averages successful attempts
 * only; null when the channel has never succeeded.
 */
export function summarizeRoutingEvents(events: RoutingEvent[]): ChannelAggregate[] {
  const byChannel = new Map<string, ChannelAggregate & { okMsTotal: number }>();

  for (const event of events) {
    for (const attempt of event.attempts) {
      const key = JSON.stringify([attempt.label, attempt.host]);
      let aggregate = byChannel.get(key);
      if (!aggregate) {
        aggregate = {
          label: attempt.label,
          host: attempt.host,
          attempts: 0,
          successes: 0,
          failures: 0,
          cancelled: 0,
          avgOkMs: null,
          lastOkTs: null,
          lastFailTs: null,
          okMsTotal: 0,
        };
        byChannel.set(key, aggregate);
      }

      aggregate.attempts += 1;
      if (attempt.ok) {
        aggregate.successes += 1;
        aggregate.okMsTotal += attempt.ms;
        aggregate.lastOkTs = aggregate.lastOkTs === null ? event.ts : Math.max(aggregate.lastOkTs, event.ts);
      } else if (attempt.reason === "cancelled") {
        aggregate.cancelled += 1;
      } else {
        aggregate.failures += 1;
        aggregate.lastFailTs = aggregate.lastFailTs === null ? event.ts : Math.max(aggregate.lastFailTs, event.ts);
      }
    }
  }

  return [...byChannel.values()].map(({ okMsTotal, ...aggregate }) => ({
    ...aggregate,
    avgOkMs: aggregate.successes > 0 ? okMsTotal / aggregate.successes : null,
  }));
}

export interface ModelResolutionCount {
  resolution: string;
  count: number;
}

export interface ModelBreakdown {
  modelId: string;
  total: number;
  resolutions: ModelResolutionCount[];
}

/** 非 delivered 的失败结果统一落进这一个桶，不再按分辨率细分——失败本身才是重点，档位无意义。 */
const FAILED_BUCKET = "失败";

/**
 * 按 modelId 分组统计事件数，组内再分桶——供 /admin 首屏矩形树状图使用：
 * 外层矩形面积 = 模型请求占比，内层矩形面积 = 该模型内「成功按分辨率细分 + 失败合并一桶」占比。
 * 图片生成路由（/api/generate-images）写入真实档位；B 端管线（biz-image-pipeline.ts）
 * 没有真实分辨率概念，按 qualityMode 映射到 1k/2k。只有视频事件仍归入 "未知"。
 */
export function summarizeModelBreakdown(events: RoutingEvent[]): ModelBreakdown[] {
  const byModel = new Map<string, Map<string, number>>();
  for (const event of events) {
    const resolutionCounts = byModel.get(event.modelId) ?? new Map<string, number>();
    const key = event.outcome === "delivered" ? event.resolution ?? "未知" : FAILED_BUCKET;
    resolutionCounts.set(key, (resolutionCounts.get(key) ?? 0) + 1);
    byModel.set(event.modelId, resolutionCounts);
  }
  return [...byModel.entries()]
    .map(([modelId, resolutionCounts]) => ({
      modelId,
      total: [...resolutionCounts.values()].reduce((sum, count) => sum + count, 0),
      resolutions: [...resolutionCounts.entries()]
        .map(([resolution, count]) => ({ resolution, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total);
}

export interface ModelRecentStats {
  modelId: string;
  /** 窗口内该模型的总请求数（含失败）。样本量由消費者自行判斷。 */
  jobs: number;
  delivered: number;
  failed: number;
  /** delivered / jobs；jobs 為 0 時為 0。 */
  success_rate: number;
  /** 窗口内发生退款的事件数（独立于 delivered/failed 计数，單列不併桶）。 */
  refunded: number;
  /**
   * 成功交付事件的耗時 p80（毫秒）——「只有 20% 記錄比它慢」的那條。
   * 樣本取每次 delivered 事件最後一個成功 attempt 的 ms（生成耗时本身，
   * 不含排隊與失敗重試的時間）。成功樣本不足 3 條時為 null。
   * 供進度條 ETA 消費：讓流逝貼近該模型的真實節奏。
   */
  p80_latency_ms: number | null;
}

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 按模型統計最近時間窗口（默認 24h）的真實生圖表現——供 /v1/model-status 的
 * last_24h 字段使用，讓 agent 選模型前能看到歷史成功率，而不是只有可用性布爾值。
 * 與 summarizeModelBreakdown 同源同風格的純函數：delivered 視為成功，其餘
 * outcome（exhausted/cancelled/budget-exhausted/no-endpoints）一律歸 failed；
 * refunded 單列。窗口取 events 的 ts >= nowMs - windowMs；事件樣本只覆蓋
 * listRoutingEvents 取回的條數，窗口不足時 jobs 如實反映樣本量。
 */
export function summarizeRecentModelStats(
  events: RoutingEvent[],
  nowMs: number,
  windowMs: number = DEFAULT_RECENT_WINDOW_MS,
): ModelRecentStats[] {
  const byModel = new Map<string, ModelRecentStats & { deliveredLatencies: number[] }>();
  const cutoff = nowMs - windowMs;
  for (const event of events) {
    if (event.ts < cutoff) continue;
    let stats = byModel.get(event.modelId);
    if (!stats) {
      stats = {
        modelId: event.modelId,
        jobs: 0,
        delivered: 0,
        failed: 0,
        success_rate: 0,
        refunded: 0,
        p80_latency_ms: null,
        deliveredLatencies: [],
      };
      byModel.set(event.modelId, stats);
    }
    stats.jobs += 1;
    if (event.outcome === "delivered") {
      stats.delivered += 1;
      // attempts 按 attempt_no 升冪；最後一個成功的 = 實際交付那次的上游耗時。
      const lastOk = [...event.attempts].reverse().find((attempt) => attempt.ok);
      if (lastOk && lastOk.ms > 0) stats.deliveredLatencies.push(lastOk.ms);
    } else {
      stats.failed += 1;
    }
    if (event.refunded) stats.refunded += 1;
  }
  return [...byModel.values()]
    .map(({ deliveredLatencies, ...stats }) => ({
      ...stats,
      success_rate: stats.jobs > 0 ? stats.delivered / stats.jobs : 0,
      p80_latency_ms: latencyP80(deliveredLatencies),
    }))
    .sort((a, b) => b.jobs - a.jobs);
}

/**
 * 耗時 p80 分位：排序後取 ceil(n*0.8)-1 位置——即「只有 20% 記錄比它慢」的
 * 那條真實記錄。樣本不足 3 條回 null：1-2 條的分位數不穩定，一次偶然慢
 * 會讓 ETA 整體偏慢。
 */
function latencyP80(samples: number[]): number | null {
  if (samples.length < 3) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.8) - 1);
  return sorted[index] ?? null;
}

/**
 * URL 解析失敗時退回原始字串：壞 base_url 只會讓 host 顯示成原文，
 * 絕不讓遙測建構崩潰。
 */
function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * 把 durable control plane（generation-jobs）的執行結果轉譯成 /admin 吃的
 * RoutingEvent。attempts 由 generation_attempt 表而來（status/HTTP/latency/
 * failure_class），queue 依同一組嘗試的 supplier label/host 重建。
 * 純函數：不觸碰 Date.now() 以外的外部狀態，方便單元測試。
 */
export function buildJobRoutingEvent(
  job: GenerationJob,
  attempts: GenerationAttemptSummary[],
  outcome: "delivered" | "exhausted",
  refunded: boolean,
): RoutingEvent {
  const queue: RoutingQueueEntry[] = attempts.map((attempt) => ({
    label: attempt.supplierLabel,
    host: safeHost(attempt.supplierBaseUrl),
  }));
  const routingAttempts: RoutingAttempt[] = attempts.map((attempt) => ({
    label: attempt.supplierLabel,
    host: safeHost(attempt.supplierBaseUrl),
    ok: attempt.status === "succeeded",
    ms: attempt.latencyMs ?? 0,
    ...(attempt.providerHttpStatus != null ? { status: attempt.providerHttpStatus } : {}),
    ...(attempt.failureClass ? { reason: attempt.failureClass } : {}),
  }));
  // deliveredBy = 最後一個成功的嘗試；陣列已是 attempt_no 升冪，反向找第一個 ok。
  const deliveredBy =
    outcome === "delivered"
      ? [...routingAttempts].reverse().find((attempt) => attempt.ok)?.label
      : undefined;
  return {
    id: String(Date.now()) + "-" + job.id,
    ts: Date.now(),
    requestId: job.id,
    pipeline: job.source === "biz" ? "biz" : "user",
    modelId: job.modelId,
    qualityMode: job.quality ?? "fast",
    resolution: job.resolution ?? undefined,
    queue,
    attempts: routingAttempts,
    outcome,
    deliveredBy,
    totalMs: Date.now() - job.createdAt.getTime(),
    coins: job.billingAmount,
    refunded,
    ...(job.result?.artifacts?.length
      ? {
          imageUrls: job.result.artifacts
            .filter((a) => typeof a.url === "string" && a.url.length > 0)
            .map((a) => a.url as string),
        }
      : {}),
  };
}

/**
 * 控制面成功/失敗終態的遙測出口。與 recordRoutingEvent 同一鐵律：遙測絕不 throw，
 * 失敗只 console.error——可以晚到，不可以不寫；不擋路。
 */
export async function emitJobRoutingEvent(input: {
  job: GenerationJob;
  attempts: GenerationAttemptSummary[];
  outcome: "delivered" | "exhausted";
  refunded: boolean;
}): Promise<void> {
  try {
    await recordRoutingEvent(buildJobRoutingEvent(input.job, input.attempts, input.outcome, input.refunded));
  } catch (error) {
    console.error("[routing-telemetry] Failed to emit job routing event.", error);
  }
}
