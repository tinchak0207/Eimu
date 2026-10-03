// R5（W5 計費／額度／帳本對齊）：生成型請求的 trace / 冪等鍵紀律。
//
// 為什麼要有這一支：客戶端（站內 UI、桌面殼、MCP）與站內伺服器轉發都是
// 「發起生成」的入口。若每個入口各自拼 `X-Request-Id`，就會出現兩種病：
//   ① 同一次邏輯請求在重試時換了 id ⇒ 上游與我方日誌無法串起來，客戶也拿不出
//      一個穩定的號給客服；
//   ② 有人自己亂拼字串 ⇒ 繞過 `request-trace` 的 allowlist，把任意內容塞進日誌。
// 這支把「沿用同一 traceId、同一次呼叫的冪等鍵」收斂成單一真源，全部入口共用。
//
// 權威仍是 `request-trace.ts`：header 名、allowlist、randomUUID 都不在這裡重造。
// 本檔只做組合（traceId + idempotency key + auth + content headers）。
//
// 鐵律：任何 log / 錯誤訊息都不得包含 `authorization` 的值；本函式只把它放進回傳的
// header map，永不記進其他地方。

import {
  TRACE_ID_HEADER,
  getOrCreateTraceId,
  isValidTraceId,
} from "./request-trace";

/** 生成型請求使用的 trace header；與全域慣例同一個（不另立第二個 header 名）。 */
export const GENERATION_TRACE_ID_HEADER = TRACE_ID_HEADER;

/**
 * traceId 的來源三態：
 * - `Headers`／`{ headers }`：從 inbound 讀（合法才採用，否則新生成）——伺服器入口用。
 * - `string`：沿用既有 id（例如同一次邏輯請求的第二跳）——合法才採用，否則新生成。
 * - 省略：新生成一個。
 */
export type GenerationTraceIdSource =
  | Headers
  | { headers: Headers }
  | string
  | null
  | undefined;

/** 純函式，不讀環境、不做 IO：給定來源就回一個合法 traceId。 */
export function resolveGenerationTraceId(source?: GenerationTraceIdSource): string {
  if (typeof source === "string") {
    const trimmed = source.trim();
    return isValidTraceId(trimmed) ? trimmed : newGenerationTraceId();
  }
  if (source) return getOrCreateTraceId(source);
  return newGenerationTraceId();
}

/** 新生成一個合法 traceId（重用 request-trace 的 randomUUID 通道，不自己造）。 */
export function newGenerationTraceId(): string {
  return getOrCreateTraceId(new Headers());
}

/**
 * MCP 工具的冪等鍵約定（單一真源）。同一次 MCP 呼叫重送不重複扣費；
 * 鍵與 traceId 綁定，不會跨呼叫誤命中。原本拼在 `mcp/tools.ts`，搬來這裡讓
 * 「生成型請求的冪等鍵」只有一個格式定義。
 */
export function mcpGenerationIdempotencyKey(toolName: string, traceId: string): string {
  return `mcp:${toolName}:${traceId}`;
}

export interface GenerationRequestHeaderInput {
  /** trace 來源；省略＝新生成一個。同一邏輯請求的重試務必傳同一個 traceId。 */
  traceId?: GenerationTraceIdSource;
  /** 冪等鍵；空字串／未給＝不帶此 header（維持既有不含鍵的請求形狀）。 */
  idempotencyKey?: string | null;
  /** 呼叫者原始 `Authorization` 頭，逐字透傳；未給＝不帶。 */
  authorization?: string | null;
  /** `Accept`；未給＝不帶（呼叫端自行決定，不強加預設）。 */
  accept?: string;
  /** `Content-Type`；未給＝不帶。POST/JSON 才需要。 */
  contentType?: string;
}

/**
 * 組合生成型請求的 header map（純函式、零副作用）。回傳的 map 隨時包含
 * `X-Request-Id`；其餘欄位只在提供時出現——對既有請求是加法式的（不帶新欄位時
 * 逐位不變）。
 */
export function buildGenerationRequestHeaders(
  input: GenerationRequestHeaderInput = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    [GENERATION_TRACE_ID_HEADER]: resolveGenerationTraceId(input.traceId),
  };
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  if (input.authorization) headers.Authorization = input.authorization;
  if (input.accept) headers.Accept = input.accept;
  if (input.contentType) headers["Content-Type"] = input.contentType;
  return headers;
}
