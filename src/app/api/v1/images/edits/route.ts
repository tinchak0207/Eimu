// POST /v1/images/edits — B 端改图，OpenAI 风格错误体。
//
// 2026-08-05：这个路由原先只在 VPS 上，且 `const coins` 算完从未使用（免费出图）。
// 补回 repo 并把扣费接上 billing relay；定价改为走 generationCoins(pixai-edit)，
// 与 admin /admin 的覆写层同源，不再用路由内硬编码的 COINS_BY_SIZE。
//
// 错误体与 trace id 与 /v1/images/generations 对齐：客户不必按端点分两套解析。
//
// 2026-09-13（暴君裁定「gpt-image-2 就应该支援改图，后端要跟上了」）：
// 本路由原先只认 pixai bridge 域模型（resolveBridgeModel），非 pixai 一律 400。
// 现在非 pixai 模型改走 durable 控制面改图管线：kind:"image_edit" 提交任务、
// 202 + Location（与 generations 的任务合同一致）。渠道由 registry claims 决定
// （supplier_capability 表现成实有 gpt-image-2/gemini/flux 系 image_edit enabled 行），
// worker 端 supplier-adapter 已有 references→edits/chat 分支，核心层原生支援
// ——本刀只补 B 端路由这个入口。

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken, isModelAllowedForKey } from "@/lib/biz-api-keys";
import {
  generationCoins,
  aspectRatioFromImageSize,
  resolveGenerationModelId,
  resolveSubmitResolution,
} from "@/lib/generation-model-catalog";
import { imageGenerationCoins, isSupportedImageModel, type ModelMode } from "@/lib/provider-config";
import { DURABLE_IMAGE_SIZES, resolveDurableImageSizeAlias } from "@/lib/generation-core/durable-image-sizes";
import { PIXAI_EDIT_MODEL_ID } from "@/lib/image-model-ids.js";
import {
  jsonWithTrace,
  pixaiAuthError,
  pixaiError,
  pixaiRequestError,
  proxyPixai,
  resolveBridgeModel,
} from "@/lib/pixai-proxy";
import { commitSyncCharge, refundSyncCharge, reserveSyncCharge } from "@/lib/generation-core/sync-charge";
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
// 参考图 helper（resolveEditReference 及相依的 mimeFromUrl/extensionFor/EditInputError）
// 2026-09-25 整段搬到 lib，generations 路由共用同一份；本路由行为逐位元不变。
import { EditInputError, resolveEditReference } from "@/lib/biz-image-references";
import { withApiRejectionTelemetry, type RejectionContext } from "@/lib/api-rejection";
import type { GenerationReference } from "@/lib/generation-core/types";
import type { BizApiKey } from "@/lib/biz-api-keys";

export const runtime = "nodejs";
export const maxDuration = 300;
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 拒绝遥测用的路径。写死字面量：分组要稳定，不被 rewrite/代理改写影响。 */
const REJECTION_PATH = "/v1/images/edits";

export async function POST(req: NextRequest) {
  const rejection: RejectionContext = {
    rawKey: readBearerToken(req.headers.get("authorization")),
    userId: null,
    model: null,
  };
  return withApiRejectionTelemetry(REJECTION_PATH, rejection, () => handleEdit(req, rejection));
}

