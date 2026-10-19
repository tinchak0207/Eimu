// GET /api/user/model-eta — 每个模型成功生成的耗时 p80（最近 24h，最近 200 条遥测事件）。
//
// 供 C 端进度条 ETA 消费：普通模式生成前拉一次，用 p80 当进度条满格时长，
// 让流逝贴近该模型的真实节奏。ETA 本身不显示给用户。
//
// 数据源与 /admin 模型分布、/v1/model-status last_24h 同轮（generation_attempt
// latency_ms → RoutingEvent.attempts[].ms → summarizeRecentModelStats），无需
// 新增任何记录——数据飞轮已在转，这里只是开一个只读出口。
//
// 公开无 auth：回应只有聚合延迟数字与样本量，不含渠道/帐号等敏感面。
// 模组级缓存 60 秒，与 model-status 的 recentStats 缓存同节奏。

import { NextResponse } from "next/server";
import { listRoutingEvents, summarizeRecentModelStats } from "@/lib/routing-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const ETA_TTL_MS = 60_000;
const ETA_EVENT_LIMIT = 200;
// CDN：60s 新鲜，之后 10 分钟内先回旧值、背景重算（效能审计 P1-E：冷 MISS 实测 1.6–1.9s，ETA 是加分项不必等）。
const ETA_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=600";

let etaCache: { expiresAt: number; data: Record<string, number> } | null = null;

export async function GET() {
  const now = Date.now();
  if (etaCache && etaCache.expiresAt > now) {
    return NextResponse.json({ models: etaCache.data }, { headers: { "Cache-Control": ETA_CACHE_CONTROL } });
  }
  // 遥测读取失败回空表（ETA 是加分项，绝不让它把端点打挂）——调用方
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
