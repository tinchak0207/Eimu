/**
 * `/api/mcp` —— Eimu 的 MCP（Model Context Protocol）端点，Streamable HTTP 传输。
 *
 * 定位：这是**第二个入口，不是第二套系统**。外部 coding agent（Codex / Claude Code /
 * OpenClaw…）透过 MCP 驱动 Eimu 的生图/生视频/TTS/放大与公开技能库，但：
 * - 鉴权逐字复用 B 端那把闸（`authenticateBizApiKey` + `readBearerToken`），
 *   没有第二套验 key 的路径；
 * - 业务与计费零重写——工具把参数转发给既有 `/api/v1/**`，扣费/配额/幂等/退款
 *   与外部 API 客户走**同一条**帐本路径（见 `src/lib/mcp/tools.ts` 的传输说明）；
 * - 私有（user）技能永不出现在工具回应里。
 *
 * 传输语义（本版刻意收窄，先可用再扩）：
 * - `POST`：唯一入口。单发 JSON-RPC 回应，**不开 SSE 串流**（agent 端不需要）。
 *   `initialize` / `tools/list` / `tools/call` / `ping` 走 JSON-RPC；
 *   `notifications/*`（含 `notifications/initialized`）与任何无 `id` 的请求回 HTTP 202、无 body。
 * - `GET`：回 405。MCP 的 SSE 串流通道本版未实作，回静态 JSON 说明 + `Allow: POST`
 *   比留一个 404 让客户端猜要清楚。
 *
 * 状态码约定：认证失败是 HTTP 401/403/429（带 JSON-RPC 错误体）；
 * 其余协议层错误（parse / invalid request / method not found / invalid params / internal）
 * 一律 HTTP 200 + JSON-RPC `error`（客户端 SDK 按 `response.ok` 判断传输成败，
 * 用 4xx 回协议错误会让 SDK 抛「网路错误」而看不到真正原因）。
 *
 * 两个 origin，不是同一个（2026-10-03 实测事故后拆开）：
 * - **公开 origin**（`resolvePublicOrigin`）：使用者看得见的站点域名（生产＝`https://eimu.dev`，
 *   Cloudflare 前置）。只喂 401 的 `WWW-Authenticate: resource_metadata`——发现文件要指向
 *   客户端实际连的域名。
 * - **转发 origin**（`resolveDispatchUrl`）：工具把请求转发到哪里。**不能**用公开 origin：
 *   MCP 函式跑在 Vercel，Vercel 出口流量被 Cloudflare 判为机器人、发 managed challenge，
 *   所有转发型 `tools/call` 收到的都是 `Just a moment...` 的 403 挑战页而非业务结果
 *   （同 URL 从本机与 VPS curl 都正常，已排除 UA/header 触发）。故转发改走**不挂 CF** 的
 *   控制面 origin（`GENERATION_CONTROL_PLANE_PROXY_ORIGIN`，nginx 直出），路径表沿用
 *   `control-plane-proxy-routes.mjs` 这一份单一真源；未命中者才回落公开 origin（行为回归保护）。
 *
 * 红线：`Authorization` 的值不得进任何 log、回应或错误讯息（本档只把它交给
 * 认证函式与工具转发层）。
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
import { HARNESS_PROMPTS, HARNESS_RESOURCES, type HarnessPrompt } from "@/lib/mcp/harness-guide";
import { controlPlaneRewrites } from "@/lib/control-plane-proxy-routes.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const SERVER_INSTRUCTIONS = [
  "Eimu 提供图像生成/编辑、视频生成、文本转语音、放大，以及公开技能库检索。",
  "生成类工具会真实扣费：先用 get_quota 看余额、用 list_models 取 model id 再生成。",
  "异步任务（generate_video / tts）返回 id，用 get_result 轮询。",
  "本 server 另提供 harness 指南（资源 eimu://harness/guide 与 prompt eimu-harness），用于提升生成质量的交付契约与验收纪律。",
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

/** JSON-RPC 错误一律 HTTP 200（协议错误在 body 里，见档头状态码约定）。 */
function rpcError(traceId: string, id: JsonRpcId, code: number, message: string, data?: unknown) {
  return noStore(200, jsonRpcErr(id, code, message, data), traceId);
}

function rpcOk(traceId: string, id: JsonRpcId, result: unknown) {
  return noStore(200, jsonRpcOk(id, result), traceId);
}

/**
 * 逆注入防护（安全铁律）——`prompts/get` 的 `arguments` 是**外部客户端可控输入**。
 *
 * 契约：arguments 只能原样交给 `HarnessPrompt.build()`，由 build **在文案尾端**附加成
 * 「本次任务描述」；本函式与整个 route **不得**拿 arguments 与本 server 提供的契约／规则
 * 文字做任何拼接、替换或模板插值——否则使用者一句「忽略以上所有规则」就能改写规则区块。
 * 具体守则：① 未知 argument 名一律丢弃（不进 build、也不回声到任何文字）；
 * ② 非字串值一律丢弃。确保 build 收到的永远是「宣告过的名字 + 纯字串」。
 */
