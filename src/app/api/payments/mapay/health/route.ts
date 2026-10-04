import { NextResponse } from "next/server";
import { reconcileMapayOrders } from "@/lib/generation-core/mapay-order-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（支付商／控面 DB／new-api）都在矽谷，同區省一趟橫跨美國

/**
 * mPay 付款健康探針（**只讀，永不寫入**）。
 *
 * 生產實證（2026-10-04）：上游 `act=order` 是「按單號單查」不是列表端點，且成功碼是 1
 * （code=0 是失敗）。舊版把 code=0 當成「成功但 data 空」並回 healthy——那是比沒有探針
 * 更糟的**假陽性**。現行誠實口徑：
 *
 *   只有「確實查到 ≥1 筆支付商已付款的單，且全部已履約」才算 healthy（HTTP 200）。
 *   以下任一情形一律 **非 200（503）**：
 *     - 控制面 DB 或支付商憑證不可用（configured=false）
 *     - 看不到任何訂單實體（candidates=0 或全部查無 ⇒ upstream_empty）
 *     - 逐筆查詢失敗（query_errors 非空）
 *     - 履約證據讀不到（evidence_unreadable 非空）
 *     - 有 paid_unfulfilled > 0 或未定（unknown）> 0
 *
 * 顯式探針（只讀）：`?orders=IMGMU7UH9SFF9A21D`（逗號分隔多筆）→ 只查這些指定單號並回報，
 * 供 orchestrator 驗證歷史單。**不是自動補交付**——本端點沒有任何寫入副作用。
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
      // 未履約單號（供人工處理；不含任何 secret／憑證）。
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