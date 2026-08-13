import { NextRequest, NextResponse } from "next/server";
import { isModelAllowedForKey, readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids";
import { generationCapabilities } from "@/lib/generation-model-catalog";
import { modelDisplayName } from "@/lib/provider-config";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * GET /v1/object_info — 給聚合平台的自省面：這套 API 賣什麼模型、每種模型
 * 能幹嘛、參數長什麼樣。
 *
 * 模型清單與 GET /v1/models 同源（SUPPORTED_GENERATION_MODEL_IDS + 能力目錄），
 * 且只列該金鑰有權的模型；參數表是靜態契約描述，供平台做能力發現與上架校驗。
 */
export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    consumeRateLimit: false,
  });
  if (!auth.ok) return errorResponse(auth.status, auth.message, auth.code, traceId);

  const models = SUPPORTED_GENERATION_MODEL_IDS.filter((modelId) => isModelAllowedForKey(auth.key, modelId)).map(
    (modelId) => {
      const capabilities = generationCapabilities(modelId);
      const isVideo = capabilities?.mediaType === "video";
      return {
        id: modelId,
        object: "model",
        x_display_name: modelDisplayName(modelId),
        x_media_type: isVideo ? "video" : "image",
        x_endpoint: isVideo ? "/v1/videos/generations" : "/v1/images/generations",
        ...(capabilities ? { x_capabilities: capabilities } : {}),
      };
    },
  );

  const payload = {
    object: "object_info",
    name: "Image Studio API",
    version: "v1",
    authentication: {
      type: "bearer",
      scheme: "sk-biz-…",
      header: "Authorization",
      doc: "每把金鑰是獨立的計費主體，平台透傳 Authorization 即可，不需自帶 user id。",
    },
    endpoints: [
      { path: "/v1/images/generations", method: "POST", description: "生圖（OpenAI 相容）。" },
      { path: "/v1/videos/generations", method: "POST", description: "生影片（OpenAI 相容）。" },
      { path: "/v1/images/{id}", method: "GET", description: "查詢任務狀態。" },
      { path: "/v1/videos/{id}", method: "GET", description: "查詢影片任務狀態。" },
      { path: "/v1/images/{id}/result", method: "GET", description: "取生圖結果。" },
      { path: "/v1/videos/{id}/result", method: "GET", description: "取影片結果。" },
      { path: "/v1/models", method: "GET", description: "該金鑰有權的模型清單（含單價）。" },
      { path: "/v1/queue", method: "GET", description: "該金鑰目前在佇列中的任務。" },
      { path: "/v1/history", method: "GET", description: "該金鑰最近的任務歷史。" },
      { path: "/v1/system_stats", method: "GET", description: "平台層聚合統計（只回數字）。" },
    ],
    parameters: [
      {
        name: "model",
        in: "body",
        required: true,
        description: "模型 id，見 models 清單。",
        example: "gpt-image-2",
      },
      {
        name: "prompt",
        in: "body",
        required: true,
        description: "生成描述。上限 4000 字元。",
        example: "a premium skincare bottle on a soft ivory background",
      },
      {
        name: "n",
        in: "body",
        required: false,
        description: "一次生成的張數，1–4，預設 1。",
        example: 1,
      },
      {
        name: "size",
        in: "body",
        required: false,
        description: "影像尺寸。可選：1024x1024 / 1536x1024 / 1024x1536，預設 1024x1024。",
        example: "1024x1024",
      },
      {
        name: "quality",
        in: "body",
        required: false,
        description: "影像檔位。OpenAI 語法：standard / hd；hq/high 亦視為 hd。",
        example: "standard",
      },
      {
        name: "response_format",
        in: "body",
        required: false,
        description: "結果格式：b64_json（預設）或 url。",
        example: "b64_json",
      },
      {
        name: "callback_url",
        in: "body",
        required: false,
        description: "異步完成回調（outbox 可靠交付，附 HMAC 簽名）。",
        example: "https://example.com/callback",
      },
      {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "冪等金鑰：重複提交回同一個 job，帶不同 payload 的衝突會被拒絕。",
      },
      {
        name: "duration_seconds",
        in: "body",
        required: false,
        description: "僅影片：時長（秒），上限依模型 x_capabilities.durations。",
        example: 5,
      },
    ],
    models,
  };

  const response = addRateLimitHeaders(
    NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } }),
    auth.key,
    { consumed: false },
  );
  return withTraceId(response, traceId);
}