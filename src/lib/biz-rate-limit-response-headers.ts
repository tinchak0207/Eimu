import type { BizApiKey } from "./biz-api-keys";

/**
 * 在已验证的成功回应上附加 OpenAI 风格的限流头。
 * remaining 采保守近似值（limit - 1），reset 取下一个整分钟边界（UTC）。
 * 轮询端点（consumeRateLimit: false）不消耗额度，remaining 设为 limit。
 *
 * 接受 `Response` 基底型别（`NextResponse` 是其子类，天然相容）：
 * pixai-proxy 的 `jsonWithTrace` 走 `withTraceId` 返回的是普通 `Response`
 * （clone 出来的物件，headers 可变），helper 必须能吃它。
 */
export function addRateLimitHeaders(
  response: Response,
  key: BizApiKey,
  opts: { consumed?: boolean } = {},
): Response {
  const limit = key.rpm;
  const consumed = opts.consumed !== false; // 预设已消耗 1 次
  const remaining = consumed ? Math.max(0, limit - 1) : limit;
  const resetAt = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  response.headers.set("x-ratelimit-limit-requests", String(limit));
  response.headers.set("x-ratelimit-remaining-requests", String(remaining));
  response.headers.set("x-ratelimit-reset-requests", resetAt.toUTCString());
  return response;
}
