// GET /api/internal/platform-status —— 服务端实时平台状态（gateway 注入用，2026-10-19）。
//
// 目的：把「此刻哪些模型没有健康供应商/在冷却、近 1 小时哪些模型成功率明显偏低」
// 作为服务端观测注入，替代「用户把节点故障写成记忆、模型再读记忆当事实」。
//
// 鉴权：逐字复用 /api/agent/memory/export 的 HMAC（GET 无 body → 对空 bytes 验签），
// 不自创第二套。
// 数据源：supplier-health-signal（与 worker 调度同一把尺）＋ routing-telemetry
// （近 1 小时；样本 < 5 不下结论）。
// 边界：只回平台级事实——模型 id、可用性原因、成功率与样本数。**绝不回**
// 用户/账号/请求 ID/价格。数据源不可用 → 200 + { lines: [], degraded: true }，
// 不抛、不泄漏内部错误。
//
// 响应形状：`{ lines: string[], generatedAt: string, degraded?: boolean }`，
// 最多 5 行、总长 ≤600 字元（gateway 侧再收口一次）。

import { NextRequest, NextResponse } from "next/server";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { MEMORY_SIGNATURE_HEADER, verifyMemorySignature } from "@/lib/memory-hmac";
import { readSupplierHealthSignal, type SupplierHealthSignal } from "@/lib/supplier-health-signal";
import {
  listRoutingEvents,
  summarizeRecentModelStats,
  type ModelRecentStats,
} from "@/lib/routing-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 gateway/控制面同区

const MAX_LINES = 5;
const MAX_TOTAL_CHARS = 600;
const TRUNC_MARK = "（已截断）";
/** 样本不足不下结论（任务硬约束）。 */
const MIN_SAMPLE = 5;
/** 「成功率明显偏低」门槛：窗口内 <50% 且样本 ≥5。 */
const LOW_SUCCESS_RATE = 0.5;
const WINDOW_MS = 60 * 60 * 1000;

function buildLines(signal: SupplierHealthSignal, stats: ModelRecentStats[]): string[] {
  const lines: string[] = [];
  // 模型当前执行侧无健康供应商/冷却（key 形如 `model:kind`；reason 来自调度同一判据）。
  const unavailable = Object.entries(signal.availableByModel)
    .filter(([, ok]) => !ok)
    .map(([key]) => `${key}（${signal.reasonByModel[key] ?? "执行侧无可用供应商"}）`);
  if (unavailable.length > 0) {
    const shown = unavailable.slice(0, 3).join("、");
    lines.push(`无健康供应商/冷却中：${shown}${unavailable.length > 3 ? ` 等 ${unavailable.length} 项` : ""}`);
  }
  // 近 1 小时成功率偏低（样本数一并写出）。
  const low = stats
    .filter((s) => s.jobs >= MIN_SAMPLE && s.success_rate < LOW_SUCCESS_RATE)
    .sort((a, b) => a.success_rate - b.success_rate)
    .slice(0, 3);
  if (low.length > 0) {
    lines.push(
      `近 1 小时成功率偏低：${low
        .map((s) => `${s.modelId} ${s.delivered}/${s.jobs}（${Math.round(s.success_rate * 100)}%）`)
        .join("、")}`,
    );
  }
  return lines;
}

/** 最多 5 行、总长 ≤600；超限按整行优先、末行截断并标记。 */
function clampLines(lines: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (out.length >= MAX_LINES) break;
    const remaining = MAX_TOTAL_CHARS - used;
    if (remaining <= TRUNC_MARK.length) break;
    if (line.length <= remaining) {
      out.push(line);
      used += line.length;
    } else {
      const clipped = `${line.slice(0, remaining - TRUNC_MARK.length)}${TRUNC_MARK}`;
      out.push(clipped);
      used += clipped.length;
      break;
    }
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = await req.arrayBuffer(); // GET 无 body → 空 bytes 验签
  if (!verifyMemorySignature(raw, req.headers.get(MEMORY_SIGNATURE_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const generatedAt = new Date().toISOString();
  const headers = { "Cache-Control": "no-store" };
  // 数据源不可用（DB/代理未配置）→ 空状态 + degraded，不猜「平台健康」。
  const supplierSourceConfigured =
    generationControlPlaneEnabled() ||
    Boolean(
      process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim() &&
        process.env.GENERATION_BILLING_RELAY_SECRET?.trim(),
    );
  if (!supplierSourceConfigured) {
    return NextResponse.json({ lines: [], generatedAt, degraded: true }, { headers });
  }
  try {
    // 两个数据源互相独立：一侧失败不吞另一侧已拿到的事实。
    const [supplierResult, eventsResult] = await Promise.allSettled([
      readSupplierHealthSignal(),
      listRoutingEvents(200),
    ]);
    const signal: SupplierHealthSignal =
      supplierResult.status === "fulfilled"
        ? supplierResult.value
        : { availableByModel: {}, reasonByModel: {} };
    const events = eventsResult.status === "fulfilled" ? eventsResult.value : [];
    const stats = summarizeRecentModelStats(events, Date.now(), WINDOW_MS);
    const lines = clampLines(buildLines(signal, stats));
    // 2026-10-19 P2-3：任一必需数据源 rejected → degraded（另一侧的事实照常返回，
    // 但必须诚实标注「不完整」）。两侧都读不到（空供应商表 + 零事件）同样按 degraded
    // 处理：没有状态 ≠ 健康。返回一律 200，不抛内部错误。
    const anySourceFailed =
      supplierResult.status === "rejected" || eventsResult.status === "rejected";
    const degraded =
      anySourceFailed ||
      (Object.keys(signal.availableByModel).length === 0 && events.length === 0);
    return NextResponse.json(
      { lines, generatedAt, ...(degraded ? { degraded: true } : {}) },
      { headers },
    );
  } catch {
    return NextResponse.json({ lines: [], generatedAt, degraded: true }, { headers });
  }
}
