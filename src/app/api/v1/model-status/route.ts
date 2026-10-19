// GET /v1/model-status — 对外、agent-friendly 的模型可用性状态。
//
// 回传所有生成模型（image+video）的可用性 + 能力 + 功能标注，让 AI 助手一眼判断
// 「哪个模型可用、能干嘛、调哪个端点」。探测只发 GET {baseURL}/models（渠道的
// /models 清单端点）——不触发真实生成、不扣费；无 /models 能力的渠道
// 回报 unknown + note，而不是假装探测失败。结果模组级缓存 60 秒（probe.cached 指示）。
//
// 认证/限流/错误格式与 /v1/system_stats 完全一致：biz key、rate limit headers、
// trace_id、OpenAI 风格 {error:{message,type,code,param,trace_id}} 错误体。
//
// 每个模型还会带 last_24h（最近 24h 真实生图表现：jobs/delivered/failed/
// success_rate/refunded），数据源与 /admin「模型使用分布」同轮（routing-events
// 遥测），样本只覆盖最近 200 条事件，样本不足时 jobs 如实偏小。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { readAdminPools } from "@/lib/admin-pool-store";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import { probeAllModelsStatus, type ModelStatusEntry } from "@/lib/model-status-probe";
import { readSupplierHealthSignal } from "@/lib/supplier-health-signal";
import { listRoutingEvents, summarizeRecentModelStats, type ModelRecentStats } from "@/lib/routing-telemetry";
import { summarizeChannelBalance } from "@/lib/routing-balance-signal";
import { readUnavailableModels } from "@/lib/generation-core/model-availability-gate";
import { applyModelBiasReset, EMPTY_BIAS_RESET_WATERMARKS, readBiasResetWatermarks } from "@/lib/bias-reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 近 24h 表现统计：与探测缓存同节奏（60 秒），「时不时记录」不需要秒级实时。 */
const RECENT_STATS_TTL_MS = 60_000;
const RECENT_STATS_EVENT_LIMIT = 200;
let recentStatsCache: { expiresAt: number; stats: ModelRecentStats[] } | null = null;
let recentEventsCache: { expiresAt: number; events: Awaited<ReturnType<typeof listRoutingEvents>> } | null = null;

/**
 * 每模型的 last_24h 统计（jobs/delivered/failed/success_rate/refunded）。
 * 数据源与 /admin 模型使用分布同轮（listRoutingEvents + 纯函数统计），遥测读取
 * 失败时回空列表——统计是加分项，绝不让它把 model-status 打挂。
 */
/** 最近 routing events（60 秒缓存）：last_24h 统计与渠道余额信号共用一次读取。 */
async function getRecentRoutingEvents() {
  const now = Date.now();
  if (!recentEventsCache || recentEventsCache.expiresAt <= now) {
    const events = await listRoutingEvents(RECENT_STATS_EVENT_LIMIT).catch((error) => {
      console.error("[model-status] routing events unavailable:", error);
      return [] as Awaited<ReturnType<typeof listRoutingEvents>>;
    });
    recentEventsCache = { expiresAt: now + RECENT_STATS_TTL_MS, events };
  }
  // 渠道 bias 刷新水位（2026-10-12）：渠道修好后被判为「修复前旧证据」的事件不再计入
  // last_24h 统计与欠费信号——否则好渠道要干等 24h 自然过期才被 agent 相信。
  // 水位读取 fail-open（读不到＝原判据）；快取只存原始事件，过滤在返回边界做。
  const watermarks = await readBiasResetWatermarks().catch(() => EMPTY_BIAS_RESET_WATERMARKS);
  return applyModelBiasReset(recentEventsCache.events, watermarks);
}

async function getRecentModelStats(): Promise<ModelRecentStats[]> {
  const now = Date.now();
  if (recentStatsCache && recentStatsCache.expiresAt > now) return recentStatsCache.stats;
  const stats = await getRecentRoutingEvents()
    .then((events) => summarizeRecentModelStats(events, now))
    .catch((error) => {
      console.error("[model-status] last_24h stats unavailable:", error);
      return [] as ModelRecentStats[];
    });
  recentStatsCache = { expiresAt: now + RECENT_STATS_TTL_MS, stats };
  return stats;
}

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * 对外投影（B5，2026-10-09）：剥离只供内部消费的渠道遥测。
 * - `channel_id`（内部供应商渠道标识）不得出现在对外 wire。
 * - `channel_balance`（内部计费余额信号）不得出现在对外 wire；同一资讯已由服务端
 *   生成的 `note`（如「渠道欠费：…」）承载，note 必须保留。
 * probe 层与 internal 面继续保留这两个栏位，只在对外 emit 边界投影；其余栏位
 * （availability/note/last_24h/latency_ms/functions/capabilities…）与顺序逐字节不动。
 */
