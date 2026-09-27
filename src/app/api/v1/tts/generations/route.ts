import { NextRequest, NextResponse } from "next/server";
import { readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { submitGenerationCommand } from "@/lib/generation-core/command-service";
import { enforceQuotaGate } from "@/lib/generation-core/quota-precheck";
import { IdempotencyConflictError } from "@/lib/generation-core/job-repository";
import { GenerationModelUnavailableError } from "@/lib/generation-core/model-availability-gate";
import { generationTaskResponse } from "@/lib/generation-core/task-response";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";

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

  const modelId = typeof body.model === "string" && body.model ? body.model : "tts-default";
  const voice = typeof body.voice === "string" && body.voice ? body.voice : "default";
  const callbackUrl = typeof body.callback_url === "string" ? body.callback_url : null;

  // 手術 P1 計費閘（詳見 quota-precheck.ts）：TTS 今日為 0 額提交（無 reserve 可
  // 跳），閘門對 0 額直通、兩種模式下行為一致、不產生任何新 I/O；日後 TTS 定價
  // 接入後把 baseBillingAmount 改為實際金額，即自動獲得配額預檢與 reserve 跳過。
  const gate = await enforceQuotaGate({
    bizKeyId: apiKey.id,
    billingUserId: apiKey.userId,
    baseBillingAmount: 0,
  });
  if (!gate.ok) {
    return errorResponse(gate.status, gate.message, gate.type, gate.code, traceId);
  }

  try {
    const submitted = await submitGenerationCommand({
      tenantId: `biz:${apiKey.id}`,
      apiKeyId: apiKey.id,
      source: "biz",
      idempotencyKey: req.headers.get("idempotency-key"),
      kind: "tts",
      modelId,
      // 供應商適配以 workflow 攜帶 voice；prompt 承載文本本體。
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
    // 模型可用性閘：建單/扣費前拒單，沿用既有穩定碼 no_endpoints。
    if (error instanceof GenerationModelUnavailableError) {
      return errorResponse(503, error.message, "api_error", "no_endpoints", traceId, apiKey);
    }
    console.error("[v1/tts/generations] submit failed:", error);
    return errorResponse(502, "提交 TTS 任务失败，请稍后重试。", "api_error", "submit_failed", traceId, apiKey);
  }
}
