// Agent 聊天的传輸层：只負責把请求打到站内的 agent 代理路由，不碰 React。
//
// 身份：token 和 user id 必须成对送出 —— `Authorization: Bearer <token>` 加
// `x-user-id`。agent 代理的 resolveAgentCaller → requireVerifiedUser →
// authenticateImageUser 是拿这两个头一起去问上游 /api/user/self 的：上游会拒绝
// 「令牌持有者 ≠ 头里声称的 id」，所以 id 不是干擾，它是校验的另一半。
// 少送 id，authenticateImageUser 在 `if (!auth || !userId)` 就 401，
// 已登录的用户也会被挡在门外（这正是 agent 一开就报 401 的原因）。
//
// 错误：统一丢 AgentChatError（带 code），UI 分支用 code 判断，不做字串比对。
// 安全：本模组永不 log token、ticket 或任何可能攜带它们的 response body。

import { getStoredToken, getStoredUser } from "./new-api-client";
import type { AgentAttachmentRef, AgentQuotaState } from "./agent-chat-types";

/** 网道附件清单：download/attachment 解析后可转成 AgentAttachmentRef。 */
export interface AgentAttachment {
  name: string;
  path: string;
  size: number;
  mime: string;
}

// ─────────────────────────── 常数

/** 网道 SSE ticket 的有效期（网道 10 分鐘到期），native EventSource 自动重连会拿死票一直重試，所以前端自己管重连。 */
export const SSE_TICKET_TTL_MS = 10 * 60 * 1000;

// ─────────────────────────── 错误型别

export type AgentChatErrorCode =
  | "not_authenticated"
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "agent_unavailable"
  | "gateway_error"
  | "network_error"
  | "parse_error";

export class AgentChatError extends Error {
  readonly code: AgentChatErrorCode;
  readonly status?: number;

  constructor(code: AgentChatErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AgentChatError";
    this.code = code;
    this.status = status;
  }
}

// ─────────────────────────── 回传型别

export interface AgentSessionInfo {
  session_id: string;
  user_id?: string;
}

export interface AgentSseTicket {
  ticket: string;
  events_url: string;
  expires_in_ms?: number;
}

export interface AgentQuotaWire {
  balance_coins?: unknown;
  currency?: unknown;
  available?: unknown;
  reason?: unknown;
}

// ─────────────────────────── 内部 helper

function mapHttpStatus(status: number): AgentChatErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status >= 500) return "agent_unavailable";
  return "gateway_error";
}

/**
 * body 裡的 code 比 HTTP status 精確時就用它。
 *
 * `agent_not_signed_in`（guard 判定根本沒送凭证）映到 not_authenticated：
 * hook 收到它會直接关掉连线并提示登录，而不是把它当「登录过期」反覆重连 ——
 * 没登录的人重连一万次也还是没登录。
 */
function mapErrorCode(data: unknown, status: number): AgentChatErrorCode {
  if (data !== null && typeof data === "object") {
    const code = (data as Record<string, unknown>).code;
    if (code === "agent_not_signed_in") return "not_authenticated";
  }
  return mapHttpStatus(status);
}

function fallbackMessage(status: number): string {
  if (status === 401 || status === 403) return "登录已失效，请重新登录。";
  if (status === 404) return "找不到该会话或资源。";
  if (status >= 500) return "服务器暂时无法处理，请稍后再试。";
  return "请求失败，请稍后再试。";
}

/**
 * 抽出可读的错误讯息：站内代理回 `{ success:false, error, code }`，
 * 网道回 `{ error: { message, type, code } }`，兩种都要能读。
 */
/** 網關技術名詞 → 使用者能懂的人話。只映射確定語義的，未知的原樣透傳。 */
const GATEWAY_MESSAGE_ZH: Record<string, string> = {
  "question request unknown or already resolved": "这个选择已经提交过了，无需重复操作。",
  "confirm request unknown or already resolved": "这个确认已处理过，请继续对话。",
};

function extractMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.error === "string" && d.error.length > 0) return GATEWAY_MESSAGE_ZH[d.error] ?? d.error;
    if (typeof d.message === "string" && d.message.length > 0) return d.message;
    if (d.error !== null && typeof d.error === "object") {
      const e = d.error as Record<string, unknown>;
      if (typeof e.message === "string" && e.message.length > 0) return e.message;
    }
  }
  return fallbackMessage(status);
}

/**
 * 唯一的身份头产生器：token 与 user id 必须同时存在才算已登录。
 *
 * 只有一半就直接丢 not_authenticated，不让半套凭证打到后端换一个语义更差的
 * 401 —— UI 拿到 not_authenticated 会引导登录，拿到 agent_auth_failed 只会
 * 显示「请先登录」却不知道该怎么办。
 */
function authHeaders(reason: string): Record<string, string> {
  const token = getStoredToken();
  const userId = getStoredUser()?.id;
  if (!token || !userId) {
    throw new AgentChatError("not_authenticated", reason);
  }
  return { Authorization: `Bearer ${token}`, "x-user-id": String(userId) };
}

/** 统一的 JSON 请求入口：带 token、解析错误、丢 AgentChatError。 */
async function agentFetch(path: string, init?: RequestInit): Promise<unknown> {
  const headers = authHeaders("尚未登录，无法使用 Agent 助手。");
  if (init?.body) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new AgentChatError("network_error", "网络连接失败，请检查网络后再试。");
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    // 不是 JSON（例如网道回纯文字）也照样透传 status，讯息用 fallback。
    if (!res.ok) throw new AgentChatError(mapHttpStatus(res.status), fallbackMessage(res.status), res.status);
    throw new AgentChatError("parse_error", "服务器回应格式错误。", res.status);
  }

  if (!res.ok) {
    throw new AgentChatError(mapErrorCode(data, res.status), extractMessage(data, res.status), res.status);
  }
  return data;
}

// ─────────────────────────── 公开 API

/** 會話目錄項：對話歷史 dropdown 的數據源（網關 GET /agent/v1/sessions 透傳）。 */
export interface AgentSessionSummary {
  session_id: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
}

/** 列出當前用戶的歷史會話（按 updated_at 降序）。 */
export async function listAgentSessions(): Promise<AgentSessionSummary[]> {
  const data = await agentFetch('/api/agent/sessions', { method: 'GET' });
  const sessions = (data as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(
    (it): it is AgentSessionSummary =>
      typeof it === 'object' && it !== null && typeof (it as AgentSessionSummary).session_id === 'string',
  );
}

// ─────────────────────────── 公开 API


/** 建一个 agent 会话。 */
export async function createAgentSession(): Promise<AgentSessionInfo> {
  const data = await agentFetch("/api/agent/sessions", { method: "POST", body: "{}" });
  const sessionId = (data as AgentSessionInfo)?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new AgentChatError("parse_error", "服务器未返回有效的 session_id。");
  }
  return data as AgentSessionInfo;
}

/** 送一条消息时可附带的额外上下文。 */
export interface SendAgentMessageOptions {
  /**
   * 画布摘要（纯 metadata，不含图片 base64）。带上它，网道才能把 agent 的
   * 下一句话对齐到「画布上现在有什么」——前端不向 agent 下画布指令，
   * 画布上下文靠这个字段随每次 send 上送。
   */
  canvasState?: unknown;
}

