// POST /v1/images/edits — B 端改圖，OpenAI 風格錯誤體。
//
// 2026-08-05：這個路由原先只在 VPS 上，且 `const coins` 算完從未使用（免費出圖）。
// 補回 repo 並把扣費接上 billing relay；定價改為走 generationCoins(pixai-edit)，
// 與 admin /admin 的覆寫層同源，不再用路由內硬編碼的 COINS_BY_SIZE。
//
// 錯誤體與 trace id 與 /v1/images/generations 對齊：客戶不必按端點分兩套解析。
//
// 2026-09-13（暴君裁定「gpt-image-2 就應該支援改圖，後端要跟上了」）：
// 本路由原先只認 pixai bridge 域模型（resolveBridgeModel），非 pixai 一律 400。
// 現在非 pixai 模型改走 durable 控制面改圖管線：kind:"image_edit" 提交任務、
// 202 + Location（與 generations 的任務合同一致）。渠道由 registry claims 決定
// （supplier_capability 表現成實有 gpt-image-2/gemini/flux 系 image_edit enabled 行），
// worker 端 supplier-adapter 已有 references→edits/chat 分支，核心層原生支援
// ——本刀只補 B 端路由這個入口。

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken, isModelAllowedForKey } from "@/lib/biz-api-keys";
import {
  generationCoins,
  aspectRatioFromImageSize,
  resolveGenerationModelId,
} from "@/lib/generation-model-catalog";
import { imageGenerationCoins, isSupportedImageModel, type ModelMode } from "@/lib/provider-config";
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
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { hasGenerationCapability, IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { enforceQuotaGate } from "@/lib/generation-core/quota-precheck";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
// 參考圖 helper（resolveEditReference 及相依的 mimeFromUrl/extensionFor/EditInputError）
// 2026-09-25 整段搬到 lib，generations 路由共用同一份；本路由行為逐位元不變。
import { EditInputError, resolveEditReference } from "@/lib/biz-image-references";
import type { GenerationReference } from "@/lib/generation-core/types";
import type { BizApiKey } from "@/lib/biz-api-keys";

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

  // 模型名歸一：pixai bridge 域（現行 ID、歷史別名與 bridge 名）走原同步鏈；
  // 其餘模型進 durable 控制面改圖分支（2026-09-13，見檔頭）。
  const bridgeModel = resolveBridgeModel(body.model);
  if (bridgeModel === null) {
    return await durableEditBranch({
      body,
      key: auth.key,
      image,
      prompt,
      traceId,
      idempotencyKeyHeader: req.headers.get("idempotency-key"),
      respond,
    });
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

// ── durable 改圖分支（非 pixai 域，2026-09-13）───────────────────
//
// 合同：與 /v1/images/generations 的 durable 分支完全同形——提交任務回 202 +
// Location，客戶輪詢 /v1/images/<task_id> 取成品；計費走 enforceQuotaGate +
// submitGenerationCommand 的事後投影。image 參數收 http(s) URL 或 data:image
// base64（≤4MB，Vercel 請求體限制留餘裕）；渠道可用性以 supplier_capability
// 為準做誠實預檢，杜絕「probe 說可用、結算才死」。

/** 與 generations 同口的上游尺寸白名單；另兼容舊 edits 合同的 "1k"/"2k"。 */
const DURABLE_EDIT_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "2048x2048"]);

