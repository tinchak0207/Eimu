// `/openai/v1/*` 三条路由共用的**错误出口**。
//
// 形状刻意沿用既有 B 端 OpenAI 信封（`src/lib/biz-openai-error.ts`）：
// `{ error: { message, type, code, param: null, trace_id } }` + `X-Request-Id` 头。
// 官方 openai SDK 与聚合平台只读 message/type/code/param，多带的 trace_id 不影响解析；
// 抽这一层的唯一目的是让三条路由回同一个形状，不再各写一份 NextResponse.json。
//
// 上游（被代理的 `/api/v1/images/generations`）本来就是同一个信封，所以「透传」不是
// 重新包装，而是把上游的 message/type/code 三栏原样搬过来——错误原因不许在兼容层被
// 泛化掉（客户要能分辨 model_not_found / no_endpoints / insufficient_balance）。
import {
  bizAuthErrorResponse,
  bizErrorResponse,
  guardBizApiKey,
  type BizOpenAIErrorType,
} from "@/lib/biz-openai-error";

export { guardBizApiKey };
export type OpenAICompatErrorType = BizOpenAIErrorType;

/** 上游没有给 type 时，按 HTTP 状态回一个诚实的 type。 */
function typeForStatus(status: number): OpenAICompatErrorType {
  if (status === 401) return "authentication_error";
  if (status === 402) return "insufficient_balance";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

const ERROR_TYPE_DOMAIN: readonly string[] = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "rate_limit_error",
  "insufficient_balance",
  "api_error",
];

export function isOpenAICompatErrorType(value: unknown): value is OpenAICompatErrorType {
  return typeof value === "string" && ERROR_TYPE_DOMAIN.includes(value);
}

/** 认证失败统一走这里（429 → rate_limit，403 → permission，其余 authentication）。 */
export function openAIAuthError(
  auth: { status: number; message: string; code: string },
  traceId: string,
): Response {
  return bizAuthErrorResponse(auth, traceId);
}

export interface OpenAIErrorFields {
  status: number;
  message: string;
  type: OpenAICompatErrorType;
  code: string;
}

/** `{error:{message,type,code,param,trace_id}}` + `X-Request-Id`。 */
export function openAIError(fields: OpenAIErrorFields, traceId: string): Response {
  return bizErrorResponse(fields.status, fields.message, fields.type, fields.code, traceId);
}

/** 兼容层自己产生的错误（超时、非生图模型、请求体不合法…）。 */
export function openAICompatError(
  status: number,
  code: string,
  message: string,
  traceId: string,
): Response {
  return openAIError({ status, message, type: typeForStatus(status), code }, traceId);
}

/**
 * 从上游回应取回 `{ error: { message, type, code } }`。
 *
 * 解析失败（非 JSON / 空体）不当成功，回 fallback——呼叫端必须提供一组
 * 「上游形状异常时也不说谎」的预设文案与稳定码。
 */
export async function readUpstreamError(
  upstream: Response,
  fallback: { message: string; code: string },
): Promise<OpenAIErrorFields> {
  let payload: unknown = null;
  try {
    payload = await upstream.json();
  } catch {
    payload = null;
  }
  const error = (payload as { error?: unknown } | null)?.error;
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const message = typeof record?.message === "string" && record.message.trim() ? record.message : fallback.message;
  const code = typeof record?.code === "string" && record.code.trim() ? record.code : fallback.code;
  const type = isOpenAICompatErrorType(record?.type) ? record.type : typeForStatus(upstream.status);
  return { status: upstream.status, message, type, code };
}

/** 上游错误直接回给客户（状态码与三栏原样透传，不重新分类）。 */
export async function openAIErrorFromUpstream(
  upstream: Response,
  traceId: string,
  fallback: { message: string; code: string },
): Promise<Response> {
  return openAIError(await readUpstreamError(upstream, fallback), traceId);
}
