// GET /v1/skus — 模板 SKU 目錄（公開，無需鑑權）。
//
// 與 GET /v1/templates（PixAI 上游場景目錄）並存但邊界清晰：這裡列的是我們自有
// 的營銷 SKU——輸入 schema、鏡頭結構、輸出規格、計價模式全部可編程消費，
// 客戶系統可據此自動生成下單表單。目錄只讀不出圖不計費，因此公開。

import { NextRequest, NextResponse } from "next/server";
import { SKU_CATALOG, toPublicSkuView } from "@/lib/sku/catalog";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const response = NextResponse.json(
    {
      object: "list",
      data: SKU_CATALOG.map(toPublicSkuView),
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
  return withTraceId(response, traceId);
}

/** 目錄只讀；非 GET 明確 405，與其他 v1 端點的探測行為一致。 */
export function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  return withTraceId(
    NextResponse.json(
      {
        error: {
          message: "该端点只接受 GET。下单请调用 POST /v1/skus/{sku_id}/runs。",
          type: "invalid_request_error",
          code: "method_not_allowed",
          param: null,
          trace_id: traceId,
        },
      },
      { status: 405 },
    ),
    traceId,
  );
}
