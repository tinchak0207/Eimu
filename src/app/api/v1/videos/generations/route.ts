import { NextRequest, NextResponse } from "next/server";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { readBearerToken, isModelAllowedForKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  aspectRatioFromImageSize,
  generationCoins,
  isSupportedVideoModel,
  normalizeGenerationConfig,
  resolveGenerationModelId,
} from "@/lib/generation-model-catalog";
import { generationControlPlaneEnabled } from "@/lib/generation-core/database";
import { MAX_REQUEST_BATCH_COUNT } from "@/lib/generation-core/request-limits";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { enforceQuotaGate } from "@/lib/generation-core/quota-precheck";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import {
  VideoPostProductionError,
  effectiveVideoPrompt,
  parseVideoPostProduction,
  videoPostProductionGeneratedSeconds,
} from "@/lib/generation-core/video-post-production";
import { publicObjectUrl } from "@/lib/two-phase-upload";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { GENERATION_TRACE_ID_HEADER } from "@/lib/generation-request-headers";
import { syncModelPricing } from "@/lib/pricing-runtime";
import { sanitizeUpstreamBody } from "@/lib/proxy";

export const runtime = "nodejs";
export const maxDuration = 300;
// 与 /api/generate-videos 同区：video durable 任务也常驻 sfo1 worker。
export const preferredRegion = "sfo1";

const MAX_PROMPT_LENGTH = 4_000;
/** 一次请求最多几段视频。再多会顶到上游并发的极限。
 *  值＝数量上限单点（generation-core/request-limits.ts），与 `/v1/models` 的
 *  `x_capabilities.maxBatchCount` 同一颗常数（D23）。
 */
const MAX_N = MAX_REQUEST_BATCH_COUNT;

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_balance"
  | "task_budget_exceeded"
  | "api_error";

/**
 * OpenAI 风格错误体（形状被 v1 contract-lock 钉死，不得改写）。
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

/**
 * 预算超限（W5b）专用 402：标准错误体 + `estimated_coins`/`cap_coins`。
 * 独立于 errorResponse（后者形状被 contract-lock 逐字锁死，不得改写）。
 */
function budgetExceededResponse(
  gate: {
    status: number;
    message: string;
    type: OpenAIErrorType;
    code: string;
    estimated_coins?: number;
    cap_coins?: number;
  },
  traceId: string,
) {
  const response = NextResponse.json(
    {
      error: {
        message: gate.message,
        type: gate.type,
        code: gate.code,
        param: null,
        trace_id: traceId,
        estimated_coins: gate.estimated_coins,
        cap_coins: gate.cap_coins,
      },
    },
    { status: gate.status },
  );
  return withTraceId(response, traceId);
}