async function durableEditBranch(input: {
  body: Record<string, unknown>;
  key: BizApiKey;
  image: string;
  prompt: string;
  traceId: string;
  idempotencyKeyHeader: string | null;
  respond: (data: unknown, status: number, headers?: Record<string, string>) => Response;
}): Promise<Response> {
  const { body, key, image, prompt, traceId, idempotencyKeyHeader, respond } = input;
  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  const modelId = resolveGenerationModelId(rawModel) ?? rawModel;

  if (!generationControlPlaneEnabled() || !modelId || !isSupportedImageModel(modelId)) {
    return respond(
      pixaiRequestError(
        `Unsupported model ${rawModel || "(none)"}. Call GET /v1/models for the available list.`,
        "model_not_found",
        traceId,
      ),
      400,
    );
  }
  if (!isModelAllowedForKey(key, modelId)) {
    return respond(
      {
        error: {
          message: `当前密钥无权调用模型 ${modelId}。`,
          type: "permission_error",
          code: "model_not_permitted",
          param: "model",
          trace_id: traceId,
        },
      },
      403,
    );
  }

  const rawSize = typeof body.size === "string" && body.size ? body.size : "1024x1024";
  const size = rawSize === "1k" ? "1024x1024" : rawSize === "2k" ? "2048x2048" : rawSize;
  if (!DURABLE_EDIT_SIZES.has(size)) {
    return respond(
      pixaiRequestError(
        `不支持的 size ${size}。可选：${[...DURABLE_EDIT_SIZES].join("、")}。`,
        "unsupported_size",
        traceId,
      ),
      400,
    );
  }
  const rawN = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > 4) {
    return respond(pixaiRequestError("n 需为 1 到 4 之间的整数。", "invalid_n", traceId), 400);
  }
  // OpenAI 用 hd/standard，本站內部用 quality/fast（與 generations 同譯法）。
  const qualityMode: ModelMode = body.quality === "hd" || body.quality === "high" ? "quality" : "fast";
  const ratio = aspectRatioFromImageSize(size);
  const resolution = qualityMode === "quality" ? "2k" : "1k";

  const tenantId = `biz:${key.id}`;
  const localIdempotencyKey = idempotencyKeyHeader?.trim() || `biz-edit-${randomUUID()}`;
  let reference: GenerationReference;
  try {
    reference = await resolveEditReference(image, tenantId, localIdempotencyKey);
  } catch (error) {
    if (error instanceof EditInputError) {
      return respond(pixaiRequestError(error.message, error.code, traceId), error.status);
    }
    throw error;
  }

  // 誠實預檢（碰額度之前）：capability 表是調度器的唯一事實源，預檢與提交同參數，
  // 不在這裡攔就會變成「先佔額度、job 進場才 model_unsupported 退款」的殭屍往返。
  const capable = await hasGenerationCapability({
    modelId,
    kind: "image_edit",
    ratio,
    resolution,
    routingClass: "generic",
  });
  if (!capable) {
    return respond(
      pixaiRequestError(
        `模型 ${modelId} 当前没有可用的改圖渠道（image_edit capability 不存在或已停用）。请改用 GET /v1/models 中 edit=true 的模型。`,
        "model_edit_unsupported",
        traceId,
      ),
      400,
    );
  }

  // 管理員改價立即生效：算價前同步最新覆寫（與 generations 同序）。
  await syncModelPricing();
  const baseBillingAmount = imageGenerationCoins(modelId, qualityMode) * QUOTA_PER_COIN * rawN;
  const gate = await enforceQuotaGate({
    bizKeyId: key.id,
    billingUserId: key.userId,
    baseBillingAmount,
  });
  if (!gate.ok) {
    return respond(
      { error: { message: gate.message, type: gate.type, code: gate.code, param: null, trace_id: traceId } },
      gate.status,
    );
  }

  try {
    const submitted = await submitGenerationCommand({
      tenantId,
      apiKeyId: key.id,
      billingUserId: key.userId,
      source: "biz",
      idempotencyKey: idempotencyKeyHeader,
      kind: "image_edit",
      modelId,
      prompt,
      size,
      ratio,
      resolution,
      quality: qualityMode,
      responseFormat: "url",
      requestedCount: rawN,
      billingAmount: gate.billingAmount,
      workflow: { references: [reference] },
    });
    return respond(generationTaskResponse(submitted.job), 202, {
      Location: `/v1/images/${submitted.job.id}`,
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return respond(pixaiRequestError(error.message, "idempotency_key_reused", traceId), 409);
    }
    // 模型可用性閘：建單/扣費前拒單，沿用既有穩定碼 no_endpoints。
    if (error instanceof GenerationModelUnavailableError) {
      return respond(pixaiRequestError(error.message, "no_endpoints", traceId), 503);
    }
    console.error("[images/edits] durable submission failed", error);
    return respond(
      pixaiRequestError("Generation control plane is temporarily unavailable.", "control_plane_unavailable", traceId),
      503,
    );
  }
}
