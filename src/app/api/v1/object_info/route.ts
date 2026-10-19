import { NextRequest, NextResponse } from "next/server";
import { isModelAllowedForKey, readBearerToken, type BizApiKey } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";
import { SUPPORTED_GENERATION_MODEL_IDS } from "@/lib/image-model-ids";
import { generationCapabilities } from "@/lib/generation-model-catalog";
import { modelDisplayName } from "@/lib/provider-config";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";

export const runtime = "nodejs";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

function errorResponse(status: number, message: string, code: string, traceId: string, key?: BizApiKey) {
  let response: Response = NextResponse.json(
    { error: { message, type: "invalid_request_error", code, param: null, trace_id: traceId } },
    { status },
  );
  if (key) response = addRateLimitHeaders(response, key, { consumed: false });
  return withTraceId(response, traceId);
}

/**
 * GET /v1/object_info — 给聚合平台的自省面：这套 API 卖什么模型、每种模型
 * 能干嘛、参数长什么样。
 *
 * 模型清单与 GET /v1/models 同源（SUPPORTED_GENERATION_MODEL_IDS + 能力目录），
 * 且只列该金钥有权的模型；参数表是静态契约描述，供平台做能力发现与上架校验。
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
      doc: "每把金钥是独立的计费主体，平台透传 Authorization 即可，不需自带 user id。",
    },
    endpoints: [
      { path: "/v1/images/generations", method: "POST", description: "生图（OpenAI 相容）。" },
      { path: "/v1/videos/generations", method: "POST", description: "生影片（OpenAI 相容）。" },
      { path: "/v1/images/{id}", method: "GET", description: "查询任务状态。" },
      { path: "/v1/videos/{id}", method: "GET", description: "查询影片任务状态。" },
      { path: "/v1/images/{id}/result", method: "GET", description: "取生图结果。" },
      { path: "/v1/videos/{id}/result", method: "GET", description: "取影片结果。" },
      { path: "/v1/models", method: "GET", description: "该金钥有权的模型清单（含单价）。" },
      { path: "/v1/queue", method: "GET", description: "该金钥目前在伫列中的任务。" },
      { path: "/v1/history", method: "GET", description: "该金钥最近的任务历史。" },
      { path: "/v1/system_stats", method: "GET", description: "平台层聚合统计（只回数字）。" },
    ],
    parameters: [
      {
        name: "model",
        in: "body",
        required: true,
        description: "模型 id，见 models 清单。",
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
        description: "一次生成的张数，1–4，预设 1。",
        example: 1,
      },
      {
        name: "size",
        in: "body",
        required: false,
        description: "影像尺寸。可选：1024x1024 / 1536x1024 / 1024x1536，预设 1024x1024。",
        example: "1024x1024",
      },
      {
        name: "quality",
        in: "body",
        required: false,
        description: "影像档位。OpenAI 语法：standard / hd；hq/high 亦视为 hd。",
        example: "standard",
      },
      {
        name: "response_format",
        in: "body",
        required: false,
        description: "结果格式：b64_json（预设）或 url。",
        example: "b64_json",
      },
      {
        name: "callback_url",
        in: "body",
        required: false,
        description: "异步完成回调（outbox 可靠交付，附 HMAC 签名）。",
        example: "https://example.com/callback",
      },
      {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "幂等金钥：重复提交回同一个 job，带不同 payload 的冲突会被拒绝。",
      },
      {
        name: "duration_seconds",
        in: "body",
        required: false,
        description: "仅影片：时长（秒），上限依模型 x_capabilities.durations。",
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