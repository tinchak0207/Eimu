import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reconcileMapayOrders } from "@/lib/generation-core/mapay-order-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（支付商／控面 DB／new-api）都在矽谷，同区省一趟横跨美国

/**
 * mPay 付款健康探针（**只读，永不写入**）。
 *
 * 生产实证（2026-10-04）：上游 `act=order` 是「按单号单查」不是列表端点，且成功码是 1
 * （code=0 是失败）。旧版把 code=0 当成「成功但 data 空」并回 healthy——那是比没有探针
 * 更糟的**假阳性**。现行诚实口径：
 *
 *   只有「确实查到 ≥1 笔支付商已付款的单，且全部已履约」才算 healthy（HTTP 200）。
 *   以下任一情形一律 **非 200（503）**：
 *     - 控制面 DB 或支付商凭证不可用（configured=false）
 *     - 看不到任何订单实体（candidates=0 或全部查无 ⇒ upstream_empty）
 *     - 逐笔查询失败（query_errors 非空）
 *     - 履约证据读不到（evidence_unreadable 非空）
 *     - 有 paid_unfulfilled > 0 或未定（unknown）> 0
 *
 * 显式探针（只读）：`?orders=IMGMU7UH9SFF9A21D`（逗号分隔多笔）→ 只查这些指定单号并回报，
 * 供 orchestrator 验证历史单。**不是自动补交付**——本端点没有任何写入副作用。
 *
 * 鉴权分级（S-06，2026-11-03）：
 *   - 带 `Authorization: Bearer ${CRON_SECRET}`（常数时间比较；CRON_SECRET 未配置＝一律视为无密钥）
 *     → 完整报告，允许 `?orders=` 显式查询，单次最多 MAX_EXPLICIT_ORDERS 个，超出**截断**。
 *   - 无密钥／密钥错误 → 忽略 `orders`，只回粗粒度状态与计数（gatus 判定用的
 *     `configured`、`paid_unfulfilled` 保留为数字），不回单号、不回原始 error.message／notes／query_errors 内容；
 *     HTTP 状态码语义不变（healthy 200 / 其余 503）。无密钥结果在进程内缓存 30 秒（自 settle 起算；在途期间一律复用，55 秒超时兜底按 degraded 处理），
 *     避免匿名请求放大成对支付商的查询。
 */
const MAX_EXPLICIT_ORDERS = 20;
const ANON_CACHE_TTL_MS = 30_000;
const ANON_INFLIGHT_TIMEOUT_MS = 55_000;

interface HealthResult {
  body: Record<string, unknown>;
  status: number;
}
// 匿名粗粒度结果缓存：含异常路径（同样 30 秒，且不含 error.message），并缓存「进行中的 Promise」合并并发。
// settledAt=null 表示仍在途：在途期间一律复用（不论过了多久），TTL 从 settle 时刻起算。
let anonCache: { settledAt: number | null; promise: Promise<HealthResult> } | null = null;

const ANON_TIMEOUT_RESULT: HealthResult = {
  body: { ok: false, healthy: false, status: "degraded" },
  status: 503,
};

function startAnonHealth(): NonNullable<typeof anonCache> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HealthResult>((resolve) => {
    timer = setTimeout(() => resolve(ANON_TIMEOUT_RESULT), ANON_INFLIGHT_TIMEOUT_MS);
  });
  // 底层 reconcile 无法取消：超时后缓存项已 settle 并进入 TTL，但在 TTL 内不会再起新的。
  const entry: NonNullable<typeof anonCache> = {
    settledAt: null,
    promise: Promise.race([buildHealth(false, undefined), timeout]).finally(() => {
      clearTimeout(timer);
      entry.settledAt = Date.now();
    }),
  };
  return entry;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// 先各自 sha256 再 timingSafeEqual：天然等长、与字符/字节长度无关，非 ASCII 输入也不会抛 RangeError。
function probeAuthorized(request: Request): boolean {
  try {
    const expected = (process.env.CRON_SECRET ?? "").trim();
    if (!expected) return false;
    const header = request.headers.get("authorization") ?? "";
    const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
    return timingSafeEqual(sha256(expected), sha256(actual));
  } catch {
    return false;
  }
}

async function buildHealth(authorized: boolean, explicitOrders: string[] | undefined): Promise<HealthResult> {
  try {
    const report = await reconcileMapayOrders({}, explicitOrders?.length ? { orders: explicitOrders } : {});
    const healthy =
      report.configured &&
      report.checked >= 1 &&
      report.paidUnfulfilled.length === 0 &&
      report.unknown.length === 0 &&
      !report.residue.upstreamEmpty &&
      report.residue.evidenceUnreadable.length === 0 &&
      report.residue.queryErrors.length === 0;
    const status = !report.configured ? "unavailable" : healthy ? "healthy" : "degraded";
    const coarse = {
      ok: healthy,
      healthy,
      status,
      generated_at: report.generatedAt,
      configured: report.configured,
      checked: report.checked,
      fulfilled: report.fulfilled,
      paid_unfulfilled: report.paidUnfulfilled.length,
      unknown: report.unknown.length,
    };
    const body = authorized
      ? {
          ...coarse,
          window: report.window,
          explicit_probe: report.explicitProbe,
          last_fulfilled_at: report.lastFulfilledAt,
          candidates: report.residue.candidates,
          found: report.residue.found,
          not_found: report.residue.notFound,
          query_errors: report.residue.queryErrors,
          upstream_empty: report.residue.upstreamEmpty,
          evidence_unreadable: report.residue.evidenceUnreadable,
          // 未履约单号（供人工处理；不含任何 secret／凭证）。
          paid_unfulfilled_orders: report.paidUnfulfilled.map((finding) => finding.outTradeNo),
          notes: report.notes,
        }
      : coarse;
    return { body, status: healthy ? 200 : 503 };
  } catch (error) {
    // 原始 error.message 可能带上游细节：只在服务端日志留痕，响应里仅对已鉴权调用方回显。
    console.error("[mapay/health]", error);
    return {
      body: {
        ok: false,
        healthy: false,
        status: "unavailable",
        ...(authorized ? { error: error instanceof Error ? error.message : String(error) } : {}),
      },
      status: 503,
    };
  }
}

export async function GET(request: Request) {
  const authorized = probeAuthorized(request);
  const headers = { "Cache-Control": "no-store" };

  if (!authorized) {
    if (!anonCache || (anonCache.settledAt !== null && Date.now() - anonCache.settledAt >= ANON_CACHE_TTL_MS)) {
      anonCache = startAnonHealth();
    }
    const result = await anonCache.promise;
    return NextResponse.json(result.body, { status: result.status, headers });
  }

  const rawOrders = new URL(request.url).searchParams.get("orders");
  const explicitOrders = rawOrders
    ? rawOrders
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, MAX_EXPLICIT_ORDERS)
    : undefined;
  const result = await buildHealth(true, explicitOrders);
  return NextResponse.json(result.body, { status: result.status, headers });
}
