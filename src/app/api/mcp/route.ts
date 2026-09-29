/**
 * `/api/mcp` —— Eimu 的 MCP（Model Context Protocol）端點，Streamable HTTP 傳輸。
 *
 * 定位：這是**第二個入口，不是第二套系統**。外部 coding agent（Codex / Claude Code /
 * OpenClaw…）透過 MCP 驅動 Eimu 的生圖/生視頻/TTS/放大與公開技能庫，但：
 * - 鑑權逐字複用 B 端那把閘（`authenticateBizApiKey` + `readBearerToken`），
 *   沒有第二套驗 key 的路徑；
 * - 業務與計費零重寫——工具把參數轉發給既有 `/api/v1/**`，扣費/配額/冪等/退款
 *   與外部 API 客戶走**同一條**帳本路徑（見 `src/lib/mcp/tools.ts` 的傳輸說明）；
 * - 私有（user）技能永不出現在工具回應裡。
 *
 * 傳輸語義（本版刻意收窄，先可用再擴）：
 * - `POST`：唯一入口。單發 JSON-RPC 回應，**不開 SSE 串流**（agent 端不需要）。
 *   `initialize` / `tools/list` / `tools/call` / `ping` 走 JSON-RPC；
 *   `notifications/*`（含 `notifications/initialized`）與任何無 `id` 的請求回 HTTP 202、無 body。
 * - `GET`：回 405。MCP 的 SSE 串流通道本版未實作，回靜態 JSON 說明 + `Allow: POST`
 *   比留一個 404 讓客戶端猜要清楚。
 *
 * 狀態碼約定：認證失敗是 HTTP 401/403/429（帶 JSON-RPC 錯誤體）；
 * 其餘協議層錯誤（parse / invalid request / method not found / invalid params / internal）
 * 一律 HTTP 200 + JSON-RPC `error`（客戶端 SDK 按 `response.ok` 判斷傳輸成敗，
 * 用 4xx 回協議錯誤會讓 SDK 拋「網路錯誤」而看不到真正原因）。
 *
 * 紅線：`Authorization` 的值不得進任何 log、回應或錯誤訊息（本檔只把它交給
 * 認證函式與工具轉發層）。
 */

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import {
  JSON_RPC_ERROR_CODES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  McpRpcError,
  isJsonRpcRequest,
  jsonRpcErr,
  jsonRpcOk,
  normalizeJsonRpcId,
  negotiateProtocolVersion,
  type JsonRpcId,
  type McpInitializeResult,
} from "@/lib/mcp/protocol";
import { MCP_TOOLS, callTool, createHttpDispatcher } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INSTRUCTIONS = [
  "Eimu 提供图像生成/编辑、视频生成、文本转语音、放大，以及公开技能库检索。",
  "生成类工具会真实扣费：先用 get_quota 看余额、用 list_models 取 model id 再生成。",
  "异步任务（generate_video / tts）返回 id，用 get_result 轮询。",
].join(" ");

function noStore(status: number, body: unknown, traceId: string, headers?: Record<string, string>) {
  const response = new NextResponse(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
  });
  return withTraceId(response, traceId);
}

/** JSON-RPC 錯誤一律 HTTP 200（協議錯誤在 body 裡，見檔頭狀態碼約定）。 */
function rpcError(traceId: string, id: JsonRpcId, code: number, message: string, data?: unknown) {
  return noStore(200, jsonRpcErr(id, code, message, data), traceId);
}

function rpcOk(traceId: string, id: JsonRpcId, result: unknown) {
  return noStore(200, jsonRpcOk(id, result), traceId);
}

/** RFC 9728 的發現文件路徑（resource metadata 住在站根，不在 `/api/mcp` 之下）。 */
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * 站點 origin 的**唯一**取得方式（認證挑戰與工具轉發共用，不得各自硬編）：
 * 顯式配置優先（反向代理/自訂域名下最穩），否則用本次請求的 origin。
 */
function resolveOrigin(req: NextRequest): string {
  const configured = process.env.MCP_SELF_ORIGIN?.trim().replace(/\/+$/, "");
  return configured || new URL(req.url).origin;
}

