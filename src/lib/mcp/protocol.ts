/**
 * MCP（Model Context Protocol）线协议层——**纯型别 + 纯函式，零 I/O、零业务**。
 *
 * 为什么要有这一层：`/api/mcp` 是把 Eimu 既有的 `/api/v1/**`（B 端 OpenAI 相容 API）
 * 暴露给外部 coding agent（Codex / Claude Code / OpenClaw…）的第二个入口。入口可以多，
 * 业务与帐本只能有一份 —— 所以本档只做「JSON-RPC 2.0 信封 + MCP 型别」的形状定义，
 * 不碰认证、不碰计费、不碰生图（那些逐字复用既有实作，见 `./tools.ts` 与
 * `src/app/api/mcp/route.ts`）。
 *
 * 传输：Streamable HTTP，本版只支援 `POST`（单发 JSON 回应，不开 SSE 串流）。
 */

// ─────────────────────────────────────────── JSON-RPC 2.0

/** JSON-RPC 2.0 标准错误码（值不得改，客户端按号码分类）。 */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

/**
 * `id` 允许 string / number / null（null 专用于「请求根本解析不出 id」的回应）。
 * 没有 `id`（undefined）= notification，服务端不回 body。
 */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * 协议层错误：`tools.ts` 的参数验证失败抛它（`-32602`），
 * `route.ts` 据此决定回哪个 JSON-RPC 错误码。**不要**拿它承载业务错误——
 * 上游 `/v1` 的失败要走 `tools/call` 结果的 `isError`，让模型自己看得见原文。
 */
export class McpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpRpcError";
    this.code = code;
    this.data = data;
  }
}

/** 成功回应（`result` 缺席时补 `{}`，符合 JSON-RPC 的 result 必存在惯例）。 */
export function jsonRpcOk(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: result === undefined ? {} : result };
}

/** 失败回应。`data` 只在有值时挂上，避免多一个 `data: undefined` 的噪音键。 */
export function jsonRpcErr(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * 把任意 body 收敛成合法 id：string / number / null 原样保留（含 `0` 与空字串——
 * 这两个是最容易被 `if (id)` 误伤的值），其余形状回 `null`（对应 -32600）。
 */
export function normalizeJsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value === null || value === undefined) return null;
  return null;
}

/**
 * 结构检查：只认「object + jsonrpc === "2.0" + method 非空字串」。
 * 阵列（批次请求）不算合法单一请求，交由呼叫方回 -32600。
 */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0") return false;
  if (typeof candidate.method !== "string" || candidate.method.trim() === "") return false;
  if (candidate.id !== undefined && candidate.id !== null) {
    const id = candidate.id;
    if (typeof id !== "string" && typeof id !== "number") return false;
  }
  return true;
}

/** 是不是 notification（无 `id`）：服务端对它只回 HTTP 202、无 body。 */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

// ─────────────────────────────────────────── MCP 线协议

export const MCP_SERVER_NAME = "eimu";
/** 本 server 的版本（/api/version 与 package.json 是站点版本，两者语义不同，别互相 import）。 */
export const MCP_SERVER_VERSION = "0.1.0";

/** 我方支援（并宣告）的 MCP 协议版本，最新者放第一。 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_PROTOCOL_VERSION: string = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];

/**
 * 版本协商：客户端宣告的版本在我方支援清单内就照单全收（回声），
 * 不认识（含缺栏位、型别错）一律回我方支援的最新版，由客户端自行决定是否降级。
 */
