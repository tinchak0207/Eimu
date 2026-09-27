// `/openai/v1/*` 三條路由共用的**錯誤出口**。
//
// 形狀刻意沿用既有 B 端 OpenAI 信封（`src/lib/biz-openai-error.ts`）：
// `{ error: { message, type, code, param: null, trace_id } }` + `X-Request-Id` 頭。
// 官方 openai SDK 與聚合平台只讀 message/type/code/param，多帶的 trace_id 不影響解析；
// 抽這一層的唯一目的是讓三條路由回同一個形狀，不再各寫一份 NextResponse.json。
//
// 上游（被代理的 `/api/v1/images/generations`）本來就是同一個信封，所以「透傳」不是
// 重新包裝，而是把上游的 message/type/code 三欄原樣搬過來——錯誤原因不許在兼容層被
// 泛化掉（客戶要能分辨 model_not_found / no_endpoints / insufficient_balance）。
import {
  bizAuthErrorResponse,
  bizErrorResponse,
  guardBizApiKey,
  type BizOpenAIErrorType,
} from "@/lib/biz-openai-error";

export { guardBizApiKey };
export type OpenAICompatErrorType = BizOpenAIErrorType;

/** 上游沒有給 type 時，按 HTTP 狀態回一個誠實的 type。 */
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

/** 認證失敗統一走這裡（429 → rate_limit，403 → permission，其餘 authentication）。 */
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

/** 兼容層自己產生的錯誤（超時、非生圖模型、請求體不合法…）。 */
export function openAICompatError(
  status: number,
  code: string,
  message: string,
  traceId: string,
): Response {
  return openAIError({ status, message, type: typeForStatus(status), code }, traceId);
}

/**
 * 從上游回應取回 `{ error: { message, type, code } }`。
 *
 * 解析失敗（非 JSON / 空體）不當成功，回 fallback——呼叫端必須提供一組
 * 「上游形狀異常時也不說謊」的預設文案與穩定碼。
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

/** 上游錯誤直接回給客戶（狀態碼與三欄原樣透傳，不重新分類）。 */
export async function openAIErrorFromUpstream(
  upstream: Response,
  traceId: string,
  fallback: { message: string; code: string },
): Promise<Response> {
  return openAIError(await readUpstreamError(upstream, fallback), traceId);
}
