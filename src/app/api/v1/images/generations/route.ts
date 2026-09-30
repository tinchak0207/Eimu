import { randomUUID } from "node:crypto";
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
import { aspectRatioFromImageSize, resolveGenerationModelId, resolveSubmitResolution } from "@/lib/generation-model-catalog";
import { DURABLE_IMAGE_SIZES } from "@/lib/generation-core/durable-image-sizes";
import { normalizeControlNets, toPixaiControlNets, MAX_CONTROL_NETS } from "@/lib/pixai-controlnets";
import { listCharacterCards } from "@/lib/character-card-store";
import {
  EditInputError,
  generationWorkflowField,
  planBizGenerationInput,
  type BizGenerationInputPlan,
} from "@/lib/biz-image-references";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { MAX_REQUEST_BATCH_COUNT } from "@/lib/generation-core/request-limits";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { enforceQuotaGate, INSUFFICIENT_BALANCE_ERROR } from "@/lib/generation-core/quota-precheck";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { getRuntimeExternalChannelDocument } from "@/lib/external-channels-store";
import { resolveExternalChannelForKey } from "@/lib/external-channels";
import { generateViaExternalChannel } from "@/lib/external-channel-adapter";
import { withApiRejectionTelemetry, type RejectionContext } from "@/lib/api-rejection";

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

/** 已知可交的上游尺寸白名單（唯一真源：generation-core/durable-image-sizes.ts）。 */
const SUPPORTED_SIZES = new Set(DURABLE_IMAGE_SIZES);

/** 拒絕遙測用的路徑。寫死字面量：分組要穩定，不被 rewrite/代理改寫影響。 */
const REJECTION_PATH = "/v1/images/generations";
const DEFAULT_SIZE = "1024x1024";
const MAX_PROMPT_LENGTH = 4_000;
/**
 * 一次请求最多出几张。再多会顶到 maxDuration。
 * 值＝數量上限單點（generation-core/request-limits.ts）——`/v1/models` 的
 * `x_capabilities.maxBatchCount` 揭露的是同一顆常數，不另存第二份（D23）。
 */
const MAX_N = MAX_REQUEST_BATCH_COUNT;

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_balance"
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
  routing_hint?: unknown;
  /**
   * 參考圖（2026-09-25）。元素為 http(s)/data:image URL 字符串，或
   * `{ url, role?, name? }`；`role` 收斂到 `GenerationReference.referenceRole`
   * 的五值值域，其餘一律 `"general"`。上限 5 張（超過 400，不靜默截斷）。
   */
  reference_images?: unknown;
  /**
   * 輸出解析度（2026-09-30）：`"1k"｜"2k"｜"4k"`，顯式檔位優先於 `size`／`quality`。
   * 未給＝沿用舊語義（quality⇒2k、其餘⇒1k）。這是 4K 唯一的提交入口——舊碼把
   * resolution 寫死成 1k/2k，能力面宣告的 4k 根本送不到上游（宣告與行為脫節）。
   */
  resolution?: unknown;
  output_resolution?: unknown;
}

export async function POST(req: NextRequest) {
  // 拒絕遙測：出口統一由包裝層記錄（只記非 2xx；key 只留前 8 位，不記 prompt）。
  const rejection: RejectionContext = {
    rawKey: readBearerToken(req.headers.get("authorization")),
    userId: null,
    model: null,
  };
  return withApiRejectionTelemetry(REJECTION_PATH, rejection, () => handleGeneration(req, rejection));
}

