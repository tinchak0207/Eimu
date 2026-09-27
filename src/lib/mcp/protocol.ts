/**
 * MCP（Model Context Protocol）線協議層——**純型別 + 純函式，零 I/O、零業務**。
 *
 * 為什麼要有這一層：`/api/mcp` 是把 Eimu 既有的 `/api/v1/**`（B 端 OpenAI 相容 API）
 * 暴露給外部 coding agent（Codex / Claude Code / OpenClaw…）的第二個入口。入口可以多，
 * 業務與帳本只能有一份 —— 所以本檔只做「JSON-RPC 2.0 信封 + MCP 型別」的形狀定義，
 * 不碰認證、不碰計費、不碰生圖（那些逐字複用既有實作，見 `./tools.ts` 與
 * `src/app/api/mcp/route.ts`）。
 *
 * 傳輸：Streamable HTTP，本版只支援 `POST`（單發 JSON 回應，不開 SSE 串流）。
 */

// ─────────────────────────────────────────── JSON-RPC 2.0

/** JSON-RPC 2.0 標準錯誤碼（值不得改，客戶端按號碼分類）。 */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

/**
 * `id` 允許 string / number / null（null 專用於「請求根本解析不出 id」的回應）。
 * 沒有 `id`（undefined）= notification，服務端不回 body。
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
 * 協議層錯誤：`tools.ts` 的參數驗證失敗拋它（`-32602`），
 * `route.ts` 據此決定回哪個 JSON-RPC 錯誤碼。**不要**拿它承載業務錯誤——
 * 上游 `/v1` 的失敗要走 `tools/call` 結果的 `isError`，讓模型自己看得見原文。
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

/** 成功回應（`result` 缺席時補 `{}`，符合 JSON-RPC 的 result 必存在慣例）。 */
export function jsonRpcOk(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: result === undefined ? {} : result };
}

/** 失敗回應。`data` 只在有值時掛上，避免多一個 `data: undefined` 的噪音鍵。 */
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
 * 把任意 body 收斂成合法 id：string / number / null 原樣保留（含 `0` 與空字串——
 * 這兩個是最容易被 `if (id)` 誤傷的值），其餘形狀回 `null`（對應 -32600）。
 */
export function normalizeJsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value === null || value === undefined) return null;
  return null;
}

/**
 * 結構檢查：只認「object + jsonrpc === "2.0" + method 非空字串」。
 * 陣列（批次請求）不算合法單一請求，交由呼叫方回 -32600。
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

/** 是不是 notification（無 `id`）：服務端對它只回 HTTP 202、無 body。 */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

// ─────────────────────────────────────────── MCP 線協議

export const MCP_SERVER_NAME = "eimu";
/** 本 server 的版本（/api/version 與 package.json 是站點版本，兩者語義不同，別互相 import）。 */
export const MCP_SERVER_VERSION = "0.1.0";

/** 我方支援（並宣告）的 MCP 協議版本，最新者放第一。 */
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_PROTOCOL_VERSION: string = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];

/**
 * 版本協商：客戶端宣告的版本在我方支援清單內就照單全收（回聲），
 * 不認識（含缺欄位、型別錯）一律回我方支援的最新版，由客戶端自行決定是否降級。
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
  /** snake_case，對模型穩定；改名等於破壞性變更。 */
  name: string;
  /** 人類可讀短標題（簡體中文）。 */
  title: string;
  /** 簡體中文描述；英文版接在同一個字串內（見 tools.ts 的 `bilingual()`）。 */
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpToolDescriptor[];
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  /** 本版只宣告 tools 能力；不宣告 resources / prompts，故客戶端不該調它們。 */
  capabilities: { tools: Record<string, never> };
  serverInfo: McpServerInfo;
  /** 給 agent 的用法提示（可選欄位，客戶端可忽略）。 */
  instructions?: string;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  /** 工具層失敗（未知工具 / 上游 4xx / 網路中斷）走這裡，**不是** JSON-RPC error。 */
  isError?: boolean;
}

/** 單一文字區塊的工具結果。`isError` 只在 true 時掛上（形狀與官方 SDK 一致）。 */
export function textResult(text: string, isError = false): McpToolCallResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

// ─────────────────────────────────────────── 輸出消毒

/** 工具結果上限：生圖預設回 b64_json，一張 1024² 就上百 KB，不限長會直接灌爆 agent 上下文。 */
export const MAX_TOOL_TEXT_LENGTH = 24_000;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const BIZ_KEY_PATTERN = /\bsk-[A-Za-z0-9._-]{6,}/g;

/**
 * 回應／錯誤訊息出網前的消毒：任何形態的憑證一律換成 `[REDACTED]`。
 * 上游正常不會回傳密鑰，但「不會」是推論不是事實——B 端 key 是錢，寧可錯殺。
 */
export function redactSecrets(text: string): string {
  return text.replace(BEARER_PATTERN, "Bearer [REDACTED]").replace(BIZ_KEY_PATTERN, "sk-[REDACTED]");
}

/** 消毒 + 截斷（截斷處標明，不假裝內容完整）。 */
export function truncateToolText(text: string, limit = MAX_TOOL_TEXT_LENGTH): string {
  const clean = redactSecrets(text);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…[內容已截斷，共 ${clean.length} 字元；完整結果請改用 GET /api/v1 對應端點或 response_format=url]`;
}
