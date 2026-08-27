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
import { listRoutingEvents, summarizeRecentModelStats, type ModelRecentStats } from "@/lib/routing-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 近 24h 表現統計：與探測緩存同節奏（60 秒），「时不时记录」不需要秒級實時。 */
const RECENT_STATS_TTL_MS = 60_000;
const RECENT_STATS_EVENT_LIMIT = 200;
let recentStatsCache: { expiresAt: number; stats: ModelRecentStats[] } | null = null;

/**
 * 每模型的 last_24h 統計（jobs/delivered/failed/success_rate/refunded）。
 * 數據源與 /admin 模型使用分布同輪（listRoutingEvents + 純函數統計），遙測讀取
 * 失敗時回空列表——統計是加分項，絕不讓它把 model-status 打掛。
 */
async function getRecentModelStats(): Promise<ModelRecentStats[]> {
  const now = Date.now();
  if (recentStatsCache && recentStatsCache.expiresAt > now) return recentStatsCache.stats;
  const stats = await listRoutingEvents(RECENT_STATS_EVENT_LIMIT)
    .then((events) => summarizeRecentModelStats(events, now))
    .catch(() => []);
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
  const snapshot = await probeAllModelsStatus({ env: process.env, pools, overrides });

  // 每模型追加 last_24h（最近 24h 真實表現統計）。窗口内無樣本的模型不帶該字段——
  // 沒數據就誠實地不裝有數據，agent 憑 availability 判斷。
  const statsByModel = new Map(recentStats.map((stats) => [stats.modelId, stats]));
  const models = snapshot.models.map((model) => {
    const last24h = statsByModel.get(model.id);
    return last24h ? { ...model, last_24h: last24h } : model;
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