function sanitizePromptArguments(prompt: HarnessPrompt, raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const allowed = new Set(prompt.arguments.map((argument) => argument.name));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (typeof value !== "string") continue;
    result[key] = value;
  }
  return result;
}

/** RFC 9728 的发现文件路径（resource metadata 住在站根，不在 `/api/mcp` 之下）。 */
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * **公开站点 origin**（只喂 401 的 `WWW-Authenticate: resource_metadata`）：
 * 显式配置优先（反向代理/自订域名下最稳），否则用本次请求的 origin。
 * 注意：这是「使用者连进来的域名」，生产＝Cloudflare 前置的 `https://eimu.dev`；
 * **不可**拿它当工具转发目标（Vercel 出口会被 CF 挑战，见档头）。
 */
function resolvePublicOrigin(req: NextRequest): string {
  const configured = process.env.MCP_SELF_ORIGIN?.trim().replace(/\/+$/, "");
  return configured || new URL(req.url).origin;
}

/** 控制面 origin（已 trim、去尾斜线；未配置回空字串）。 */
function controlPlaneOrigin(): string {
  return process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "") ?? "";
}

/**
 * **转发 origin**：把站内 `path` 解析成工具转发用的完整绝对 URL。
 *
 * 顺序（越前面越优先）：
 * 1. `MCP_DISPATCH_ORIGIN` 显式指定 → `${该值}${path}`。**生产必需，不可移除**：
 *    `/api/agent/biz/**` 族（`canvas_get_state` / `workflow_read` / `workflow_history`，
 *    站内只有 Vercel 有这条 route）在本函式没有其他顺位可救，少了它就落到第 3 点、
 *    被 Cloudflare 发 managed challenge（`Just a moment` 403）。生产值＝
 *    `https://image.eimu.dev`（同 Vercel 专案、`server: Vercel`、不挂 CF 的自订域名）；
 *    换值**必须**是不挂 Cloudflare 的 origin——换回公开域名（`eimu.dev`）等于复发。
 * 2. 对 `controlPlaneRewrites(cpOrigin)` 做匹配：命中控制面路径表（唯一真源＝
 *    `src/lib/control-plane-proxy-routes.mjs`）→ 走不挂 CF 的控制面 origin。
 *    匹配规则：source 形如 `/api/v1/:path*` 者做「前缀 + 捕获剩余段」；其余 source 精确相等。
 * 3. 都未命中 → `${公开 origin}${path}`（维持拆分前的行为，回归保护）。
 *
 * 为什么要拆：公开域名经 Cloudflare，Vercel 出口被发 managed challenge；控制面
 * （`GENERATION_CONTROL_PLANE_PROXY_ORIGIN`）是 nginx 直出、不挂 CF，同一条路径表
 * 在生产被 `next.config.mjs` beforeFiles 改写过去，帐本/worker 也都在那边。
 */
function resolveDispatchUrl(req: NextRequest, path: string): string {
  const override = process.env.MCP_DISPATCH_ORIGIN?.trim().replace(/\/+$/, "");
  if (override) return `${override}${path}`;

  for (const { source, destination } of controlPlaneRewrites(controlPlaneOrigin())) {
    if (source.endsWith("/:path*")) {
      const prefix = source.slice(0, -"/:path*".length);
      if (!path.startsWith(`${prefix}/`)) continue;
      return destination.replace(":path*", path.slice(prefix.length + 1));
    }
    if (path === source) return destination;
  }

  return `${resolvePublicOrigin(req)}${path}`;
}