/** 送一条对话消息。网道回 202 即算已收。 */
export async function sendAgentMessage(
  sessionId: string,
  content: string,
  options?: SendAgentMessageOptions,
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (options?.canvasState !== undefined && options.canvasState !== null) {
    body.canvas_state = options.canvasState;
  }
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * 网道附件清单：每个元素带 path/mime/size，直接转成 AgentAttachmentRef。
 * 依 mime 決定 kind：影像 → "image"，影片 → "video"，其余 → "document"。
 */
export interface AgentAttachment {
  name: string;
  path: string;
  size: number;
  mime: string;
}

/** 把网道回传的附件物件映射成前端 ref。 */
export function toAgentAttachmentRef(a: AgentAttachment): AgentAttachmentRef {
  const mime = a.mime ?? "";
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "document";
  return { kind, path: a.path, name: a.name, mime, size: a.size };
}

/**
 * 上传一组附件。FormData 可带多个 `file` 栏位；站内代理原样透传給网道，
 * 网道回 `{ attachments: [...] }`。走的不是 agentFetch —— 它会把 body 当 JSON
 * 再蓋 Content-Type，multipart 必須保留 boundary。
 */
export async function uploadAgentAttachments(sessionId: string, files: File[]): Promise<AgentAttachment[]> {
  const form = new FormData();
  for (const file of files) form.append("file", file);

  // 不设 Content-Type：FormData 要由浏览器补 multipart boundary。
  const headers = authHeaders("尚未登录，无法上传附件。");

  let res: Response;
  try {
    res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/attachments`, {
      method: "POST",
      headers,
      body: form,
    });
  } catch {
    throw new AgentChatError("network_error", "网络连接失败，请检查网络后再试。");
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw new AgentChatError(mapHttpStatus(res.status), fallbackMessage(res.status), res.status);
    throw new AgentChatError("parse_error", "服务器回应格式错误。", res.status);
  }

  if (!res.ok) {
    throw new AgentChatError(mapErrorCode(data, res.status), extractMessage(data, res.status), res.status);
  }
  const arr = (data as { attachments?: unknown })?.attachments;
  if (!Array.isArray(arr)) {
    throw new AgentChatError("parse_error", "服务器未返回有效的附件清单。");
  }
  return arr as AgentAttachment[];
}

/** 回复一次花费确认。 */
export async function resolveAgentConfirm(sessionId: string, requestId: string, approved: boolean): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, approved }),
  });
}

/** 回复一次 opencode question。answers 是依題目順序的選中標籤。 */
export async function replyAgentQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/question`, {
    method: "POST",
    body: JSON.stringify({ request_id: requestId, answers }),
  });
}

/** 删掉会话，释放上游资源。 */
export async function deleteAgentSession(sessionId: string): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

/**
 * 強制中止當下這輪生成（系统层取消，不是发 prompt 软停）。
 * 网道转发到 opencode 的 /session/:id/abort，正在跑的 assistant turn 立刻终止。
 */
export async function abortAgentSession(sessionId: string): Promise<void> {
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
}

/** 查额度，回传已对齐 AgentQuotaState 形状的结果（reducer 的 applyQuotaSnapshot 直接吃）。 */
export async function fetchAgentQuota(): Promise<AgentQuotaState> {
  const data = await agentFetch("/api/agent/quota");
  const d = (data ?? {}) as AgentQuotaWire;
  return {
    balanceCoins:
      typeof d.balance_coins === "number" && Number.isFinite(d.balance_coins) ? (d.balance_coins as number) : null,
    currency: typeof d.currency === "string" ? (d.currency as string) : "coins",
    available: d.available === true,
    reason: typeof d.reason === "string" ? (d.reason as string) : undefined,
  };
}

/** 取 SSE 只读票。 */
export async function requestSseTicket(sessionId: string): Promise<AgentSseTicket> {
  const data = await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/sse-ticket`, {
    method: "POST",
    body: "{}",
  });
  const d = (data ?? {}) as { ticket?: unknown; events_url?: unknown; expires_in_ms?: unknown };
  if (typeof d.ticket !== "string" || d.ticket.length === 0 || typeof d.events_url !== "string" || d.events_url.length === 0) {
    throw new AgentChatError("parse_error", "服务器未返回有效的 SSE ticket。");
  }
  return {
    ticket: d.ticket,
    events_url: d.events_url,
    expires_in_ms: typeof d.expires_in_ms === "number" ? d.expires_in_ms : undefined,
  };
}

/** 组出带 ticket（与可选 last_event_id 續传游标）的 SSE URL。 */
export function buildEventsUrl(eventsUrl: string, ticket: string, lastEventId?: number): string {
  const url = new URL(eventsUrl);
  url.searchParams.set("ticket", ticket);
  if (typeof lastEventId === "number" && Number.isFinite(lastEventId) && lastEventId > 0) {
    url.searchParams.set("last_event_id", String(lastEventId));
  }
  return url.toString();
}
