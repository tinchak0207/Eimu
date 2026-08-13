import type { BizApiKey } from "./biz-api-keys";

/**
 * 在已驗證的成功回應上附加 OpenAI 風格的限流頭。
 * remaining 採保守近似值（limit - 1），reset 取下一個整分鐘邊界（UTC）。
 * 輪詢端點（consumeRateLimit: false）不消耗額度，remaining 設為 limit。
 *
 * 接受 `Response` 基底型別（`NextResponse` 是其子類，天然相容）：
 * pixai-proxy 的 `jsonWithTrace` 走 `withTraceId` 返回的是普通 `Response`
 * （clone 出來的物件，headers 可變），helper 必須能吃它。
 */
export function addRateLimitHeaders(
  response: Response,
  key: BizApiKey,
  opts: { consumed?: boolean } = {},
): Response {
  const limit = key.rpm;
  const consumed = opts.consumed !== false; // 預設已消耗 1 次
  const remaining = consumed ? Math.max(0, limit - 1) : limit;
  const resetAt = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  response.headers.set("x-ratelimit-limit-requests", String(limit));
  response.headers.set("x-ratelimit-remaining-requests", String(remaining));
  response.headers.set("x-ratelimit-reset-requests", resetAt.toUTCString());
  return response;
}
