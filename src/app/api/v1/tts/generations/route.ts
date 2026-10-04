import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { enforceQuotaGate } from "@/lib/generation-core/quota-precheck";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { ttsQuotaForChars } from "@/lib/generation-model-catalog/tts-pricing";
import { TTS_1_MODEL_ID } from "@/lib/image-model-ids";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { normalizeVoiceId } from "@/lib/voice-library";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function errorResponse(
  status: number,
  message: string,
  type: string,
  code: string,
  traceId: string,
  key?: BizApiKey,
) {
  let response: Response = NextResponse.json(
    { error: { message, type, code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * POST /v1/tts/generations — 提交文本转语音任务。
 *
 * kind = "tts"。上游供应商经 channel 配置驱动；未配置 TTS 上游时任务会以
 * 明确的失败分类（supplier_unavailable）终结，而不是悬转——B 端可对账、可重试。
 */
export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    const type: "rate_limit_error" | "permission_error" | "authentication_error" =
      auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
    return errorResponse(auth.status, auth.message, type, auth.code, traceId);
  }
  const apiKey = auth.key;

  let body: { input?: unknown; voice?: unknown; model?: unknown; callback_url?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }

  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (!input) {
    return errorResponse(400, "缺少必填参数 input（要朗读的文本）。", "invalid_request_error", "missing_input", traceId);
  }
  if (input.length > 5000) {
    return errorResponse(400, "input 长度不能超过 5000 个字符。", "invalid_request_error", "input_too_long", traceId);
  }

  // 默认模型＝catalog 真源 id `tts-1`（image-model-ids.js:129 TTS_1_MODEL_ID；
  // catalog.ts:878 kind=audio/pipeline=tts）。旧值 "tts-default" 是 catalog 与任何
  // supplier_capability 都不存在的幻影 id ⇒ 不带 model 的请求必回 model_unsupported。
  const modelId = typeof body.model === "string" && body.model ? body.model : TTS_1_MODEL_ID;
  // 音色（P1-11／D33）：值域收在语音库（`GET /v1/tts/voices`）。
  // 为什么要挡：上游 proxy 对无法辨识的 voice 是**静默回退**的（edge 路径回 DEFAULT_VOICE，
  // SF 路径把不含 ":" 的值改写成 `<model>:alex`）——呼叫端以为指定了音色、实际拿到另一颗。
  // 未带 voice ⇒ 保持既有 `"default"` 行为**逐位不变**（上游自己决定预设，不是本层的决定）。
  const rawVoice = typeof body.voice === "string" ? body.voice.trim() : "";
  if (rawVoice && !normalizeVoiceId(rawVoice)) {
    return errorResponse(
      400,
      `未知的 voice "${rawVoice.slice(0, 60)}"；可用音色见 GET /v1/tts/voices。`,
      "invalid_request_error",
      "voice_unknown",
      traceId,
    );
  }
  const voice = rawVoice || "default";
  const callbackUrl = typeof body.callback_url === "string" ? body.callback_url : null;

  // 计费：TTS 逐字计价（0.001 币/字，唯一真源＝generation-model-catalog/tts-pricing）。
  // 金额在提交时由**本请求文本的实际字数**推导（`input.length`，请求自身即真源，非估算），
  // 沿用生图 route 同一条「coins × QUOTA_PER_COIN → enforceQuotaGate → submitGenerationCommand」
  // 的既有轮子（src/app/api/v1/images/generations/route.ts:297-328）。
  // 闸门：额度足够 → 0 额提交走投影记帐（SURGERY_QUOTA_PRECHECK=1 生产态）；不足 → 402；
  // 上游不可达 → 自动回落原 reserve 路径（billing-ledger 扣 users.quota）。
  // 0 额短路只在本请求真 0 字时成立——但 input 已在上面拒空，故此路由永不会真 0 字。
  const baseBillingAmount = ttsQuotaForChars(input.length);
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
      // 计费户＝金钥绑定的 new-api user（与生图 route 同源）；缺此栏位则闸门路径的
      // 投影（billing-projection 只认 billing_user_id 非空）无法记帐。
      billingUserId: apiKey.userId,
      source: "biz",
      idempotencyKey: req.headers.get("idempotency-key"),
      kind: "tts",
      modelId,
      // 供应商适配以 workflow 携带 voice；prompt 承载文本本体。
      prompt: input,
      workflow: { voice, inputLength: input.length },
      responseFormat: "b64_json",
      callbackUrl,
      billingAmount: gate.billingAmount,
    });
    const response = addRateLimitHeaders(
      NextResponse.json(generationTaskResponse(submitted.job), {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      }),
      apiKey,
      { consumed: true },
    );
    return withTraceId(response, traceId);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return errorResponse(409, error.message, "invalid_request_error", "idempotency_key_reused", traceId, apiKey);
    }
    // 模型可用性闸：建单/扣费前拒单，沿用既有稳定码 no_endpoints。
    if (error instanceof GenerationModelUnavailableError) {
      return errorResponse(503, error.message, "api_error", "no_endpoints", traceId, apiKey);
    }
    console.error("[v1/tts/generations] submit failed:", error);
    return errorResponse(502, "提交 TTS 任务失败，请稍后重试。", "api_error", "submit_failed", traceId, apiKey);
  }
}
