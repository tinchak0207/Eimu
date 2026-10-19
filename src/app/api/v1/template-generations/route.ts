// POST /v1/template-generations — B 端模板生成。
//
// 2026-08-05：原先只在 VPS 上，扣费空转。定价改走 generationCoins(pixai-template)，
// 该键同时建入目录（见 generation-model-catalog.ts），admin 可覆写。
// 错误体与 trace id 与 /v1/images/generations 对齐。

import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_TEMPLATE_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  jsonWithTrace,
  pixaiAuthError,
  pixaiError,
  pixaiRequestError,
  proxyPixai,
} from "@/lib/pixai-proxy";
import { commitSyncCharge, refundSyncCharge, reserveSyncCharge } from "@/lib/generation-core/sync-charge";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { getOrCreateTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return jsonWithTrace(
      pixaiAuthError(auth.status, auth.message, auth.code, traceId),
      auth.status,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonWithTrace(pixaiRequestError("Invalid JSON body.", "invalid_json", traceId), 400, traceId);
  }

  const image = typeof body.image === "string" ? body.image.trim() : "";
  const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
  const presetKey = typeof body.presetKey === "string" ? body.presetKey.trim() : "";
  if (!image) {
    return jsonWithTrace(pixaiRequestError("image is required.", "missing_image", traceId), 400, traceId);
  }
  if (!sceneId || !presetKey) {
    return jsonWithTrace(
      pixaiRequestError("sceneId and presetKey are required.", "missing_template", traceId),
      400,
      traceId,
    );
  }

  const size = body.size === "2k" ? "2k" : "1k";
  const n = Math.min(6, Math.max(1, Number(body.n) || 1));

  await syncModelPricing();
  const quota = Math.round(generationCoins(PIXAI_TEMPLATE_MODEL_ID, { resolution: size }) * QUOTA_PER_COIN) * n;

  // 钱走生产平面帐本（V-07）：同步 job 列 + billing_operation，失败退款可被 reconcile 捞回。
  const charged = await reserveSyncCharge({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "template-generations",
    modelId: PIXAI_TEMPLATE_MODEL_ID,
    kind: "image_generate",
    source: "biz",
    tenantId: `biz:${auth.key.id}`,
    apiKeyId: auth.key.id,
    prompt: typeof body.subject === "string" ? body.subject : "",
    requestedCount: n,
    resolution: size,
    ratio: typeof body.ratio === "string" ? body.ratio : null,
  });
  if (!charged.ok) return jsonWithTrace(charged.body, charged.status, traceId);

  const { status, data } = await proxyPixai("template-generations", {
    image,
    sceneId,
    presetKey,
    subject: typeof body.subject === "string" ? body.subject : undefined,
    ratio: typeof body.ratio === "string" ? body.ratio : undefined,
    size,
    n,
  });

  const delivered = Array.isArray((data as { data?: unknown[] } | null)?.data)
    ? (data as { data: unknown[] }).data.length
    : 0;

  if (status === 200 && delivered > 0) {
    after(await commitSyncCharge(charged.charge, { delivered }));
    recordBizApiKeyUsage(auth.key.id, delivered);
    after(() => flushBizApiKeyUsage().catch(() => undefined));
    return jsonWithTrace(data, 200, traceId);
  }

  after(await refundSyncCharge(charged.charge, { status }));
  return jsonWithTrace(
    pixaiError(data, "Template generation failed.", traceId),
    status >= 400 ? status : 502,
    traceId,
  );
}
