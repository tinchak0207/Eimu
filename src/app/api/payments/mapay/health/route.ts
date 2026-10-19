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
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawOrders = url.searchParams.get("orders");
  const explicitOrders = rawOrders
    ? rawOrders
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : undefined;

  try {
    const report = await reconcileMapayOrders({}, explicitOrders ? { orders: explicitOrders } : {});
    const healthy =
      report.configured &&
      report.checked >= 1 &&
      report.paidUnfulfilled.length === 0 &&
      report.unknown.length === 0 &&
      !report.residue.upstreamEmpty &&
      report.residue.evidenceUnreadable.length === 0 &&
      report.residue.queryErrors.length === 0;
    const status = !report.configured ? "unavailable" : healthy ? "healthy" : "degraded";
    const body = {
      ok: healthy,
      healthy,
      status,
      generated_at: report.generatedAt,
      window: report.window,
      explicit_probe: report.explicitProbe,
      configured: report.configured,
      checked: report.checked,
      fulfilled: report.fulfilled,
      paid_unfulfilled: report.paidUnfulfilled.length,
      unknown: report.unknown.length,
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
    };
    return NextResponse.json(body, {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        healthy: false,
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}