export function negotiateProtocolVersion(clientVersion: unknown): string {
  if (typeof clientVersion !== "string") return MCP_PROTOCOL_VERSION;
  const normalized = clientVersion.trim();
  return (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(normalized)
    ? normalized
    : MCP_PROTOCOL_VERSION;
}

/** 工具宣告。`inputSchema` = JSON Schema（object），由 `./tools.ts` 提供。 */
export interface McpToolDescriptor {
  /** snake_case，对模型稳定；改名等于破坏性变更。 */
  name: string;
  /** 人类可读短标题（简体中文）。 */
  title: string;
  /** 简体中文描述；英文版接在同一个字串内（见 tools.ts 的 `bilingual()`）。 */
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpToolDescriptor[];
}

// ─────────────────────────────────────────── resources / prompts（MCP 2025）

/**
 * `resources/list` 的单笔资源描述。**不含 `text` 全文**——清单只做「有什么」的发现，
 * 全文由 `resources/read` 按 `uri` 取；把整份指南塞进清单会灌爆 agent 上下文。
 */
export interface McpResourceDescriptor {
  /** 唯一定位符（本 server 用自订 scheme `eimu://`）。 */
  uri: string;
  /** 稳定机读名（kebab-case）。 */
  name: string;
  /** 人类可读描述（简体中文，对齐工具描述风格）。 */
  description: string;
  /** MIME 型别（指南类一律 `text/markdown`）。 */
  mimeType: string;
}

/** `resources/read` 回传的单一内容区块（text 型资源，故只给 `text`）。 */
export interface McpResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContents[];
}

/** prompt 的可带参数宣告；`required` 缺席视为 false（与官方 SDK 形状一致）。 */
export interface McpPromptArgumentDescriptor {
  name: string;
  description: string;
  required?: boolean;
}

/** `prompts/list` 的单笔 prompt 描述（**不含** `build` 函式——纯资料，可安全序列化）。 */
export interface McpPromptDescriptor {
  /** snake/kebab 混合名称，对模型稳定；改名等于破坏性变更。 */
  name: string;
  /** 人类可读短标题（简体中文）。 */
  title: string;
  /** 简体中文描述。 */
  description: string;
  arguments: McpPromptArgumentDescriptor[];
}

/** `prompts/get` 的讯息（本版只回 user 讯息、只回 text 内容）。 */
export interface McpPromptMessage {
  role: "user";
  content: McpTextContent;
}

export interface McpPromptGetResult {
  /** 本次 prompt 的说明（回填 `prompts/list` 的同名描述）。 */
  description: string;
  messages: McpPromptMessage[];
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  /**
   * 能力宣告。`tools` 恒存在（既有栏位不动）；`resources` / `prompts` 为本版新增，
   * 宣告后客户端才会去调 `resources/*` 与 `prompts/*`（空物件＝「有这能力、无子选项」，
   * 对齐 MCP 2025 规范的形状）。
   */
  capabilities: {
    tools: Record<string, never>;
    resources?: Record<string, never>;
    prompts?: Record<string, never>;
  };
  serverInfo: McpServerInfo;
  /** 给 agent 的用法提示（可选栏位，客户端可忽略）。 */
  instructions?: string;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  /** 工具层失败（未知工具 / 上游 4xx / 网路中断）走这里，**不是** JSON-RPC error。 */
  isError?: boolean;
}

/** 单一文字区块的工具结果。`isError` 只在 true 时挂上（形状与官方 SDK 一致）。 */
export function textResult(text: string, isError = false): McpToolCallResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

// ─────────────────────────────────────────── 输出消毒

/** 工具结果上限：生图预设回 b64_json，一张 1024² 就上百 KB，不限长会直接灌爆 agent 上下文。 */
export const MAX_TOOL_TEXT_LENGTH = 24_000;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const BIZ_KEY_PATTERN = /\bsk-[A-Za-z0-9._-]{6,}/g;

/**
 * 回应／错误讯息出网前的消毒：任何形态的凭证一律换成 `[REDACTED]`。
 * 上游正常不会回传密钥，但「不会」是推论不是事实——B 端 key 是钱，宁可错杀。
 */
export function redactSecrets(text: string): string {
  return text.replace(BEARER_PATTERN, "Bearer [REDACTED]").replace(BIZ_KEY_PATTERN, "sk-[REDACTED]");
}

/** 消毒 + 截断（截断处标明，不假装内容完整）。 */
export function truncateToolText(text: string, limit = MAX_TOOL_TEXT_LENGTH): string {
  const clean = redactSecrets(text);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…[内容已截断，共 ${clean.length} 字元；完整结果请改用 GET /api/v1 对应端点或 response_format=url]`;
}
