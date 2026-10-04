// GET /v1/skus/runs/:id — run 聚合进度（无状态）。
//
// run 不落新表：run_id 就是幂等键根，镜头任务带 skurun:<run_id>:<index>
// 幂等键落在既有 generation_job 上；这里按前缀捞回任务、按 run 组织聚合视图。
// 聚合数学复用 batch 层的 computeBatchAggregate（同源，不抄第二份）。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { buildSkuRunStatusView, getSkuRunJobs, normalizeRunId } from "@/lib/sku/run-service";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function error(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  // 认证成功后的错误（此处只会是 400/404）也带限流预测头；认证失败不加。
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return error(auth.status, auth.message, auth.code, traceId);

  const { id } = await context.params;
  const runId = normalizeRunId(decodeURIComponent(id));
  if (!runId.ok) return error(400, runId.message, "invalid_run_id", traceId, auth.key);

  if (!generationControlPlaneEnabled()) {
    return error(503, "Generation control plane is temporarily unavailable.", "control_plane_unavailable", traceId, auth.key);
  }

  let jobs;
  try {
    jobs = await getSkuRunJobs(runId.runId, "biz:" + auth.key.id);
  } catch (err) {
    console.error("[sku-run] run status query failed runId=" + runId.runId, err);
    return error(503, "Generation control plane is temporarily unavailable.", "control_plane_unavailable", traceId, auth.key);
  }

  if (jobs.length === 0) {
    return error(
      404,
      "SKU run 不存在（run_id 未提交过，或属于其他密钥）。",
      "run_not_found",
      traceId,
      auth.key,
    );
  }

  const view = buildSkuRunStatusView(runId.runId, jobs);
  const response = addRateLimitHeaders(
    NextResponse.json(view, { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}

/** 明确拒绝其他方法。 */
export function POST(req: NextRequest) {
  return error(
    405,
    "该端点只接受 GET。下单请调用 POST /v1/skus/{sku_id}/runs。",
    "method_not_allowed",
    getOrCreateTraceId(req),
  );
}
