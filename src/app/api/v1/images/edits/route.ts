// POST /v1/images/edits — B 端改圖，OpenAI 風格錯誤體。
//
// 2026-08-05：這個路由原先只在 VPS 上，且 `const coins` 算完從未使用（免費出圖）。
// 補回 repo 並把扣費接上 billing relay；定價改為走 generationCoins(pixai-edit)，
// 與 admin /admin 的覆寫層同源，不再用路由內硬編碼的 COINS_BY_SIZE。
//
// 錯誤體與 trace id 與 /v1/images/generations 對齊：客戶不必按端點分兩套解析。

import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { generationCoins } from "@/lib/generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  chargeBizRequest,
  jsonWithTrace,
  pixaiAuthError,
  pixaiError,
  pixaiRequestError,
  proxyPixai,
  refundBizRequest,
  resolveBridgeModel,
} from "@/lib/pixai-proxy";
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
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!image) {
    return respond(pixaiRequestError("image is required.", "missing_image", traceId), 400);
  }
  if (!prompt) {
    return respond(pixaiRequestError("prompt is required.", "missing_prompt", traceId), 400);
  }
  if (prompt.length > 2000) {
    return respond(pixaiRequestError("prompt too long.", "prompt_too_long", traceId), 400);
  }

  // 模型名歸一：認現行 ID、歷史別名與 bridge 名。傳了但不認識的直接 400。
  const bridgeModel = resolveBridgeModel(body.model);
  if (bridgeModel === null) {
    return respond(
      pixaiRequestError(
        `Unsupported model ${String(body.model)}. Call GET /v1/models for the available list.`,
        "model_not_found",
        traceId,
      ),
      400,
    );
  }

  const size = body.size === "2k" ? "2k" : "1k";
  const n = Math.min(4, Math.max(1, Number(body.n) || 1));

  // 算價前先同步 admin 覆寫，與 /v1/images/generations 同序。
  await syncModelPricing();
  const quota = Math.round(generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: size }) * QUOTA_PER_COIN) * n;

  // ── 冪等（chargeBizRequest 之前）：同 key 重試不重複扣費 ──────
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

  const charged = await chargeBizRequest({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "images/edits",
  });
  if (!charged.ok) return respond(charged.body, charged.status);

  const { status, data } = await proxyPixai("images/edits", {
    ...(bridgeModel ? { model: bridgeModel } : {}),
    image,
    prompt,
    ratio: typeof body.ratio === "string" ? body.ratio : undefined,
    size,
    n,
  });

  const delivered = Array.isArray((data as { data?: unknown[] } | null)?.data)
    ? (data as { data: unknown[] }).data.length
    : 0;

  if (status === 200 && delivered > 0) {
    // 少出的圖按張退：客戶只該為拿到的結果付費。
    const unused = Math.round((quota / n) * (n - delivered));
    if (unused > 0) {
      after(() => refundBizRequest({ ...charged.charge, reservedQuota: unused }, auth.key.userId, "images/edits"));
    }
    recordBizApiKeyUsage(auth.key.id, delivered);
    after(() => flushBizApiKeyUsage().catch(() => undefined));
    if (reservedIdempotency) {
      await commitSyncIdempotency({
        tenantId: reservedIdempotency.tenantId,
        idempotencyKey: reservedIdempotency.key,
        status: 200,
        body: data,
      }).catch((error) => {
        console.error(`[pixai] idempotency commit failed action=images/edits`, error);
      });
    }
    return respond(data, 200);
  }

  after(() => refundBizRequest(charged.charge, auth.key.userId, "images/edits"));
  return respond(
    pixaiError(data, "Image edit failed.", traceId),
    status >= 400 ? status : 502,
  );
}
