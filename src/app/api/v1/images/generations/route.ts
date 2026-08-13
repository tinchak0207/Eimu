import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { readBearerToken, isModelAllowedForKey } from "@/lib/biz-api-keys";
import {
  authenticateBizApiKey,
  flushBizApiKeyUsage,
  recordBizApiKeyUsage,
} from "@/lib/biz-api-key-store";
import { generateBizImage, resolveBizEndpoints } from "@/lib/biz-image-pipeline";
import { refundImageQuota, reserveImageQuota } from "@/lib/image-billing";
import { imageGenerationCoins, isSupportedImageModel, type ModelMode } from "@/lib/provider-config";
import { ADOBE_FIREFLY_MODEL_ID } from "@/lib/provider-config";
import { aspectRatioFromImageSize } from "@/lib/generation-model-catalog";
import { normalizeControlNets, toPixaiControlNets, MAX_CONTROL_NETS } from "@/lib/pixai-controlnets";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getRuntimeExternalChannelDocument } from "@/lib/external-channels-store";
import { resolveExternalChannelForKey } from "@/lib/external-channels";
import { generateViaExternalChannel } from "@/lib/external-channel-adapter";

export const runtime = "nodejs";
export const maxDuration = 300;
// 与 /api/generate-images 同区：一次生图要串行打网关三四次（校验、预留、退款），
// 每跳的延迟才是主要成本。
export const preferredRegion = "sfo1";

/**
 * POST /v1/images/generations — OpenAI 兼容的生图端点，供 API 聚合平台转售。
 *
 * 认证只看 `Authorization: Bearer sk-biz-…`，不依赖任何自定义请求头 ——
 * 聚合平台不会替我们转发 `x-user-id`。
 * 计费落在密钥绑定的 New API 用户上，复用已有的预留/退款逻辑。
 */

/** 上游只接受这三种尺寸。 */
const SUPPORTED_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const DEFAULT_SIZE = "1024x1024";
const MAX_PROMPT_LENGTH = 4_000;
/** 一次请求最多出几张。再多会顶到 maxDuration。 */
const MAX_N = 4;

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "api_error";

/**
 * OpenAI 风格的错误体。聚合平台大多按这个结构解析，形状必须对得上 ——
 * 因此这里是在原有 `{ error: { message, type, code, param } }` 上追加
 * `trace_id` 字段，而不是换一套新形状。同一个 trace id 也落进
 * `X-Request-Id` 响应头，方便客户直接从抓包/网络面板里拿。
 */
function errorResponse(
  status: number,
  message: string,
  type: OpenAIErrorType,
  code: string,
  traceId: string,
  headers?: Record<string, string>,
) {
  const response = NextResponse.json(
    { error: { message, type, code, param: null, trace_id: traceId } },
    { status, ...(headers ? { headers } : {}) },
  );
  return withTraceId(response, traceId);
}

interface ImageRequestBody {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  quality?: unknown;
  response_format?: unknown;
  async?: unknown;
  callback_url?: unknown;
  control_nets?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = Math.random().toString(36).slice(2);
  const traceId = getOrCreateTraceId(req);

  // ── 认证 ──────────────────────────────────────────────────
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: OpenAIErrorType =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(
      auth.status,
      auth.message,
      type,
      auth.code,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }
  const apiKey = auth.key;

  // ── 解析请求 ──────────────────────────────────────────────
  let body: ImageRequestBody;
  try {
    body = (await req.json()) as ImageRequestBody;
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return errorResponse(400, "缺少必填参数 prompt。", "invalid_request_error", "missing_prompt", traceId);
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return errorResponse(
      400,
      `prompt 长度不能超过 ${MAX_PROMPT_LENGTH} 个字符。`,
      "invalid_request_error",
      "prompt_too_long",
      traceId,
    );
  }

  const modelId = typeof body.model === "string" && body.model ? body.model : "";
  if (!modelId) {
    return errorResponse(400, "缺少必填参数 model。", "invalid_request_error", "missing_model", traceId);
  }
  if (!isSupportedImageModel(modelId)) {
    return errorResponse(
      400,
      `不支持的模型 ${modelId}。可用模型请调用 GET /v1/models。`,
      "invalid_request_error",
      "model_not_found",
      traceId,
    );
  }
  if (!isModelAllowedForKey(apiKey, modelId)) {
    return errorResponse(
      403,
      `当前密钥无权调用模型 ${modelId}。`,
      "permission_error",
      "model_not_permitted",
      traceId,
    );
  }

