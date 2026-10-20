import { buildGenerationRequestHeaders, mcpGenerationIdempotencyKey } from "@/lib/generation-request-headers";
import { DISPATCH_TIMEOUT_MS } from "./constants";
import type { McpDispatcher } from "./types";

/**
 * 生产用转发器：对**自家站点**发 HTTP 请求打 `/api/v1/**`。
 *
 * 为什么是站内 HTTP 而不是 in-process 呼叫路由函式（两者都合法，这里选前者）：
 * - `/api/v1/**` 在生产被 `next.config.mjs` 的 `beforeFiles` 改写到控制面
 *   （`/image-control/api/v1/**`），**真正的帐本与 worker 在那边**。站内 HTTP 让 MCP
 *   与外部 API 客户走**同一条**生产路径（同一支闸、同一本帐），in-process 反而会
 *   绕过那层改写、在控制面模式下打到站点自己的旧分支。
 * - 呼叫者的 `Authorization` 逐字透传 ⇒ 计费主体与配额判断与 `/v1` 完全一致。
 *
 * 不变式：任何 log / 错误讯息都不得包含 `authorization` 的值（本函式只把它放进请求头）。
 *
 * `origin` 两种形态：
 * - **字串**：站点 origin，URL = `origin（去尾斜线） + path`（既有行为，逐字不变）。
 * - **函式**：`(path) => 完整绝对 URL`。route.ts 用它为**每个请求**挑转发目标——
 *   公开站点 origin（Cloudflare 前置）与不挂 CF 的控制面 origin 不是同一个
 *   （见 `src/app/api/mcp/route.ts` 的 `resolveDispatchUrl`）。函式回传值即最终 URL，
 *   本函式不再拼一次 path。
 */
export function createHttpDispatcher(
  origin: string | ((path: string) => string),
  fetchImpl: typeof fetch = fetch,
): McpDispatcher {
  const urlFor =
    typeof origin === "function"
      ? origin
      : (path: string) => `${origin.replace(/\/+$/, "")}${path}`;
  return async (request) => {
    // 生成型请求的 trace / 幂等键纪律收敛在 generation-request-headers（R5）：
    // `X-Request-Id` 沿用本次 MCP 呼叫的 traceId（上游 getOrCreateTraceId 会原样回声），
    // 幂等键与 traceId 绑定（同一次呼叫重送不重复扣费，不跨呼叫误命中）。
    const headers = buildGenerationRequestHeaders({
      traceId: request.traceId,
      idempotencyKey: mcpGenerationIdempotencyKey(request.toolName, request.traceId),
      authorization: request.authorization,
      accept: "application/json",
    });

    let payload: string | undefined;
    if (request.method === "POST") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(request.body ?? {});
    }

    const response = await fetchImpl(urlFor(request.path), {
      method: request.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      redirect: "manual",
    });

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      text: await response.text(),
    };
  };
}
