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
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { enforceQuotaGate } from "@/lib/generation-core/quota-precheck";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { syncModelPricing } from "@/lib/pricing-runtime";

export const runtime = "nodejs";
export const maxDuration = 300;
// 与 /api/generate-videos 同区：video durable 任务也常驻 sfo1 worker。
export const preferredRegion = "sfo1";

const MAX_PROMPT_LENGTH = 4_000;
/** 一次请求最多几段视频。再多会顶到上游并发的极限。 */
const MAX_N = 4;

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "api_error";

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

interface VideoRequestBody {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  duration_seconds?: unknown;
  generate_audio?: unknown;
  response_format?: unknown;
  callback_url?: unknown;
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

  const rawN = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(rawN) || rawN < 1 || rawN > MAX_N) {
    return errorResponse(400, `n 需为 1 到 ${MAX_N} 之间的整数。`, "invalid_request_error", "invalid_n", traceId);
  }

  // 影片上游只返回 URL（无 b64 通道），强制 url，忽略 b64_json 请求。
  const responseFormat: "url" | "b64_json" = "url";

  // 管理員改價需立即對扣費生效：算價前先把最新定價覆寫同步進目錄（核心層內部吞錯，失敗不擋生成）。
  await syncModelPricing();

  // Durable control plane 是影片唯一路徑：影片任务无同步回退分支。
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
          ...(req.headers.get("idempotency-key")
            ? { "Idempotency-Key": req.headers.get("idempotency-key")! }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await upstream.text();
      return new NextResponse(payload, {
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

  // 時長 / 音訊 / 寬高比 都交给 catalog 归一化：非法值回默认，合法值透传。
  const normalized = normalizeGenerationConfig(modelId, {
    aspectRatio: aspectRatioFromVideoSize(typeof body.size === "string" ? body.size : undefined),
    durationSeconds: body.duration_seconds === undefined ? undefined : Number(body.duration_seconds),
    generateAudio: optionalBoolean(body.generate_audio),
  });

  const callbackUrl = typeof body.callback_url === "string" && body.callback_url.trim()
    ? body.callback_url.trim()
    : null;

  // 手術 P1 計費閘（詳見 quota-precheck.ts）：SURGERY_QUOTA_PRECHECK=1 時先做
  // 無狀態配額預檢——通過 → 以 0 額提交，job 直接進 queued，阻塞式 reserve 整段
  // 跳過（計費交事後投影）；額度不足 → 按現契約 402；上游不可達 → 原樣回落
  // 下方 reserve 路徑。env 未設 = 金額原樣，路徑一字不變。
  const baseBillingAmount = generationCoins(modelId, {
    resolution: normalized.config.outputResolution,
    durationSeconds: normalized.config.durationSeconds,
    generateAudio: normalized.config.generateAudio,
  }) * QUOTA_PER_COIN * rawN;
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
      kind: "video_generate",
      modelId,
      prompt,
      ratio: normalized.config.aspectRatio,
      resolution: normalized.config.outputResolution,
      quality: normalized.config.qualityMode,
      workflow: {
        durationSeconds: normalized.config.durationSeconds,
        generateAudio: normalized.config.generateAudio,
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
    // 模型可用性閘（真實生成結果驅動）：建單/扣費前拒單，沿用既有穩定碼 no_endpoints。
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
