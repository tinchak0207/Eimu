// R5（W5 计费／额度／帐本对齐）：生成型请求的 trace / 幂等键纪律。
//
// 为什么要有这一支：客户端（站内 UI、桌面壳、MCP）与站内伺服器转发都是
// 「发起生成」的入口。若每个入口各自拼 `X-Request-Id`，就会出现两种病：
//   ① 同一次逻辑请求在重试时换了 id ⇒ 上游与我方日志无法串起来，客户也拿不出
//      一个稳定的号给客服；
//   ② 有人自己乱拼字串 ⇒ 绕过 `request-trace` 的 allowlist，把任意内容塞进日志。
// 这支把「沿用同一 traceId、同一次呼叫的幂等键」收敛成单一真源，全部入口共用。
//
// 权威仍是 `request-trace.ts`：header 名、allowlist、randomUUID 都不在这里重造。
// 本档只做组合（traceId + idempotency key + auth + content headers）。
//
// 铁律：任何 log / 错误讯息都不得包含 `authorization` 的值；本函式只把它放进回传的
// header map，永不记进其他地方。

import {
  TRACE_ID_HEADER,
  getOrCreateTraceId,
  isValidTraceId,
} from "./request-trace";

/** 生成型请求使用的 trace header；与全域惯例同一个（不另立第二个 header 名）。 */
export const GENERATION_TRACE_ID_HEADER = TRACE_ID_HEADER;

/**
 * traceId 的来源三态：
 * - `Headers`／`{ headers }`：从 inbound 读（合法才采用，否则新生成）——伺服器入口用。
 * - `string`：沿用既有 id（例如同一次逻辑请求的第二跳）——合法才采用，否则新生成。
 * - 省略：新生成一个。
 */
export type GenerationTraceIdSource =
  | Headers
  | { headers: Headers }
  | string
  | null
  | undefined;

/** 纯函式，不读环境、不做 IO：给定来源就回一个合法 traceId。 */
export function resolveGenerationTraceId(source?: GenerationTraceIdSource): string {
  if (typeof source === "string") {
    const trimmed = source.trim();
    return isValidTraceId(trimmed) ? trimmed : newGenerationTraceId();
  }
  if (source) return getOrCreateTraceId(source);
  return newGenerationTraceId();
}

/** 新生成一个合法 traceId（重用 request-trace 的 randomUUID 通道，不自己造）。 */
export function newGenerationTraceId(): string {
  return getOrCreateTraceId(new Headers());
}

/**
 * MCP 工具的幂等键约定（单一真源）。同一次 MCP 呼叫重送不重复扣费；
 * 键与 traceId 绑定，不会跨呼叫误命中。原本拼在 `mcp/tools.ts`，搬来这里让
 * 「生成型请求的幂等键」只有一个格式定义。
 */
export function mcpGenerationIdempotencyKey(toolName: string, traceId: string): string {
  return `mcp:${toolName}:${traceId}`;
}

export interface GenerationRequestHeaderInput {
  /** trace 来源；省略＝新生成一个。同一逻辑请求的重试务必传同一个 traceId。 */
  traceId?: GenerationTraceIdSource;
  /** 幂等键；空字串／未给＝不带此 header（维持既有不含键的请求形状）。 */
  idempotencyKey?: string | null;
  /** 呼叫者原始 `Authorization` 头，逐字透传；未给＝不带。 */
  authorization?: string | null;
  /** `Accept`；未给＝不带（呼叫端自行决定，不强加预设）。 */
  accept?: string;
  /** `Content-Type`；未给＝不带。POST/JSON 才需要。 */
  contentType?: string;
}

/**
 * 组合生成型请求的 header map（纯函式、零副作用）。回传的 map 随时包含
 * `X-Request-Id`；其余栏位只在提供时出现——对既有请求是加法式的（不带新栏位时
 * 逐位不变）。
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
