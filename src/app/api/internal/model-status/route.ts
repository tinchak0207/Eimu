// 控制面侧的模型活性内部读取端点（C 端模型选单用）。
//
// 调用方是 Vercel 上的 /api/user/model-status：Vercel 边缘拿不到控制面 Postgres
// （admin pools / routing-events 都在这一侧），也持有不了 biz key，于是走这条
// HMAC 签名通道拿真信号。这里跑的判据与对外 /v1/model-status 完全同源：
// readAdminPools + overrides + last_24h 真实交付统计 + probeAllModelsStatus +
// 渠道余额覆写 + supplier 执行侧同源最终裁决 —— 前端选单看到的就是 AI 助理
// 看到的那把尺。
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（自定义 signatureDomain="model-status"），
// 不回显任何密钥。
//
// 2026-09-27：追加真实结果闸（model-availability-gate）——与提交面拒单同一判定。
//
// 2026-08-30：前端「死活」三态 available/unavailable/unknown；Vercel 侧经
// GENERATION_CONTROL_PLANE_PROXY_ORIGIN 调这里。返回 { ok, models: {modelId: av} }。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { readAdminPools } from "@/lib/admin-pool-store";
import { getRuntimeChannelOverrides } from "@/lib/channel-overrides";
import { probeAllModelsStatus } from "@/lib/model-status-probe";
import { classifyEvidence, readSupplierHealthSignal, type AvailabilityConfidence, type SupplierHealthSignal } from "@/lib/supplier-health-signal";
import { listRoutingEvents, summarizeRecentModelStats, type ModelRecentStats } from "@/lib/routing-telemetry";
import { summarizeChannelBalance } from "@/lib/routing-balance-signal";
import { readUnavailableModels } from "@/lib/generation-core/model-availability-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const SIGNATURE_DOMAIN = "model-status";

const RECENT_STATS_TTL_MS = 60_000;
const RECENT_STATS_EVENT_LIMIT = 200;
let recentStatsCache: { expiresAt: number; stats: ModelRecentStats[] } | null = null;
let recentEventsCache: { expiresAt: number; events: Awaited<ReturnType<typeof listRoutingEvents>> } | null = null;

async function getRecentRoutingEvents() {
  const now = Date.now();
  if (recentEventsCache && recentEventsCache.expiresAt > now) return recentEventsCache.events;
  const events = await listRoutingEvents(RECENT_STATS_EVENT_LIMIT).catch((error) => {
    console.error("[internal/model-status] routing events unavailable:", error);
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
      console.error("[internal/model-status] last_24h stats unavailable:", error);
      return [] as ModelRecentStats[];
    });
  recentStatsCache = { expiresAt: now + RECENT_STATS_TTL_MS, stats };
  return stats;
}

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, message: "签名通道未配置。" }, { status: 503 });

  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  // 队列输入与真实生成路由同源：admin 池 + admin overrides + 本实例 env。
  const [pools, overrides, recentStats] = await Promise.all([
    readAdminPools().catch(() => []),
    getRuntimeChannelOverrides(),
    getRecentModelStats(),
  ]);
  const snapshot = await probeAllModelsStatus({ env: process.env, pools, overrides, recentStats });
  const balanceSignals = summarizeChannelBalance(await getRecentRoutingEvents());
  const supplierSignal: SupplierHealthSignal = await readSupplierHealthSignal().catch(() => ({
    availableByModel: {} as Record<string, boolean>,
    reasonByModel: {} as Record<string, string>,
  }));
  const signalKindByMedia = (media: string): string => (media === "video" ? "video_generate" : "image_generate");
  // 真实结果闸（2026-09-27）：近期真实生成全失败的模型 = 提交面会拒单的模型，
  // 选单必须同判（UI 宣称匹配真实能力）。读取失败 → 空 map，不拦任何模型。
  const breakerUnavailable = await readUnavailableModels().catch(() => new Map<string, string>());

  const models: Record<string, string> = {};
  const confidence: Record<string, AvailabilityConfidence> = {};
  const probeOnly: Record<string, boolean> = {};
  const notes: Record<string, string> = {};
  for (const model of snapshot.models) {
    const balance = balanceSignals.get(model.id);
    let availability = model.availability;
    let note: string | undefined = model.note;
    if (balance) {
      availability = "unavailable";
      note = `渠道欠费：最近连续 ${balance.consecutiveQuotaFailures} 笔上游拒单（余额不足），充值前请换其他模型`;
    }
    const key = `${model.id}:${signalKindByMedia(model.media_type)}`;
    const executionAvailable = supplierSignal.availableByModel[key];
    if (executionAvailable === false) {
      availability = "unavailable";
      note = supplierSignal.reasonByModel[key] ?? "执行侧无可用供应商";
    }
    const breakerReason = breakerUnavailable.get(model.id);
    if (breakerReason) {
      availability = "unavailable";
      note = `${breakerReason}，暂不可用`;
    }
    models[model.id] = availability;
    if (availability === "available") {
      // H4：available 只代表前置条件过；无真实成功证据 → probe_only，不与有证据者同等呈现。
      const recent = recentStats.find((stat) => stat.modelId === model.id);
      const supplierConfidence = classifyEvidence(supplierSignal.evidenceByModel?.[key]);
      const hasEvidence = (recent?.delivered ?? 0) > 0;
      const level: AvailabilityConfidence = hasEvidence
        ? "high"
        : supplierSignal.evidenceByModel
          ? supplierConfidence
          : "probe_only";
      confidence[model.id] = level;
      probeOnly[model.id] = level === "probe_only";
      if (level === "probe_only" && !note) note = "仅通过前置条件探测，无近期成功样本（probe_only）";
    }
    if (note) notes[model.id] = note;
  }

  return NextResponse.json({ ok: true, models, notes, confidence, probe_only: probeOnly });
}
