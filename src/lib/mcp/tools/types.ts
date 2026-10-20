import type { McpToolCallResult, McpToolDescriptor } from "../protocol";
export type { McpToolCallResult, McpToolDescriptor } from "../protocol";

// ─────────────────────────────────────────── JSON Schema（本档用到的子集）

export type ToolSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array";

/**
 * 只实作 protocol 需要的 JSON Schema 子集：type / properties / required /
 * additionalProperties / enum / minimum / maximum / minItems / maxItems / items。
 * **刻意不用 anyOf/oneOf**——验证器与宣告是同一份 schema，不用两套真源。
 */
export type ToolInputSchema = {
  type: ToolSchemaType;
  description?: string;
  properties?: Record<string, ToolInputSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: ToolInputSchema;
};

// ─────────────────────────────────────────── 转发层（可注入）

export interface McpDispatchRequest {
  method: "GET" | "POST";
  /** 站内路径，例如 `/api/v1/images/generations`（不含 origin、不含 query）。 */
  path: string;
  /** 呼叫者原始 `Authorization` 头，逐字透传。 */
  authorization: string | null;
  traceId: string;
  /** 工具名，只用于组幂等键，不进上游 body。 */
  toolName: string;
  body?: unknown;
}

export interface McpDispatchResponse {
  status: number;
  contentType: string;
  text: string;
}

/** 转发介面：工具测试注入假实作，生产用 `createHttpDispatcher`。 */
export type McpDispatcher = (request: McpDispatchRequest) => Promise<McpDispatchResponse>;

export interface McpToolContext {
  /** 呼叫者的 `Authorization` 头（原样，不解析、不改写）。 */
  authorization: string | null;
  /** 贯穿本次 MCP 呼叫的 trace id（同时当上游 `X-Request-Id`）。 */
  traceId: string;
  dispatcher: McpDispatcher;
  /**
   * 轮询用睡眠；预设 `setTimeout`。**可注入**：测试传 no-op，避免真的等秒
   * （照 `openai-compat/generation.ts` 的 `input.sleep ?? defaultSleep` 惯例）。
   */
  sleep?: (ms: number) => Promise<void>;
  /** 时钟；预设 `Date.now`。**可注入**：测试用假时钟驱动 `run_agent` 的逾时路径。 */
  now?: () => number;
}

export interface ToolDefinition extends McpToolDescriptor {
  inputSchema: ToolInputSchema;
  run(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult>;
}