async function handleEdit(req: NextRequest, rejection: RejectionContext): Promise<Response> {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(rejection.rawKey);
  if (!auth.ok) {
    return jsonWithTrace(
      pixaiAuthError(auth.status, auth.message, auth.code, traceId),
      auth.status,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }
  rejection.userId = auth.key.userId;

  // 认证成功后的所有回应（成功 + 错误）都带限流预测头；401/403/429 不走这里。
  const respond = (data: unknown, status: number, headers?: Record<string, string>) =>
    addRateLimitHeaders(jsonWithTrace(data, status, traceId, headers), auth.key);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respond(pixaiRequestError("Invalid JSON body.", "invalid_json", traceId), 400);
  }
  // 只记客户请求的模型名（未归一）：拒绝遥测里它只是分组线索。
  rejection.model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;

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

  // 模型名归一：pixai bridge 域（现行 ID、历史别名与 bridge 名）走原同步链；
  // 其余模型进 durable 控制面改图分支（2026-09-13，见档头）。
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

  // 算价前先同步 admin 覆写，与 /v1/images/generations 同序。
  await syncModelPricing();
  const quota = Math.round(generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: size }) * QUOTA_PER_COIN) * n;
  if (body.cap_coins != null && (typeof body.cap_coins !== "number" || !Number.isFinite(body.cap_coins) || body.cap_coins < 0 || quota / QUOTA_PER_COIN > body.cap_coins)) {
    return respond(pixaiRequestError("本次权威报价超过单请求硬预算，尚未提交且未扣费。", "task_budget_exceeded", traceId), 402);
  }

  // ── 幂等（reserveSyncCharge 之前）：同 key 重试不重复扣费 ──────
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

  // 钱走生产平面帐本（V-07）：同步 job 列 + billing_operation，失败退款可被 reconcile 捞回。
  const charged = await reserveSyncCharge({
    userId: auth.key.userId,
    quota,
    keyId: auth.key.id,
    action: "images/edits",
    modelId: PIXAI_EDIT_MODEL_ID,
    kind: "image_edit",
    source: "biz",
    tenantId: `biz:${auth.key.id}`,
    apiKeyId: auth.key.id,
    prompt,
    requestedCount: n,
    resolution: size,
    ratio: typeof body.ratio === "string" ? body.ratio : null,
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
    // 少出的图按张退：客户只该为拿到的结果付费（commit 实耗＋未交付部分落 refund op）。
    after(await commitSyncCharge(charged.charge, { delivered }));
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

  after(await refundSyncCharge(charged.charge, { status }));
  return respond(
    pixaiError(data, "Image edit failed.", traceId),
    status >= 400 ? status : 502,
  );
}

// ── durable 改图分支（非 pixai 域，2026-09-13）───────────────────
//
// 合同：与 /v1/images/generations 的 durable 分支完全同形——提交任务回 202 +
// Location，客户轮询 /v1/images/<task_id> 取成品；计费走 enforceQuotaGate +
// submitGenerationCommand 的事后投影。image 参数收 http(s) URL 或 data:image
// base64（≤4MB，Vercel 请求体限制留余裕）；渠道可用性以 supplier_capability
// 为准做诚实预检，杜绝「probe 说可用、结算才死」。

/** 与 generations 同口的上游尺寸白名单（唯一真源）＋旧 edits 合同的 "1k"/"2k" 别写法。 */
const DURABLE_EDIT_SIZES = DURABLE_IMAGE_SIZES;

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
  const size = resolveDurableImageSizeAlias(rawSize) ?? rawSize;
  if (!(DURABLE_EDIT_SIZES as readonly string[]).includes(size)) {
    return respond(
      pixaiRequestError(
        `不支持的 size ${size}。可选：${DURABLE_EDIT_SIZES.join("、")}。`,
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
  // OpenAI 用 hd/standard，本站内部用 quality/fast（与 generations 同译法）。
  const qualityMode: ModelMode = body.quality === "hd" || body.quality === "high" ? "quality" : "fast";
  const ratio = aspectRatioFromImageSize(size);
  // 提交解析度（2026-09-30）：显式 `resolution`／`size:"4k"`／`size:"4096x4096"` 都能到 4k。
  // 与 generations 同一颗严格解析器：未宣告就 400，不静默降到 1k 去卖一个不存在的档位。
  const resolutionResult = resolveSubmitResolution(modelId, {
    resolution: body.resolution ?? body.output_resolution,
    size,
    quality: qualityMode,
  });
  if (!resolutionResult.ok) {
    return respond(pixaiRequestError(resolutionResult.message, resolutionResult.code, traceId), 400);
  }
  const resolution = resolutionResult.resolution;

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

  // 诚实预检（碰额度之前）：capability 表是调度器的唯一事实源，预检与提交同参数，
  // 不在这里拦就会变成「先占额度、job 进场才 model_unsupported 退款」的僵尸往返。
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
        `模型 ${modelId} 当前没有可用的改图渠道（image_edit capability 不存在或已停用）。请改用 GET /v1/models 中 edit=true 的模型。`,
        "model_edit_unsupported",
        traceId,
      ),
      400,
    );
  }

  // 管理员改价立即生效：算价前同步最新覆写（与 generations 同序）。
  await syncModelPricing();
  const baseBillingAmount = imageGenerationCoins(modelId, qualityMode, resolution) * QUOTA_PER_COIN * rawN;
  const gate = await enforceQuotaGate({
    bizKeyId: key.id,
    billingUserId: key.userId,
    baseBillingAmount,
    budgetCapCoins: typeof body.cap_coins === "number" && Number.isFinite(body.cap_coins) ? body.cap_coins : undefined,
  });
  if (!gate.ok) {
    return respond(
      { error: { message: gate.message, type: gate.type, code: gate.code, param: null, trace_id: traceId } },
      gate.status,
    );
  }

  if (body.cap_coins != null && (typeof body.cap_coins !== "number" || !Number.isFinite(body.cap_coins) || body.cap_coins < 0 || baseBillingAmount / QUOTA_PER_COIN > body.cap_coins)) return respond(pixaiRequestError("本次权威报价超过单请求硬预算，尚未提交且未扣费。", "task_budget_exceeded", traceId), 402);

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
      workflow: { ...(typeof body.workflow === "object" && body.workflow ? body.workflow : {}), references: [reference] },
    });
    return respond(generationTaskResponse(submitted.job), 202, {
      Location: `/v1/images/${submitted.job.id}`,
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return respond(pixaiRequestError(error.message, "idempotency_key_reused", traceId), 409);
    }
    // 模型可用性闸：建单/扣费前拒单，沿用既有稳定码 no_endpoints。
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