/** GET：本版沒有 SSE 通道，回 405 + 說明（不是 404，讓客戶端知道端點存在但方法不對）。 */
export function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  return noStore(
    405,
    {
      error: "method_not_allowed",
      message: "本 MCP 端點只接受 POST（Streamable HTTP，單發 JSON-RPC，暫不提供 SSE 串流）。",
      transport: "streamable-http",
      endpoint: "/api/mcp",
      allowed_methods: ["POST"],
      protocol_versions: ["2025-06-18", "2025-03-26", "2024-11-05"],
      server: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    },
    traceId,
    { Allow: "POST" },
  );
}

export async function POST(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const origin = resolveOrigin(req);

  // ── 認證：逐字複用 B 端那把閘（不新增第二套驗 key）────────────────
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    // 只回既有的訊息/碼；**絕不**回聲金鑰本身。
    const headers: Record<string, string> = {};
    if (auth.status === 401) {
      // 帶上 `resource_metadata`：發現文件住在站根（`/.well-known/oauth-protected-resource`），
      // 而本端點在 `/api/mcp` 之下——不分岔指路的話，嚴格客戶端會去拼
      // `…/oauth-protected-resource/api/mcp` 而 404，整條發現鏈就斷在這裡。
      headers["WWW-Authenticate"] =
        `Bearer realm="eimu-mcp", resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`;
    }
    if (auth.retryAfterSeconds) headers["Retry-After"] = String(auth.retryAfterSeconds);
    return noStore(
      auth.status,
      jsonRpcErr(null, JSON_RPC_ERROR_CODES.invalidRequest, auth.message, { code: auth.code }),
      traceId,
      headers,
    );
  }

  // ── 讀 body：畸型輸入回協議碼，不拋 500 ────────────────────────────
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.parseError, "無法讀取請求體。");
  }
  if (!raw.trim()) {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.invalidRequest, "請求體為空。");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.parseError, "請求體不是合法 JSON。");
  }

  if (Array.isArray(parsed)) {
    // 批次請求（JSON-RPC 陣列）本版不支援：明確拒絕，不靜默只取第一條。
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.invalidRequest, "本端點不支援 JSON-RPC 批次請求。");
  }
  if (!isJsonRpcRequest(parsed)) {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.invalidRequest, "不是合法的 JSON-RPC 2.0 請求。");
  }

  // notification（含 notifications/initialized）：只回 202，無 body。
  if (parsed.id === undefined) return noStore(202, undefined, traceId);
  const id = normalizeJsonRpcId(parsed.id);

  switch (parsed.method) {
    case "initialize": {
      const params = typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
      const result: McpInitializeResult = {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        // 只宣告 tools；未宣告的 resources/prompts 客戶端不該調。
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      };
      return rpcOk(traceId, id, result);
    }

    case "ping":
      return rpcOk(traceId, id, {});

    case "tools/list":
      return rpcOk(traceId, id, { tools: MCP_TOOLS });

    case "tools/call": {
      const params = typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
      const toolName = typeof params.name === "string" ? params.name.trim() : "";
      if (!toolName) {
        return rpcError(traceId, id, JSON_RPC_ERROR_CODES.invalidParams, "tools/call 缺少參數 name。");
      }

      // 轉發 origin 與 401 挑戰共用同一真源（見 resolveOrigin）。
      try {
        const result = await callTool(toolName, params.arguments, {
          authorization: req.headers.get("authorization"),
          traceId,
          dispatcher: createHttpDispatcher(origin),
        });
        return rpcOk(traceId, id, result);
      } catch (error) {
        if (error instanceof McpRpcError) {
          return rpcError(traceId, id, error.code, error.message, error.data);
        }
        // 只記工具名，不記參數、不記 authorization。
        console.error(`[mcp] tools/call ${toolName} 未預期失敗`, error instanceof Error ? error.message : error);
        return rpcError(traceId, id, JSON_RPC_ERROR_CODES.internalError, "工具執行發生未預期錯誤。");
      }
    }

    default:
      return rpcError(
        traceId,
        id,
        JSON_RPC_ERROR_CODES.methodNotFound,
        `不支援的方法：${parsed.method}`,
      );
  }
}
