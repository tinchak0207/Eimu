// GET /v1/model-status — 對外、agent-friendly 的模型可用性狀態。
//
// 回傳所有生成模型（image+video）的可用性 + 能力 + 功能標註，讓 AI 助手一眼判斷
// 「哪個模型可用、能幹嘛、調哪個端點」。探測只發 GET {baseURL}/models（渠道的
// /models 清單端點）——不觸發真實生成、不扣費；無 /models 能力的渠道
// 回報 unknown + note，而不是假裝探測失敗。結果模組級緩存 60 秒（probe.cached 指示）。
//
// 認證/限流/錯誤格式與 /v1/system_stats 完全一致：biz key、rate limit headers、
// trace_id、OpenAI 風格 {error:{message,type,code,param,trace_id}} 錯誤體。
//
// 每個模型還會帶 last_24h（最近 24h 真實生圖表現：jobs/delivered/failed/
// success_rate/refunded），數據源與 /admin「模型使用分布」同輪（routing-events
// 遙測），樣本只覆蓋最近 200 條事件，樣本不足時 jobs 如實偏小。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { readAdminPools } from "@/lib/admin-pool-store";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import { probeAllModelsStatus } from "@/lib/model-status-probe";
import { readSupplierHealthSignal } from "@/lib/supplier-health-signal";
import { listRoutingEvents, summarizeRecentModelStats, type ModelRecentStats } from "@/lib/routing-telemetry";
import { summarizeChannelBalance } from "@/lib/routing-balance-signal";
import { readUnavailableModels } from "@/lib/generation-core/model-availability-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 近 24h 表現統計：與探測緩存同節奏（60 秒），「时不时记录」不需要秒級實時。 */
const RECENT_STATS_TTL_MS = 60_000;
const RECENT_STATS_EVENT_LIMIT = 200;
let recentStatsCache: { expiresAt: number; stats: ModelRecentStats[] } | null = null;
let recentEventsCache: { expiresAt: number; events: Awaited<ReturnType<typeof listRoutingEvents>> } | null = null;

/**
 * 每模型的 last_24h 統計（jobs/delivered/failed/success_rate/refunded）。
 * 數據源與 /admin 模型使用分布同輪（listRoutingEvents + 純函數統計），遙測讀取
 * 失敗時回空列表——統計是加分項，絕不讓它把 model-status 打掛。
 */
/** 最近 routing events（60 秒緩存）：last_24h 統計與渠道餘額信號共用一次讀取。 */
async function getRecentRoutingEvents() {
  const now = Date.now();
  if (recentEventsCache && recentEventsCache.expiresAt > now) return recentEventsCache.events;
  const events = await listRoutingEvents(RECENT_STATS_EVENT_LIMIT).catch((error) => {
    console.error("[model-status] routing events unavailable:", error);
    return [] as Awaited<ReturnType<typeof listRoutingEvents>>;
  });
  recentEventsCache = { expiresAt: now + RECENT_STATS_TTL_MS, events };
  return events;
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

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  // 隊列輸入與真實生成路由同源：admin 池 + admin overrides + 本實例 env。
  const [pools, overrides, recentStats] = await Promise.all([
    readAdminPools().catch(() => []),
    getRuntimeChannelOverrides(),
    getRecentModelStats(),
  ]);
  const snapshot = await probeAllModelsStatus({ env: process.env, pools, overrides, recentStats });

  // 每模型追加 last_24h（最近 24h 真實表現統計）。窗口内無樣本的模型不帶該字段——
  // 沒數據就誠實地不裝有數據。availability 已由 probe 層用同一份統計裁決：
  // 近 24h 有真實交付 → available（真實産物是最高證據，GET /models 探測的
  // 404 假陰性不推翻它）；非 OpenAI 兼容渠道（metaso/filmera/adobe2api）探測
  // 無意義，一律 unknown，絕不允許假陰性標 unavailable。
  const statsByModel = new Map(recentStats.map((stats) => [stats.modelId, stats]));
  // R7-E：渠道餘額信號——連續 quota_exhausted 斷流的模型覆寫 availability=unavailable
  // + note「渠道欠費」，agent 提交前就換道，不把任務燒進死隊列。探測/遙測故障 →
  // 空 events → 無信號，不攔任何人。
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
  // 真實結果閘（2026-09-27，model-availability-gate）：近 72h 真實生成全失敗/極低成功率
  // 的模型，提交面會在扣費前拒單——這裡同判 unavailable，agent 不再往死模型投單。
  const breakerUnavailable = await readUnavailableModels().catch(() => new Map<string, string>());
  const models = snapshot.models.map((model) => {
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
  });

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
