// GET /api/user/model-eta — 每個模型成功生成的耗時 p80（最近 24h，最近 200 條遙測事件）。
//
// 供 C 端進度條 ETA 消費：普通模式生成前拉一次，用 p80 當進度條滿格時長，
// 讓流逝貼近該模型的真實節奏。ETA 本身不顯示給用戶。
//
// 數據源與 /admin 模型分布、/v1/model-status last_24h 同輪（generation_attempt
// latency_ms → RoutingEvent.attempts[].ms → summarizeRecentModelStats），無需
// 新增任何記錄——數據飛輪已在轉，這裡只是開一個只讀出口。
//
// 公開無 auth：回應只有聚合延遲數字與樣本量，不含渠道/帳號等敏感面。
// 模組級緩存 60 秒，與 model-status 的 recentStats 緩存同節奏。

import { NextResponse } from "next/server";
import { listRoutingEvents, summarizeRecentModelStats } from "@/lib/routing-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

const ETA_TTL_MS = 60_000;
const ETA_EVENT_LIMIT = 200;
// CDN：60s 新鮮，之後 10 分鐘內先回舊值、背景重算（效能審計 P1-E：冷 MISS 實測 1.6–1.9s，ETA 是加分項不必等）。
const ETA_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=600";

let etaCache: { expiresAt: number; data: Record<string, number> } | null = null;

export async function GET() {
  const now = Date.now();
  if (etaCache && etaCache.expiresAt > now) {
    return NextResponse.json({ models: etaCache.data }, { headers: { "Cache-Control": ETA_CACHE_CONTROL } });
  }
  // 遙測讀取失敗回空表（ETA 是加分項，絕不讓它把端點打掛）——調用方
  // 拿不到 p80 就沿用原本的固定 duration。
  const stats = await listRoutingEvents(ETA_EVENT_LIMIT)
    .then((events) => summarizeRecentModelStats(events, Date.now()))
    .catch((error) => {
      console.error("[model-eta] routing events unavailable:", error);
      return [];
    });
  const data: Record<string, number> = {};
  for (const stat of stats) {
    if (stat.p80_latency_ms != null) data[stat.modelId] = stat.p80_latency_ms;
  }
  etaCache = { expiresAt: now + ETA_TTL_MS, data };
  return NextResponse.json({ models: data }, { headers: { "Cache-Control": ETA_CACHE_CONTROL } });
}
