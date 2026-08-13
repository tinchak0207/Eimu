// POST /v1/uploads — 上傳參考圖，換 mediaId。
//
// 2026-08-05 從 VPS 補回 repo。上傳本身不出圖，不計費；只認證 + 限大小。
// usage 仍記一筆，用於後台觀察誰在灌圖。
// 錯誤體與 trace id 與 /v1/images/generations 對齊。

import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateBizApiKey, flushBizApiKeyUsage, recordBizApiKeyUsage } from "@/lib/biz-api-key-store";
import { readBearerToken } from "@/lib/biz-api-keys";
import { jsonWithTrace, pixaiAuthError, pixaiError, pixaiRequestError, proxyPixai } from "@/lib/pixai-proxy";
import { getOrCreateTraceId } from "@/lib/request-trace";
import { addRateLimitHeaders } from "@/lib/biz-rate-limit-response-headers";

export const runtime = "nodejs";
export const maxDuration = 300;

// ~20MB 原圖 → base64 膨脹 4/3。代理前先截。
const MAX_B64_LEN = 30 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);

  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    return jsonWithTrace(
      pixaiAuthError(auth.status, auth.message, auth.code, traceId),
      auth.status,
      traceId,
      auth.retryAfterSeconds ? { "Retry-After": String(auth.retryAfterSeconds) } : undefined,
    );
  }

  // 認證成功後的所有回應（成功 + 錯誤）都帶限流預測頭；401/403/429 不走這裡。
  const respond = (data: unknown, status: number, headers?: Record<string, string>) =>
    addRateLimitHeaders(jsonWithTrace(data, status, traceId, headers), auth.key);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respond(pixaiRequestError("Invalid JSON body.", "invalid_json", traceId), 400);
  }

  const data = typeof body.data === "string" ? body.data.trim() : "";
  if (!data) {
    return respond(pixaiRequestError("data (base64 image) is required.", "missing_data", traceId), 400);
  }
  if (data.length > MAX_B64_LEN) {
    return respond(pixaiRequestError("image too large (max ~20MB).", "image_too_large", traceId), 413);
  }
  const mimeType = typeof body.mimeType === "string" && body.mimeType.trim() ? body.mimeType.trim() : "image/png";

  const { status, data: result } = await proxyPixai("uploads", { data, mimeType }, "POST");

  if (status === 200 && result && typeof (result as { mediaId?: unknown }).mediaId === "string") {
    recordBizApiKeyUsage(auth.key.id, 1);
    after(() => flushBizApiKeyUsage().catch(() => undefined));
    return respond(result, 200);
  }

  return respond(pixaiError(result, "Image upload failed.", traceId), status >= 400 ? status : 502);
}