/** GET：本版没有 SSE 通道，回 405 + 说明（不是 404，让客户端知道端点存在但方法不对）。 */
export function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  return noStore(
    405,
    {
      error: "method_not_allowed",
      message: "本 MCP 端点只接受 POST（Streamable HTTP，单发 JSON-RPC，暂不提供 SSE 串流）。",
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
  // 公开 origin 只服务 401 挑战；工具转发另由 resolveDispatchUrl 逐请求决定（见档头）。
  const publicOrigin = resolvePublicOrigin(req);

  // ── 认证：逐字复用 B 端那把闸（不新增第二套验 key）────────────────
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) {
    // 只回既有的讯息/码；**绝不**回声金钥本身。
    const headers: Record<string, string> = {};
    if (auth.status === 401) {
      // 带上 `resource_metadata`：发现文件住在站根（`/.well-known/oauth-protected-resource`），
      // 而本端点在 `/api/mcp` 之下——不分岔指路的话，严格客户端会去拼
      // `…/oauth-protected-resource/api/mcp` 而 404，整条发现链就断在这里。
      headers["WWW-Authenticate"] =
        `Bearer realm="eimu-mcp", resource_metadata="${publicOrigin}${PROTECTED_RESOURCE_METADATA_PATH}"`;
    }
    if (auth.retryAfterSeconds) headers["Retry-After"] = String(auth.retryAfterSeconds);
    return noStore(
      auth.status,
      jsonRpcErr(null, JSON_RPC_ERROR_CODES.invalidRequest, auth.message, { code: auth.code }),
      traceId,
      headers,
    );
  }

  // ── 读 body：畸型输入回协议码，不抛 500 ────────────────────────────
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.parseError, "无法读取请求体。");
  }
  if (!raw.trim()) {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.invalidRequest, "请求体为空。");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.parseError, "请求体不是合法 JSON。");
  }

  if (Array.isArray(parsed)) {
    // 批次请求（JSON-RPC 阵列）本版不支援：明确拒绝，不静默只取第一条。
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.invalidRequest, "本端点不支援 JSON-RPC 批次请求。");
  }
  if (!isJsonRpcRequest(parsed)) {
    return rpcError(traceId, null, JSON_RPC_ERROR_CODES.invalidRequest, "不是合法的 JSON-RPC 2.0 请求。");
  }

  // notification（含 notifications/initialized）：只回 202，无 body。
  if (parsed.id === undefined) return noStore(202, undefined, traceId);
  const id = normalizeJsonRpcId(parsed.id);

  switch (parsed.method) {
    case "initialize": {
      const params = typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
      const result: McpInitializeResult = {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        // tools 既有能力不动；本版新增宣告 resources / prompts（harness 指南与模板）。
        capabilities: { tools: {}, resources: {}, prompts: {} },
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
        return rpcError(traceId, id, JSON_RPC_ERROR_CODES.invalidParams, "tools/call 缺少参数 name。");
      }

      // 转发目标逐请求解析：公开 origin（CF 前置）不能当出口，见 resolveDispatchUrl。
      try {
        const result = await callTool(toolName, params.arguments, {
          authorization: req.headers.get("authorization"),
          traceId,
          dispatcher: createHttpDispatcher((path) => resolveDispatchUrl(req, path)),
        });
        return rpcOk(traceId, id, result);
      } catch (error) {
        if (error instanceof McpRpcError) {
          return rpcError(traceId, id, error.code, error.message, error.data);
        }
        // 只记工具名，不记参数、不记 authorization。
        console.error(`[mcp] tools/call ${toolName} 未预期失败`, error instanceof Error ? error.message : error);
        return rpcError(traceId, id, JSON_RPC_ERROR_CODES.internalError, "工具执行发生未预期错误。");
      }
    }

    case "resources/list":
      // 只露「有什么」：投影掉 text 全文，全文交给 resources/read 按 uri 取。
      return rpcOk(traceId, id, {
        resources: HARNESS_RESOURCES.map(({ uri, name, description, mimeType }) => ({
          uri,
          name,
          description,
          mimeType,
        })),
      });

    case "resources/read": {
      const params = typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
      const uri = typeof params.uri === "string" ? params.uri : "";
      const resource = HARNESS_RESOURCES.find((candidate) => candidate.uri === uri);
      if (!resource) {
        // 未知 uri 走 invalidParams，并把可用清单写进讯息（客户端可自我修正）。
        return rpcError(
          traceId,
          id,
          JSON_RPC_ERROR_CODES.invalidParams,
          `resources/read 未知的 uri：${uri || "(空)"}。可用 uri：${HARNESS_RESOURCES.map((r) => r.uri).join("、")}。`,
        );
      }
      return rpcOk(traceId, id, {
        contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
      });
    }

    case "prompts/list":
      // 投影掉 build 函式：清单是纯资料，必须可 JSON 序列化。
      return rpcOk(traceId, id, {
        prompts: HARNESS_PROMPTS.map(({ name, title, description, arguments: args }) => ({
          name,
          title,
          description,
          arguments: args,
        })),
      });

    case "prompts/get": {
      const params = typeof parsed.params === "object" && parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
      const promptName = typeof params.name === "string" ? params.name.trim() : "";
      if (!promptName) {
        return rpcError(traceId, id, JSON_RPC_ERROR_CODES.invalidParams, "prompts/get 缺少参数 name。");
      }
      const prompt = HARNESS_PROMPTS.find((candidate) => candidate.name === promptName);
      if (!prompt) {
        return rpcError(
          traceId,
          id,
          JSON_RPC_ERROR_CODES.invalidParams,
          `prompts/get 未知的 prompt：${promptName}。可用 name：${HARNESS_PROMPTS.map((p) => p.name).join("、")}。`,
        );
      }
      // 见 sanitizePromptArguments 的逆注入契约：参数只交给 build 附加在尾端，本处零插值。
      const text = prompt.build(sanitizePromptArguments(prompt, params.arguments));
      return rpcOk(traceId, id, {
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text } }],
      });
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