function toPublicModel(model: ModelStatusEntry & { channel_balance?: unknown }): Omit<
  ModelStatusEntry & { channel_balance?: unknown },
  "channel_id" | "channel_balance"
> {
  const { channel_id: _channelId, channel_balance: _channelBalance, ...safe } = model;
  return safe;
}

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  // 队列输入与真实生成路由同源：admin 池 + admin overrides + 本实例 env。
  const [pools, overrides, recentStats] = await Promise.all([
    readAdminPools().catch(() => []),
    getRuntimeChannelOverrides(),
    getRecentModelStats(),
  ]);
  const snapshot = await probeAllModelsStatus({ env: process.env, pools, overrides, recentStats });

  // 每模型追加 last_24h（最近 24h 真实表现统计）。窗口内无样本的模型不带该字段——
  // 没数据就诚实地不装有数据。availability 已由 probe 层用同一份统计裁决：
  // 近 24h 有真实交付 → available（真实产物是最高证据，GET /models 探测的
  // 404 假阴性不推翻它）；非 OpenAI 兼容渠道（metaso/filmera/adobe2api）探测
  // 无意义，一律 unknown，绝不允许假阴性标 unavailable。
  const statsByModel = new Map(recentStats.map((stats) => [stats.modelId, stats]));
  // R7-E：渠道余额信号——连续 quota_exhausted 断流的模型覆写 availability=unavailable
  // + note「渠道欠费」，agent 提交前就换道，不把任务烧进死队列。探测/遥测故障 →
  // 空 events → 无信号，不拦任何人。
  const balanceSignals = summarizeChannelBalance(await getRecentRoutingEvents());
  // 执行侧同源裁决（2026-08-30）：worker 调度看 supplier_capability + supplier/account
  // health_status + cooldown，而旧探测只看「渠道 GET /models 可达」——两套判据错位：
  // 渠道 /models 200 但账户 cooldown/disabled 时，探测报 available、执行直接死
  // （08-30 事故：AI 依探测 rerun，worker 无可用供应商，任务全 deadline_exceeded）。
  // 这里把 scheduler 的同一把尺（readSupplierHealthSignal）作为最终裁决层：执行侧
  // 没有可用供应商 → 无论探测/余额信号说什么都压成 unavailable（真实产物是历史，
  // 当前能否执行只认控制面健康）。DB 不可达 → 空信号，维持原裁决（fail-open）。
  const supplierSignal = await readSupplierHealthSignal().catch(() => ({
    availableByModel: {} as Record<string, boolean>,
    reasonByModel: {} as Record<string, string>,
  }));
  // probe 的 media_type 是 "image"/"video"；signal 的 kind 是 "image_generate"/"video_generate"。
  const signalKindByMedia = (media: string): string => (media === "video" ? "video_generate" : "image_generate");
  // 真实结果闸（2026-09-27，model-availability-gate）：近 72h 真实生成全失败/极低成功率
  // 的模型，提交面会在扣费前拒单——这里同判 unavailable，agent 不再往死模型投单。
  const breakerUnavailable = await readUnavailableModels().catch(() => new Map<string, string>());
  const models = snapshot.models.map((model) => {
    // …内部裁决（见下）在 `model` 上叠加 availability/note/last_24h/channel_balance；
    // 最后的 toPublicModel 会统一投影掉内部渠道遥测。
    const last24h = statsByModel.get(model.id);
    const base = last24h ? { ...model, last_24h: last24h } : model;
    const balance = balanceSignals.get(model.id);
    const withBalance = balance
      ? {
          ...base,
          availability: "unavailable" as const,
          note: `渠道欠费：最近连续 ${balance.consecutiveQuotaFailures} 笔上游拒单（余额不足），充值前请换其他模型`,
          channel_balance: balance,
        }
      : base;
    // 执行侧最终裁决：无可用供应商则不可用（覆盖探测/余额的一切乐观结论）。
    const breakerReason = breakerUnavailable.get(model.id);
    if (breakerReason) {
      return { ...withBalance, availability: "unavailable" as const, note: `${breakerReason}，暂不可用，请换其他模型` };
    }
    const key = `${model.id}:${signalKindByMedia(model.media_type)}`;
    const executionAvailable = supplierSignal.availableByModel[key];
    if (executionAvailable === false) {
      const reason = supplierSignal.reasonByModel[key] ?? "执行侧无可用供应商";
      return { ...withBalance, availability: "unavailable" as const, note: `${reason}，请稍后重试或换其他模型` };
    }
    return withBalance;
  }).map(toPublicModel);

  const response = addRateLimitHeaders(
    NextResponse.json(
      { object: "model_status", ...snapshot, models },
      { headers: { "Cache-Control": "no-store" } },
    ),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}
