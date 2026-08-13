// POST /v1/template-generations — B 端模板生成。
//
// 2026-08-05：原先只在 VPS 上，扣費空轉。定價改走 generationCoins(pixai-template)，
// 該鍵同時建入目錄（見 generation-model-catalog.ts），admin 可覆寫。
// 錯誤體與 trace id 與 /v1/images/generations 對齊。

import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_TEMPLATE_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  chargeBizRequest,
  jsonWithTrace,
  pixaiAuthError,
  pixaiError,
  pixaiRequestError,
  proxyPixai,
  refundBizRequest,
} from "@/lib/pixai-proxy";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { getOrCreateTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const maxDuration = 300;

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

  const charged = await chargeBizRequest({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "template-generations",
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
    const unused = Math.round((quota / n) * (n - delivered));
    if (unused > 0) {
      after(() => refundBizRequest({ ...charged.charge, reservedQuota: unused }, auth.key.userId, "template-generations"));
    }
    recordBizApiKeyUsage(auth.key.id, delivered);
    after(() => flushBizApiKeyUsage().catch(() => undefined));
    return jsonWithTrace(data, 200, traceId);
  }

  after(() => refundBizRequest(charged.charge, auth.key.userId, "template-generations"));
  return jsonWithTrace(
    pixaiError(data, "Template generation failed.", traceId),
    status >= 400 ? status : 502,
    traceId,
  );
}
