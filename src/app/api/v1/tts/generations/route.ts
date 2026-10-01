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
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

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

  // 默認模型＝catalog 真源 id `tts-1`（image-model-ids.js:129 TTS_1_MODEL_ID；
  // catalog.ts:878 kind=audio/pipeline=tts）。舊值 "tts-default" 是 catalog 與任何
  // supplier_capability 都不存在的幻影 id ⇒ 不帶 model 的請求必回 model_unsupported。
  const modelId = typeof body.model === "string" && body.model ? body.model : TTS_1_MODEL_ID;
  // 音色（P1-11／D33）：值域收在語音庫（`GET /v1/tts/voices`）。
  // 為什麼要擋：上游 proxy 對無法辨識的 voice 是**靜默回退**的（edge 路徑回 DEFAULT_VOICE，
  // SF 路徑把不含 ":" 的值改寫成 `<model>:alex`）——呼叫端以為指定了音色、實際拿到另一顆。
  // 未帶 voice ⇒ 保持既有 `"default"` 行為**逐位不變**（上游自己決定預設，不是本層的決定）。
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

  // 計費：TTS 逐字計價（0.001 幣/字，唯一真源＝generation-model-catalog/tts-pricing）。
  // 金額在提交時由**本請求文本的實際字數**推導（`input.length`，請求自身即真源，非估算），
  // 沿用生圖 route 同一條「coins × QUOTA_PER_COIN → enforceQuotaGate → submitGenerationCommand」
  // 的既有輪子（src/app/api/v1/images/generations/route.ts:297-328）。
  // 閘門：額度足夠 → 0 額提交走投影記帳（SURGERY_QUOTA_PRECHECK=1 生產態）；不足 → 402；
  // 上游不可達 → 自動回落原 reserve 路徑（billing-ledger 扣 users.quota）。
  // 0 額短路只在本請求真 0 字時成立——但 input 已在上面拒空，故此路由永不會真 0 字。
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
      // 計費戶＝金鑰綁定的 new-api user（與生圖 route 同源）；缺此欄位則閘門路徑的
      // 投影（billing-projection 只認 billing_user_id 非空）無法記帳。
      billingUserId: apiKey.userId,
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