async function handleGeneration(req: NextRequest, rejection: RejectionContext): Promise<Response> {
  const requestId = Math.random().toString(36).slice(2);
  const traceId = getOrCreateTraceId(req);

  // ── 认证 ──────────────────────────────────────────────────
  const auth = await authenticateBizApiKey(rejection.rawKey);
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
  rejection.userId = apiKey.userId;

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

  const rawModelId = typeof body.model === "string" && body.model ? body.model : "";
  rejection.model = rawModelId || null;
  if (!rawModelId) {
    return errorResponse(400, "缺少必填参数 model。", "invalid_request_error", "missing_model", traceId);
  }
  // 宽容解析：显示名风格分隔符（`seedream 2.0`/`image 5 pro`）归一成连字符 id，同一模型不因写法被拒。
  const modelId = resolveGenerationModelId(rawModelId) ?? rawModelId;
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

  // 提交解析度（2026-09-30）：顯式 `resolution`／`size:"4k"`／`size:"4096x4096"` 都能到 4k；
  // 未宣告該檔位的模型具名拒（不靜默降級）。≤3072 的既有尺寸沿用舊品質規則，行為不變。
  const resolutionResult = resolveSubmitResolution(modelId, {
    resolution: body.resolution ?? body.output_resolution,
    size: body.size,
    quality: qualityMode,
  });
  if (!resolutionResult.ok) {
    return errorResponse(400, resolutionResult.message, "invalid_request_error", resolutionResult.code, traceId);
  }
  const submitResolution = resolutionResult.resolution;

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

  // ── 參考圖與行內實體 tag（2026-09-25）─────────────────────────
  //
  // 兩件事在這裡一次做完，結果直接進 submitGenerationCommand：
  //   ① body.reference_images（http(s) 直通 / data:image 落地 Blob 換公網 URL）；
  //   ② prompt 裡的 `@[種類:名稱]`——用呼叫金鑰 owner 的卡庫就地展開成卡的 prompt 片段，
  //      命中的卡的 references 併進 workflow.references（卡的圖在前、顯式參考圖在後）。
  // 形狀校驗在任何 I/O 之前（非法輸入 400 不碰額度）；卡庫讀取失敗只降級不擋生成。
  // 零 token 且零參考圖 → plan 與改動前逐位元等價，`generationWorkflowField` 回空物件，
  // 提交 payload 完全不加 workflow 鍵。
  const idempotencyKeyHeader = req.headers.get("idempotency-key")?.trim() || null;
  let plan: BizGenerationInputPlan;
  try {
    plan = await planBizGenerationInput({
      prompt,
      rawReferenceImages: body.reference_images,
      // 只有 prompt 真的帶 token 時才會被呼叫（零 token 請求不讀卡庫、不加延遲）。
      loadCards: () => listCharacterCards(apiKey.userId),
      tenantId: `biz:${apiKey.id}`,
      idempotencyKey: idempotencyKeyHeader ?? `biz-gen-${randomUUID()}`,
    });
  } catch (error) {
    if (error instanceof EditInputError) {
      return errorResponse(error.status, error.message, "invalid_request_error", error.code, traceId);
    }
    throw error;
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

    // 手術 P1 計費閘（詳見 quota-precheck.ts）：SURGERY_QUOTA_PRECHECK=1 時先做
    // 無狀態配額預檢——通過 → 以 0 額提交，job 直接進 queued，阻塞式 reserve 整段
    // 跳過（計費交事後投影）；額度不足 → 按現契約 402；上游不可達 → 原樣回落
    // 下方 reserve 路徑。env 未設 = 金額原樣，路徑一字不變。
    const baseBillingAmount = imageGenerationCoins(modelId, qualityMode, submitResolution) * QUOTA_PER_COIN * rawN;
    const gate = await enforceQuotaGate({
      bizKeyId: apiKey.id,
      billingUserId: apiKey.userId,
      baseBillingAmount,
    });
    if (!gate.ok) {
      return errorResponse(gate.status, gate.message, gate.type, gate.code, traceId);
    }

    try {
      const submitted = await submitGenerationCommand({
        tenantId: `biz:${apiKey.id}`,
        apiKeyId: apiKey.id,
        billingUserId: apiKey.userId,
        source: "biz",
        idempotencyKey: req.headers.get("idempotency-key"),
        kind: "image_generate",
        // routing_hint:"hub" 僅影響調度偏好（probe 探針用），不改變計費與能力校驗。
        routingClass: modelId === ADOBE_FIREFLY_MODEL_ID
          ? "firefly_only"
          : body.routing_hint === "hub" ? "hub_only" : "generic",
        modelId,
        prompt: plan.prompt,
        size,
        ratio: aspectRatioFromImageSize(size),
        resolution: submitResolution,
        quality: qualityMode,
        responseFormat,
        callbackUrl,
        requestedCount: rawN,
        billingAmount: gate.billingAmount,
        // references 與既有 metadata.controlNets 合成同一個 workflow（互不覆蓋）；
        // 兩者皆無時展開零鍵 —— 提交 payload 與改動前逐位元等價。
        ...generationWorkflowField({ references: plan.references, controlNets: pixaiControlNets }),
      });
      return withTraceId(
        addRateLimitHeaders(
          NextResponse.json(
            {
              ...generationTaskResponse(submitted.job),
              ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
            },
            {
              status: 202,
              headers: { "Location": `/v1/images/${submitted.job.id}` },
            },
          ),
          apiKey,
        ),
        traceId,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return errorResponse(409, error.message, "invalid_request_error", "idempotency_key_reused", traceId);
      }
      // 模型可用性閘（真實生成結果驅動）：建單/扣費前拒單，沿用既有穩定碼 no_endpoints。
      if (error instanceof GenerationModelUnavailableError) {
        return errorResponse(503, error.message, "api_error", "no_endpoints", traceId);
      }
      console.error(`[biz-api] durable task creation failed requestId=${requestId}`, error);
      return errorResponse(503, "Generation control plane is temporarily unavailable.", "api_error", "control_plane_unavailable", traceId);
    }
  }

  // 遺留（非 durable）分支沒有 references 通道：`generateBizImage` 不吃參考圖。
  // 帶了參考圖就誠實失敗（fail-closed）——絕不靜默丟掉參考圖後生出一張不像的圖。
  if (plan.references.length > 0) {
    return errorResponse(
      501,
      "参考图需要生成控制面（GENERATION_CONTROL_PLANE_ENABLED=true 且 GENERATION_DATABASE_URL 已配置）才能使用。",
      "api_error",
      "references_require_control_plane",
      traceId,
    );
  }

  // ── 计费预留 ──────────────────────────────────────────────
  const coinsPerImage = imageGenerationCoins(modelId, qualityMode, submitResolution);
  const totalQuota = coinsPerImage * QUOTA_PER_COIN * rawN;

  // 先查队列再动钱（与 C 端主链路同序）：admin 在路由调度分页停用全部渠道后，
  // 每个请求若先扣全额再走 no-endpoints → 502 → 异步退款，就是纯粹的网关空转，
  // 退款失败还会静默丢钱。空队列直接 502，不碰余额。
  //
  // 兩項讀取互不依賴（內部隊列查詢 vs 外部 channel blob 文件；後者永不拋錯、
  // reserveImageQuota 只用 apiKey.userId），冷啟動無快取時各吃一個往返，
  // Promise.all 省一次串行 RTT；「先查隊列再動錢」順序由 reserveImageQuota
  // 保持在匯合點之後不變。
  const [availableEndpoints, externalDoc] = await Promise.all([
    resolveBizEndpoints(modelId),
    getRuntimeExternalChannelDocument(),
  ]);

  // 外部自定義上游：該金鑰綁定外部 channel 時，即使內部隊列為空也允許轉售（客戶
  // 自帶上游不依賴內部渠道）。resolveExternalChannelForKey 只認 enabled + 白名單命中；
  // 未命中回 null → 走既有內部隊列，行為不變。
  const externalChannel = resolveExternalChannelForKey(externalDoc, apiKey.id);

  if (!availableEndpoints.length && !externalChannel) {
    return errorResponse(502, `没有为 ${modelId} 配置可用的上游端点。`, "api_error", "no_endpoints", traceId);
  }

  try {
    await reserveImageQuota(apiKey.userId, totalQuota);
  } catch (error) {
    const reserveMessage = error instanceof Error ? error.message : "余额不足。";
    // 餘額不足類 → 與控制面閘門（quota-precheck）共用同一份 402 統一契約。
    if (reserveMessage.includes("余额不足")) {
      return errorResponse(
        INSUFFICIENT_BALANCE_ERROR.status,
        INSUFFICIENT_BALANCE_ERROR.message,
        INSUFFICIENT_BALANCE_ERROR.type,
        INSUFFICIENT_BALANCE_ERROR.code,
        traceId,
      );
    }
    // 其他預留失敗（網關不可達／回滾不確定）不是餘額問題：走本路由既有的控制面
    // 不可用契約（與 durable 分支同一組碼），只把真因寫進服務端日誌，不對客戶說謊。
    console.error(`[biz-api] reserve failed requestId=${requestId}: ${reserveMessage}`);
    return errorResponse(
      503,
      "Generation control plane is temporarily unavailable.",
      "api_error",
      "control_plane_unavailable",
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
          prompt: plan.prompt,
        })
      : await generateBizImage({
          modelId,
          prompt: plan.prompt,
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
        // 實體 tag 未命中／卡庫降級等可見性欄位；無事發生時整鍵不出現（零漂移）。
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
      }),
      apiKey,
    ),
    traceId,
  );
}

/** 明确拒绝其他方法，避免聚合平台探测时收到 405 之外的怪结果。 */
export function GET(req: NextRequest) {
  const rejection: RejectionContext = {
    rawKey: readBearerToken(req.headers.get("authorization")),
    userId: null,
    model: null,
  };
  return withApiRejectionTelemetry(REJECTION_PATH, rejection, async () =>
    errorResponse(
      405,
      "该端点只接受 POST。模型列表请调用 GET /v1/models。",
      "invalid_request_error",
      "method_not_allowed",
      getOrCreateTraceId(req),
    ),
  );
}