interface VideoRequestBody {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  duration_seconds?: unknown;
  generate_audio?: unknown;
  response_format?: unknown;
  callback_url?: unknown;
  /**
   * 生成式后期（P1-3／对称差 D22）：
   *   { mode: "extend_video", source: {url|object_key, duration_seconds}, continue_seconds, continue_from_seconds? }
   *   { mode: "edit_video",  source: {...}, start_seconds, end_seconds, instruction }
   * 不带＝普通生成（零行为变化）。不支援的模型 ⇒ 400 video_generation_type_unsupported。
   */
  video_post_production?: unknown;
  /**
   * 单次任务预算上限（**币**，W5b）：客户宣告后，本次任务估算币值超过它即
   * 402 `task_budget_exceeded`（硬停，不扣费）。未给＝预算闸不启用，行为不变。
   * 非有限数（NaN/Infinity）或非 number 一律视为未宣告（不因坏输入误挡）。
   */
  cap_coins?: unknown;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/** size 参数：兼容 "16:9" 与 "1920x1080" 两种写法，归一成 catalog 的 aspectRatio。 */
function aspectRatioFromVideoSize(size?: string): string | undefined {
  if (!size) return undefined;
  if (/^\d+x\d+$/.test(size)) return aspectRatioFromImageSize(size);
  if (size.includes(":")) return size;
  return undefined;
}

/**
 * POST /v1/videos/generations — OpenAI 兼容的异步视频生成端点，供 API 聚合平台转售。
 *
 * 认证只看 `Authorization: Bearer sk-biz-…`。影片生成只走 durable control plane：
 * 任务被 accepted 后以 202 返回 task，由 worker 异步执行，客户端轮询
 * GET /v1/videos/{id} 与 GET /v1/videos/{id}/result。
 */
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
  let body: VideoRequestBody;
  try {
    body = (await req.json()) as VideoRequestBody;
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  // 生成式后期（局部改片）允许用「改动描述」当 prompt，故其 prompt 检查下移到参数解析后；
  // 普通生成（未带 video_post_production）的检查顺序一字不变（对外稳定承诺）。
  const hasPostProductionRequest = body.video_post_production !== undefined && body.video_post_production !== null;
  if (!hasPostProductionRequest) {
    if (!rawPrompt) {
      return errorResponse(400, "缺少必填参数 prompt。", "invalid_request_error", "missing_prompt", traceId);
    }
    if (rawPrompt.length > MAX_PROMPT_LENGTH) {
      return errorResponse(
        400,
        `prompt 长度不能超过 ${MAX_PROMPT_LENGTH} 个字符。`,
        "invalid_request_error",
        "prompt_too_long",
        traceId,
      );
    }
  }

  const rawModelId = typeof body.model === "string" && body.model ? body.model : "";
  if (!rawModelId) {
    return errorResponse(400, "缺少必填参数 model。", "invalid_request_error", "missing_model", traceId);
  }
  // 宽容解析：`seedance 2.0`（显示名风格分隔符）归一成 `seedance-2.0`，同一模型不因写法被拒。
  const modelId = resolveGenerationModelId(rawModelId) ?? rawModelId;
  if (!isSupportedVideoModel(modelId)) {
    return errorResponse(
      400,
      `不支持的视频模型 ${modelId}。可用模型请调用 GET /v1/models。`,
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

  // 生成式后期（续片／局部改片）：契约校验＋能力闸＋来源影片定位。全部失败都在
  // 建单／扣费／呼叫上游之前——不支援的模型具名拒收，绝不静默降级成普通生成。
  let postProduction: ReturnType<typeof parseVideoPostProduction> = null;
  try {
    postProduction = parseVideoPostProduction(body.video_post_production, {
      modelId,
      resolveObjectKeyUrl: publicObjectUrl,
    });
  } catch (error) {
    if (error instanceof VideoPostProductionError) {
      return errorResponse(error.status, error.message, "invalid_request_error", error.code, traceId);
    }
    throw error;
  }
  const prompt = effectiveVideoPrompt(rawPrompt, postProduction);
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

  const rawN = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_N) {
    return errorResponse(400, `n 需为 1 到 ${MAX_N} 之间的整数。`, "invalid_request_error", "invalid_n", traceId);
  }

  // 影片上游只返回 URL（无 b64 通道），强制 url，忽略 b64_json 请求。
  const responseFormat: "url" | "b64_json" = "url";

  // 管理员改价需立即对扣费生效：算价前先把最新定价覆写同步进目录（核心层内部吞错，失败不挡生成）。
  await syncModelPricing();

  // Durable control plane 是影片唯一路径：影片任务无同步回退分支。
  // 本地无 DB 直连时（Vercel 站点常态），转发到控制面的同一路由执行——
  // 认证/计费/提交都在控制面完成，站点只透传请求与响应。
  if (!generationControlPlaneEnabled()) {
    const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/$/, "");
    if (origin) {
      const upstream = await fetch(`${origin}/api/v1/videos/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.get("authorization") ?? "",
          [GENERATION_TRACE_ID_HEADER]: traceId,
          ...(req.headers.get("idempotency-key")
            ? { "Idempotency-Key": req.headers.get("idempotency-key")! }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await upstream.text();
      return new NextResponse(upstream.ok ? payload : sanitizeUpstreamBody(payload), {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          ...(upstream.headers.get("location") ? { Location: upstream.headers.get("location")! } : {}),
        },
      });
    }
    return errorResponse(
      503,
      "Video generation only supports the durable control plane, which is currently unavailable.",
      "api_error",
      "control_plane_unavailable",
      traceId,
    );
  }

  // 时长 / 音讯 / 宽高比 都交给 catalog 归一化：非法值回默认，合法值透传。
  // 生成式后期：本次生成的秒数由续长／区段长决定（已在契约校验时确认落在 catalog 档位），
  // 直接以它做归一化输入——扣费、成本闸、上游拿到的秒数同源。
  const generatedSeconds = postProduction ? videoPostProductionGeneratedSeconds(postProduction) : undefined;
  const normalized = normalizeGenerationConfig(modelId, {
    aspectRatio: aspectRatioFromVideoSize(typeof body.size === "string" ? body.size : undefined),
    durationSeconds: generatedSeconds
      ?? (body.duration_seconds === undefined ? undefined : Number(body.duration_seconds)),
    generateAudio: optionalBoolean(body.generate_audio),
  });

  const callbackUrl = typeof body.callback_url === "string" && body.callback_url.trim()
    ? body.callback_url.trim()
    : null;

  // 手术 P1 计费闸（详见 quota-precheck.ts）：SURGERY_QUOTA_PRECHECK=1 时先做
  // 无状态配额预检——通过 → 以 0 额提交，job 直接进 queued，阻塞式 reserve 整段
  // 跳过（计费交事后投影）；额度不足 → 按现契约 402；上游不可达 → 原样回落
  // 下方 reserve 路径。env 未设 = 金额原样，路径一字不变。
  const baseBillingAmount = generationCoins(modelId, {
    resolution: normalized.config.outputResolution,
    durationSeconds: normalized.config.durationSeconds,
    generateAudio: normalized.config.generateAudio,
  }) * QUOTA_PER_COIN * rawN;
  // 单次任务预算（币，W5b）：客户宣告才启用；非法/非有限数视为未宣告（不误挡）。
  // 判定（估算 vs cap）在 quota-precheck 内走 task-budget 的 exceedsBudget 单一真源。
  const budgetCapCoins =
    typeof body.cap_coins === "number" && Number.isFinite(body.cap_coins) ? body.cap_coins : undefined;
  const gate = await enforceQuotaGate({
    bizKeyId: apiKey.id,
    billingUserId: apiKey.userId,
    baseBillingAmount,
    budgetCapCoins,
  });
  if (!gate.ok) {
    // 预算超限：带上估算与上限（其余错误码走标准错误体，行为逐位不变）。
    if (gate.code === "task_budget_exceeded") {
      return budgetExceededResponse(gate, traceId);
    }
    return errorResponse(gate.status, gate.message, gate.type, gate.code, traceId);
  }

  try {
    const submitted = await submitGenerationCommand({
      tenantId: `biz:${apiKey.id}`,
      apiKeyId: apiKey.id,
      billingUserId: apiKey.userId,
      source: "biz",
      idempotencyKey: req.headers.get("idempotency-key"),
      kind: "video_generate",
      modelId,
      prompt,
      ratio: normalized.config.aspectRatio,
      resolution: normalized.config.outputResolution,
      quality: normalized.config.qualityMode,
      workflow: {
        durationSeconds: normalized.config.durationSeconds,
        generateAudio: normalized.config.generateAudio,
        ...(postProduction ? { videoPostProduction: postProduction } : {}),
      },
      responseFormat,
      callbackUrl,
      requestedCount: rawN,
      billingAmount: gate.billingAmount,
    });
    return withTraceId(
      NextResponse.json(generationTaskResponse(submitted.job), {
        status: 202,
        headers: { "Location": `/v1/videos/${submitted.job.id}` },
      }),
      traceId,
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return errorResponse(409, error.message, "invalid_request_error", "idempotency_key_reused", traceId);
    }
    // 模型可用性闸（真实生成结果驱动）：建单/扣费前拒单，沿用既有稳定码 no_endpoints。
    if (error instanceof GenerationModelUnavailableError) {
      return errorResponse(503, error.message, "api_error", "no_endpoints", traceId);
    }
    console.error(`[biz-api] video durable task creation failed requestId=${requestId}`, error);
    return errorResponse(503, "Generation control plane is temporarily unavailable.", "api_error", "control_plane_unavailable", traceId);
  }
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
