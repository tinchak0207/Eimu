// GET /v1/skus — 模板 SKU 目录（公开，无需鉴权）。
//
// 与 GET /v1/templates（PixAI 上游场景目录）并存但边界清晰：这里列的是我们自有
// 的营销 SKU——输入 schema、镜头结构、输出规格、计价模式全部可编程消费，
// 客户系统可据此自动生成下单表单。目录只读不出图不计费，因此公开。

import { NextRequest, NextResponse } from "next/server";
import { SKU_CATALOG, toPublicSkuView } from "@/lib/sku/catalog";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

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

/** 目录只读；非 GET 明确 405，与其他 v1 端点的探测行为一致。 */
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