  const size = typeof body.size === "string" && body.size ? body.size : DEFAULT_SIZE;
  if (!SUPPORTED_SIZES.has(size)) {
    return errorResponse(
      400,
      `不支持的 size ${size}。可选：${[...SUPPORTED_SIZES].join("、")}。`,
      "invalid_request_error",
      "unsupported_size",
      traceId,
    );
  }

  const rawN = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_N) {
    return errorResponse(400, `n 需为 1 到 ${MAX_N} 之间的整数。`, "invalid_request_error", "invalid_n", traceId);
  }

  // OpenAI 用 hd/standard，本站内部用 quality/fast。
  const qualityMode: ModelMode = body.quality === "hd" || body.quality === "high" ? "quality" : "fast";

  const responseFormat = body.response_format === "url" ? "url" : "b64_json";

  // ControlNet 結構控制。只有 pixai 渠道真正消費這個欄位；其他模型/渠道傳了也
  // 只是多帶一個上游忽略的欄位。清洗規則見 pixai-controlnets.ts——非法形狀直接
  // 400，不默默截斷用戶請求。
  const controlNetsInput = body.control_nets;
  let pixaiControlNets: ReturnType<typeof toPixaiControlNets> | undefined;
  if (controlNetsInput !== undefined) {
    const normalized = normalizeControlNets(controlNetsInput);
    if (normalized.valid.length === 0 || normalized.rejected.length > 0) {
      return errorResponse(
        400,
        `control_nets 需为最多 ${MAX_CONTROL_NETS} 项的数组，每项需含 image（参考图 mediaId 或 URL）与 type（如 canny/depth/openpose）。`,
        "invalid_request_error",
        "invalid_control_nets",
        traceId,
      );
    }
    pixaiControlNets = toPixaiControlNets(normalized.valid);
  }

  // 管理員改價需立即對扣費生效：算價前先把最新定價覆寫同步進目錄（核心層內部吞錯，失敗不擋生成）。
  // 放在計費共同上游：一次同步同時覆蓋 durable branch 的 billingAmount 與 legacy 的 coinsPerImage。
  await syncModelPricing();

  // Durable control plane: accepted generation work is always delivered as a task.
  // The legacy synchronous branch below exists only until production provisions and
  // enables GENERATION_DATABASE_URL + GENERATION_CONTROL_PLANE_ENABLED.
  if (generationControlPlaneEnabled()) {
    const callbackUrl = typeof body.callback_url === "string" && body.callback_url.trim()
      ? body.callback_url.trim()
      : null;
    try {
      const submitted = await submitGenerationCommand({
        tenantId: `biz:${apiKey.id}`,
        apiKeyId: apiKey.id,
        billingUserId: apiKey.userId,
        source: "biz",
        idempotencyKey: req.headers.get("idempotency-key"),
        kind: "image_generate",
        routingClass: modelId === ADOBE_FIREFLY_MODEL_ID ? "firefly_only" : "generic",
        modelId,
        prompt,
        size,
        ratio: aspectRatioFromImageSize(size),
        resolution: qualityMode === "quality" ? "2k" : "1k",
        quality: qualityMode,
        responseFormat,
        callbackUrl,
        requestedCount: rawN,
        billingAmount: imageGenerationCoins(modelId, qualityMode) * QUOTA_PER_COIN * rawN,
        ...(pixaiControlNets
          ? { workflow: { metadata: { controlNets: pixaiControlNets } } }
          : {}),
      });
      return withTraceId(
        addRateLimitHeaders(
          NextResponse.json(generationTaskResponse(submitted.job), {
            status: 202,
            headers: { "Location": `/v1/images/${submitted.job.id}` },
          }),
          apiKey,
        ),
        traceId,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return errorResponse(409, error.message, "invalid_request_error", "idempotency_key_reused", traceId);
      }
      console.error(`[biz-api] durable task creation failed requestId=${requestId}`, error);
      return errorResponse(503, "Generation control plane is temporarily unavailable.", "api_error", "control_plane_unavailable", traceId);
    }
  }

  // ── 计费预留 ──────────────────────────────────────────────
  const coinsPerImage = imageGenerationCoins(modelId, qualityMode);
  const totalQuota = coinsPerImage * QUOTA_PER_COIN * rawN;

  // 先查队列再动钱（与 C 端主链路同序）：admin 在路由调度分页停用全部渠道后，
  // 每个请求若先扣全额再走 no-endpoints → 502 → 异步退款，就是纯粹的网关空转，
  // 退款失败还会静默丢钱。空队列直接 502，不碰余额。
  const availableEndpoints = await resolveBizEndpoints(modelId);

  // 外部自定義上游：該金鑰綁定外部 channel 時，即使內部隊列為空也允許轉售（客戶
  // 自帶上游不依賴內部渠道）。resolveExternalChannelForKey 只認 enabled + 白名單命中；
  // 未命中回 null → 走既有內部隊列，行為不變。
  const externalDoc = await getRuntimeExternalChannelDocument();
  const externalChannel = resolveExternalChannelForKey(externalDoc, apiKey.id);

  if (!availableEndpoints.length && !externalChannel) {
    return errorResponse(502, `没有为 ${modelId} 配置可用的上游端点。`, "api_error", "no_endpoints", traceId);
  }

  try {
    await reserveImageQuota(apiKey.userId, totalQuota);
  } catch (error) {
    return errorResponse(
      402,
      error instanceof Error ? error.message : "余额不足。",
      "insufficient_quota",
      "insufficient_quota",
      traceId,
    );
  }

  // ── 生成 ──────────────────────────────────────────────────
  const images: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> = [];
  const failures: string[] = [];

  // 串行出图：并发会同时打满所有上游端点，反而更容易触发对方限流。
  for (let index = 0; index < rawN; index += 1) {
    const outcome = externalChannel
      ? await generateViaExternalChannel({
          channel: externalChannel,
          modelId,
          prompt,
        })
      : await generateBizImage({
          modelId,
          prompt,
          imageSize: size,
          qualityMode,
          requestId: `${requestId}-${index + 1}`,
          ...(pixaiControlNets ? { controlNets: pixaiControlNets } : {}),
        });

    if (!outcome.ok || !outcome.result) {
      failures.push(...outcome.failures);
      break;
    }

    const { image, imageUrl } = outcome.result;
    if (responseFormat === "url" && imageUrl) {
      images.push({ url: imageUrl });
    } else if (image) {
      images.push({ b64_json: image });
    } else if (imageUrl) {
      // 客户要 b64 但上游只给了 URL：回 URL 比整单失败更有用，
      // 文档里说明这种降级，避免客户端严格按 b64_json 解析时炸掉。
      images.push({ url: imageUrl });
    }
  }

  // ── 退款与响应 ────────────────────────────────────────────
  const delivered = images.length;
  const unusedQuota = coinsPerImage * QUOTA_PER_COIN * (rawN - delivered);

  if (unusedQuota > 0) {
    // 退款不能拖慢响应，也不能因为失败而把成功的结果吞掉。
    after(() =>
      refundImageQuota(apiKey.userId, unusedQuota).catch((error) => {
        console.error(`[biz-api] 退款失败 requestId=${requestId}, userId=${apiKey.userId}, quota=${unusedQuota}`, error);
      }),
    );
  }

  if (!delivered) {
    console.error(`[biz-api] requestId=${requestId}, keyId=${apiKey.id}, model=${modelId}, failures=${failures.join(" | ")}`);
    return errorResponse(
      502,
      `生图失败：${failures.join("；") || "上游无响应"}`,
      "api_error",
      "upstream_failed",
      traceId,
    );
  }

  recordBizApiKeyUsage(apiKey.id, delivered);
  after(() => flushBizApiKeyUsage().catch(() => undefined));

  console.log(
    `[biz-api] requestId=${requestId}, keyId=${apiKey.id}, label=${apiKey.label}, model=${modelId}, n=${rawN}, delivered=${delivered}, coins=${coinsPerImage * delivered}`,
  );

  return withTraceId(
    addRateLimitHeaders(
      NextResponse.json({
        created: Math.floor(Date.now() / 1000),
        data: images,
      }),
      apiKey,
    ),
    traceId,
  );
}

/** 明确拒绝其他方法，避免聚合平台探测时收到 405 之外的怪结果。 */
export function GET(req: NextRequest) {
  return errorResponse(
    405,
    "该端点只接受 POST。模型列表请调用 GET /v1/models。",
    "invalid_request_error",
    "method_not_allowed",
    getOrCreateTraceId(req),
  );
}
