// POST /v1/upscale — B 端高清放大。
//
// 2026-08-05：原先只在 VPS 上，且扣費空轉（見 pixai-proxy.ts 頭部說明）。
// 定價走 generationCoins(pixai-upscale)，與 admin 覆寫層同源。
// 錯誤體與 trace id 與 /v1/images/generations 對齊。

import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { declaredUpscaleTiers, generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  jsonWithTrace,
  pixaiAuthError,
  pixaiError,
  pixaiRequestError,
  proxyPixai,
} from "@/lib/pixai-proxy";
import { commitSyncCharge, refundSyncCharge, reserveSyncCharge } from "@/lib/generation-core/sync-charge";
import { resolveUpscaleSubmission, UpscaleTierError } from "@/lib/generation-core/upscale-tier";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { getOrCreateTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import {
  checkOrReserveSyncIdempotency,
  commitSyncIdempotency,
  computeRequestHash,
  SyncIdempotencyConflictError,
} from "@/lib/generation-core/sync-idempotency";

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

  // 認證成功後的所有回應（成功 + 錯誤）都帶限流預測頭；401/403/429 不走這裡。
  const respond = (data: unknown, status: number, headers?: Record<string, string>) =>
    addRateLimitHeaders(jsonWithTrace(data, status, traceId, headers), auth.key);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respond(pixaiRequestError("Invalid JSON body.", "invalid_json", traceId), 400);
  }

  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!image) {
    return respond(pixaiRequestError("image is required.", "missing_image", traceId), 400);
  }

  // 超分檔位（P1-4）：`size` 在此入口是**檔位**語義（1k／2k／4k）；像素尺寸寫法
  // （"1024x1024"）只作計費提示。舊碼 `body.size === "2k" ? "2k" : "1k"` 讓
  // `size:"4k"` 靜默降級成 1k——本刀改成具名拒絕／具名檔位契約。
  let submission: ReturnType<typeof resolveUpscaleSubmission>;
  try {
    submission = resolveUpscaleSubmission({
      declaredTiers: declaredUpscaleTiers(PIXAI_UPSCALE_MODEL_ID),
      modelId: PIXAI_UPSCALE_MODEL_ID,
      input: body,
    });
  } catch (error) {
    if (error instanceof UpscaleTierError) {
      return respond(pixaiRequestError(error.message, error.code, traceId), error.status);
    }
    throw error;
  }
  const size = submission.tier;

  await syncModelPricing();
  const quota = Math.round(generationCoins(PIXAI_UPSCALE_MODEL_ID, { resolution: size }) * QUOTA_PER_COIN);

  // ── 冪等（reserveSyncCharge 之前）：同 key 重試不重複扣費 ──────
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || null;
  let reservedIdempotency: { tenantId: string; key: string } | null = null;
  if (idempotencyKey) {
    const tenantId = `biz:${auth.key.id}`;
    try {
      const outcome = await checkOrReserveSyncIdempotency({
        tenantId,
        idempotencyKey,
        requestHash: computeRequestHash(body),
      });
      if (outcome.cached) return respond(outcome.body, outcome.status);
      reservedIdempotency = { tenantId, key: idempotencyKey };
    } catch (error) {
      if (error instanceof SyncIdempotencyConflictError) {
        return respond(
          {
            error: {
              message: error.message,
              type: "invalid_request_error",
              code: "idempotency_key_conflict",
              param: null,
              trace_id: traceId,
            },
          },
          409,
        );
      }
      throw error;
    }
  }

  // 錢走生產平面帳本（V-07）：同步 job 列 + billing_operation，失敗退款可被 reconcile 撈回。
  const charged = await reserveSyncCharge({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "upscale",
    modelId: PIXAI_UPSCALE_MODEL_ID,
    kind: "image_edit",
    source: "biz",
    tenantId: `biz:${auth.key.id}`,
    apiKeyId: auth.key.id,
    requestedCount: 1,
    resolution: size,
    ratio: typeof body.ratio === "string" ? body.ratio : null,
  });
  if (!charged.ok) return respond(charged.body, charged.status);

  const { status, data } = await proxyPixai("upscale", {
    image,
    // factor 由檔位契約決定（1k／2k⇒2、4k⇒4），不再吃呼叫端任意倍率。
    factor: submission.factor,
    ratio: typeof body.ratio === "string" ? body.ratio : undefined,
    // 只送 bridge 白名單內的 size；4K 靠 (size="2k", factor=4) 表達——
    // 送 "4k" 會被上游靜默回退 1k（見 upscale-tier.ts 檔頭）。
    size: submission.bridgeSize,
  });

  const delivered = Array.isArray((data as { data?: unknown[] } | null)?.data)
    ? (data as { data: unknown[] }).data.length
    : 0;

  if (status === 200 && delivered > 0) {
    after(await commitSyncCharge(charged.charge, { delivered: 1 }));
    recordBizApiKeyUsage(auth.key.id, 1);
    after(() => flushBizApiKeyUsage().catch(() => undefined));
    if (reservedIdempotency) {
      await commitSyncIdempotency({
        tenantId: reservedIdempotency.tenantId,
        idempotencyKey: reservedIdempotency.key,
        status: 200,
        body: data,
      }).catch((error) => {
        console.error(`[pixai] idempotency commit failed action=upscale`, error);
      });
    }
    return respond(data, 200);
  }

  after(await refundSyncCharge(charged.charge, { status }));
  return respond(pixaiError(data, "Upscale failed.", traceId), status >= 400 ? status : 502);
}
