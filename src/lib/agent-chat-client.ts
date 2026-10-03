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
import type {
  AgentAttachmentRef,
  AgentQuotaState,
  AgentSessionHistoryResponse,
  AgentSteerStatus,
  OpenCodeMessage,
} from "./agent-chat-types";
import { AGENT_STEER_STATUSES } from "./agent-chat-types";
import { LOCAL_TEST_MODE } from "./local-test-mode";

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
  | "parse_error"
  // REQ-D2（2026-09-23 F-D2 對抗性驗收修復）：steer 端點的 409 契約——「當前沒有
  // 可引導的回合（沒在跑／已中止）」。這不是失敗，是網關要求前端改走正常送出
  //（見 use-agent-chat.send 的 fallback）；混進 gateway_error 會讓那條訊息被吞。
  | "no_active_turn"
  // REQ-D2b（2026-09-23）：steer 重放被拒（同一個 steer_id 的第二次投遞）。
  // **不是**「改走正常送出」——改走就等於把同一條指引送第二次（本刀要禁的事故）。
  // 網關回可辨識錯誤碼：steer_replay_settled / steer_replay_in_flight /
  // steer_payload_mismatch / steer_id_conflict。
  | "steer_replay_rejected";

export class AgentChatError extends Error {
  readonly code: AgentChatErrorCode;
  readonly status?: number;
  /**
   * D2b：重放被拒時，網關帶回的**既有命令真實狀態**（applied/injected/uncertain…）。
   * 前端據此把徽章從本地占位的「未能送達」糾正成事實——沒有這個欄位就只能是猜測。
   * 只有 steer 端點的重放拒絕會帶它。
   */
  readonly steerStatus?: AgentSteerStatus;

  constructor(code: AgentChatErrorCode, message: string, status?: number, steerStatus?: AgentSteerStatus) {
    super(message);
    this.name = "AgentChatError";
    this.code = code;
    this.status = status;
    if (steerStatus) this.steerStatus = steerStatus;
  }
}

/**
 * 终端认证错误：not_authenticated（body 明说没登录）与 unauthorized（裸
 * 401/403，例如 token 过期但网关没回专门的 code）都该让 hook 停止重连，
 * 而不是继续无限重试——两者本质都是「重连也换不回登录态」。
 */
export function isTerminalAuthError(err: unknown): boolean {
  return err instanceof AgentChatError && (err.code === "not_authenticated" || err.code === "unauthorized");
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
  spendable?: unknown;
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
 *
 * `no_active_turn` / `turn_aborted`（steer 端點的 409 契約）映到 no_active_turn：
 * 看的是這條訊息「該不該改走正常送出」，不是哪個端點回的。網關的錯誤 body 有兩種
 * 形狀（站内代理 flat {success,error,code} 與网關 {error:{message,type,code}}），
 * 两種都读。
 */
function mapErrorCode(data: unknown, status: number): AgentChatErrorCode {
  if (data !== null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    // 站内代理回 flat {code}，网關回巢状 {error:{code}}——两种形状都读。
    const code =
      d.code ?? (d.error !== null && typeof d.error === "object" ? (d.error as Record<string, unknown>).code : undefined);
    if (code === "agent_not_signed_in") return "not_authenticated";
    if (code === "no_active_turn" || code === "turn_aborted") return "no_active_turn";
    // D2b：重放拒絕（同一 steer_id 的第二次投遞）——與「沒有可引導的回合」分開歸類，
    // 否則呼叫端會把它當成 409 契約落回正常送出，把同一條指引送第二次。
    if (
      code === "steer_replay_settled" ||
      code === "steer_replay_in_flight" ||
      code === "steer_payload_mismatch" ||
      code === "steer_id_conflict"
    ) {
      return "steer_replay_rejected";
    }
  }
  return mapHttpStatus(status);
}

/** 網關重放拒絕回應裡的任務狀態（真實狀態；認不得就當作沒帶）。 */
function replayStatusFromBody(data: unknown): AgentSteerStatus | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const raw = (data as Record<string, unknown>).status;
  return typeof raw === "string" && (AGENT_STEER_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSteerStatus)
    : undefined;
}

/**
 * steer 端點的「沒有可引導的回合」訊號（409）。前端唯一的合法反應是**改走正常送出**
 * ——內容不得被吞（D2-2 實錘：舊版只把徽章改 failed 就 return，turnActive 陳舊為真
 * 時每次送出都變成失敗的 steer，訊息永遠發不出去）。
 * status 409 也算：steer 端點的 409 只有這一個語義（網關契約）。code 的精確映射
 * 是給 body 透傳完整的情況用的（見 mapErrorCode）。
 *
 * D2b（2026-09-23）唯一的例外：**重放被拒**（steer_replay_rejected）同樣是 409，
 * 但它說的是「這條指引已經有結論／還在途中，不要再送」——落回正常送出就等於把它
 * 送第二次（正是本刀要禁的事故）。所以它明確排除在外（呼叫端另走糾正徽章那條路）。
 */
export function isSteerUnavailableError(err: unknown): boolean {
  if (!(err instanceof AgentChatError)) return false;
  if (err.code === "steer_replay_rejected") return false;
  return err.code === "no_active_turn" || err.status === 409;
}

/** D2b：這次失敗是不是「重放被拒」（同 id 第二次投遞）。 */
export function isSteerReplayRejected(err: unknown): boolean {
  return err instanceof AgentChatError && err.code === "steer_replay_rejected";
}

/**
 * D2b：重放被拒時網關帶回的既有任務狀態；帶不出來時回 "uncertain"——
 * 「已經有結論/還在途中，且不會重送」的最小誠實陳述，絕不回 "queued"（那會讓徽章
 * 停在排隊中，等一張永遠不會來的終態幀）。
 */
export function steerReplayStatus(err: unknown): AgentSteerStatus {
  if (err instanceof AgentChatError && err.steerStatus && err.steerStatus !== "queued") return err.steerStatus;
  return "uncertain";
}

function fallbackMessage(status: number): string {
  if (status === 401 || status === 403) return "登录已失效，请重新登录。";
  if (status === 404) return "找不到该会话或资源。";
  // 罪状 2b：上传超限不能只让 chip 标红——人话说清楚为什么、该怎么办。
  if (status === 413) return "文件过大，超过单次上传上限（约 4.5MB）。请压缩或拆分后再试。";
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
  // LOCAL_TEST_MODE：本機視覺重放/截圖用，送假憑證即可——站內代理的
  // resolveAgentCaller 在該模式下直接換 B 端 key，不驗證這組頭。
  if (LOCAL_TEST_MODE) {
    return { Authorization: "Bearer local-test-token", "x-user-id": "0" };
  }
  const token = getStoredToken();
  const userId = getStoredUser()?.id;
  if (!token || !userId) {
    throw new AgentChatError("not_authenticated", reason);
  }
  return { Authorization: `Bearer ${token}`, "x-user-id": String(userId) };
}

/** 非抛错版身份头：给 fire-and-forget（静默教训提炼等）用。
 *  未登录返回 null（调用方静默跳过），不 throw —— 与 authHeaders 的
 *  「只有一半凭证就报错」语义区分开：无 UI 的旁生请求不该因登录态
 *  缺失而制造噪音。 */
export function tryAuthHeaders(): Record<string, string> | null {
  if (LOCAL_TEST_MODE) {
    return { Authorization: "Bearer local-test-token", "x-user-id": "0" };
  }
  const token = getStoredToken();
  const userId = getStoredUser()?.id;
  if (!token || !userId) return null;
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
    // D2b：重放拒絕的回應帶既有命令的真實狀態（status），透傳進錯誤物件——
    // 呼叫端據此把徽章從本地占位的「未能送達」糾正成事實（見 steerReplayStatus）。
    throw new AgentChatError(
      mapErrorCode(data, res.status),
      extractMessage(data, res.status),
      res.status,
      replayStatusFromBody(data),
    );
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
  /**
   * 網關 2026-08-31 契約新增的會話運轉狀態。選填——舊網關/快取沒這欄位時
   * 不得崩潰，渲染端按 idle 處理。
   */
  status?: "running" | "waiting" | "idle";
  /**
   * 網關 2026-09-12 契約新增的會話摘要標題（opencode 首輪生成）。選填——
   * null/缺欄（佔位名已在網關側歸一化為 null）時不得崩潰，渲染端降級為時間標籤。
   */
  title?: string | null;
}

/** 會話記憶補注：resume/switch 的老會話補上帳戶畫像（best-effort，失敗不打擾）。 */
export async function patchAgentSessionMemory(sessionId: string): Promise<void> {
  try {
    await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/memory`, { method: "POST" });
  } catch {
    // 補不上就算了：下一次建新會話時記憶仍會正常注入。
  }
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
  /**
   * 隐形引导词（2026-08-25 模板卡）：随消息上送，网关把它拼进 system 注入
   * 给模型。不进 transcript、不渲染在聊天流里，用户全程不可见。
   */
  sessionDirective?: string;
}

/**
 * 直連網關發送腿（09-12）：砍掉首字關鍵路徑上的中繼 RTT。
 *
 * 為什麼：消息 POST 一直繞 Vercel 中繼，多付一整個跨境往返 ≈370–494ms
 * （審計實錘）；SSE token 流本就是瀏覽器→網關公網直連，發送腿走同一條路
 * 是對稱性修復。
 *
 * 憑證：復用 requestSseTicket 已釀的同一張票，不另造第二套憑證——票綁定單一
 * session、短時效（10 分鐘）、不含 sk-biz/owner key，外洩半徑只有這一路會話
 * 與這一時窗。票放 Authorization 頭而非 query：query 會被 nginx access log
 * 原樣記錄，POST 我們控制得了頭。
 *
 * 條件化（本補丁先於網關補丁上線，行為必須零迴歸）：網關今天不接受帶票的
 * POST /messages（票按「只讀」設計——sse-ticket 路由註釋與 tools/* 的票用法
 * 全部是 GET）。所以直連腿是「探測」不是「保證」：
 * - 401/403（票被拒——含「老網關不認票」）→ 本票代閂鎖，後續發送全走中繼，
 *   每代最多只付一次學費 RTT。
 * - 網路/CORS preflight/超時錯誤在 fetch 層不可分辨（都是 TypeError）：
 *   連續 2 次失手才閂鎖，成功一次即歸零——防「補丁沒上時反覆流血」，
 *   也防「使用者真網路抖一下就永久縮回中繼」。
 * - 5xx → 這次落回中繼（降級不斷），但不閂鎖：5xx 是服務端瞬態，
 *   不是「票沒有權限」的證據。
 * - 4xx 且帶 JSON body：網關看過 payload 並拒絕——中繼轉發的是同一個 body，
 *   重發一次只会把同一个错再走一遍，直接抛出（與中繼路徑既有語義一致）。
 *
 * 永不重放：直連失手後中繼只發一次；中繼也失敗就照擲錯讓使用者看到真實
 * 原因。成功之後絕不出現第二次 POST。
 *
 * 冪等：檔內（client/hook/gateway 封裝）無任何 idempotency-key 慣例
 * （grep 核實：request_id 僅存在於 confirm/question 的業務迴執），與中繼路徑
 * 維持同一等級——依賴「每用戶動作至多一次 POST」而非重試語義。
 */

/** 直連硬超時：與服務端 callAgentGateway 的 10 秒同一把尺。 */
export const DIRECT_SEND_TIMEOUT_MS = 10_000;

/** 預檢上限：鏡像中繼 messages/route.ts 的欄位校驗，確保兩路徑 400 語義等價。 */
const DIRECT_MAX_CONTENT_LEN = 8_000;
const DIRECT_MAX_CANVAS_STATE_BYTES = 128 * 1024;
const DIRECT_MAX_DIRECTIVE_LEN = 4_000;

/** 直連能力探測的閂鎖狀態（生命週期＝一張票代，重新鑄票即重設）。 */
export interface DirectSendCapability {
  /** true = 本票代停止直連嘗試（401/403，或連續 ≥2 次網路類失手）。 */
  rejected: boolean;
  /** 連續網路類失手計數；任何一次直連成功即歸零。 */
  networkStrikes: number;
}

export function createDirectSendCapability(): DirectSendCapability {
  return { rejected: false, networkStrikes: 0 };
}

/** 發送直連上下文：現任連線的 SSE 票 + 該票代的能力閂鎖。 */
export interface DirectSendContext {
  ticket: AgentSseTicket;
  capability: DirectSendCapability;
}

/**
 * events_url → 同會話消息端點的公網 URL。
 *
 * 構造契約的源頭是中繼 sse-ticket 路由：events_url 恆為
 * `${AGENT_GATEWAY_ORIGIN}/agent/v1/sessions/<id>/events`。只認這個形狀，
 *  pathname 不符（網關換路由/中繼換拼法）就回 null 老實走中繼，不做猜測式
 * 字串裁剪。
 */
export function deriveMessagesUrl(eventsUrl: string): string | null {
  try {
    const url = new URL(eventsUrl);
    if (!/^\/agent\/v1\/sessions\/[^/]+\/events$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/events$/, "/messages");
    return url.toString();
  } catch {
    return null;
  }
}

/** 預檢：與中繼同款形狀/體積校驗。不合格 → 不走直連，讓中繼出 canon 400。 */
function directSendEligible(trimmedContent: string, options?: SendAgentMessageOptions): boolean {
  if (trimmedContent.length === 0 || trimmedContent.length > DIRECT_MAX_CONTENT_LEN) return false;
  const canvas = options?.canvasState;
  if (canvas !== undefined && canvas !== null) {
    if (typeof canvas !== "object") return false;
    try {
      if (JSON.stringify(canvas).length > DIRECT_MAX_CANVAS_STATE_BYTES) return false;
    } catch {
      return false;
    }
  }
  const directive = options?.sessionDirective;
  if (typeof directive === "string" && directive.trim().length > 0 && directive.length > DIRECT_MAX_DIRECTIVE_LEN) {
    return false;
  }
  return true;
}

/** 網路/CORS/超時類失手記一筆；湊滿兩筆升級為票代閂鎖。 */
function noteNetworkStrike(capability: DirectSendCapability): void {
  capability.networkStrikes += 1;
  if (capability.networkStrikes >= 2) capability.rejected = true;
}

/**
 * 打一次直連。回 "sent" 即完成；回 "fallback" 交調用方落回中繼（每票代
 * 閂鎖規則見上）。確定性 4xx（帶可解析 JSON 錯誤體）直接擲 AgentChatError，
 * 不允許落回——那是重放同一個必敗請求。
 */
async function attemptDirectSend(
  messagesUrl: string,
  body: Record<string, unknown>,
  ticketValue: string,
  capability: DirectSendCapability,
): Promise<"sent" | "fallback"> {
  let res: Response;
  try {
    res = await fetch(messagesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ticketValue}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(DIRECT_SEND_TIMEOUT_MS),
    });
  } catch {
    // fetch 拋錯＝連不上／pre-flight 被拒／超時。請求未獲伺服器裁決，落回安全。
    noteNetworkStrike(capability);
    return "fallback";
  }
  if (res.ok) {
    capability.networkStrikes = 0;
    return "sent";
  }
  if (res.status === 401 || res.status === 403) {
    // 票被拒（過期/綁定不符/老網關不認票）：本票代不再試，避免每次發送付學費。
    capability.rejected = true;
    return "fallback";
  }
  if (res.status >= 500) {
    // 服務端瞬態：這次走中繼，保留下輪直連資格。
    return "fallback";
  }
  // 其餘 4xx：嘗試還原網關錯誤體。能還原 → 確定性拒絕，照中繼語義拋錯；
  // 還原不了（nginx 兜底頁等）→ 屬基建異常而非網關裁決，記一筆後落回。
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (data !== null && typeof data === "object") {
    throw new AgentChatError(mapErrorCode(data, res.status), extractMessage(data, res.status), res.status);
  }
  noteNetworkStrike(capability);
  return "fallback";
}

/**
 * 客户端環境上報（型別化白名單；閘道側 sanitizeClientEnvironmentReport 逐值白名單淨化）。
 *
 * 只有客戶端知道的事實隨訊息上報，閘道據此生成環境段。只從**可實證的訊號**推導，
 * 推不出的一律不送（閘道語義＝unknown），絕不送猜測值：
 *   - surface：globalThis.eimuLocal 是否存在（桌面殼 preload 注入）→ desktop-shell / web。
 *   - window_eimu_local / local_save：存在性檢查。
 *   - ffmpeg / ffprobe：僅桌面殼內向 capabilities() 探測（有界等待；失敗／超時即不送）。
 *   - renderHost：客戶端無可信訊號（由部署/伺服器決定）⇒ 不上報，閘道語義 unknown。
 *
 * 回傳值直接作為 POST body 的頂層 client_environment；不含任何自由文字。
 */
const LOCAL_CAPABILITY_PROBE_TIMEOUT_MS = 1500;

async function probeLocalCapabilities(
  g: Record<string, unknown>,
): Promise<{ ffmpeg?: unknown; ffprobe?: unknown } | undefined> {
  const api = g.eimuLocal as { capabilities?: () => Promise<{ ffmpeg?: unknown; ffprobe?: unknown }> };
  if (!api || typeof api.capabilities !== "function") return undefined;
  try {
    return await Promise.race([
      api.capabilities(),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), LOCAL_CAPABILITY_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  }
}

export async function collectClientEnvironment(): Promise<Record<string, unknown>> {
  const g = globalThis as unknown as Record<string, unknown>;
  const eimu = g.eimuLocal as { capabilities?: unknown } | undefined;
  const hasEimu = !!eimu && typeof eimu.capabilities === "function";
  const capabilities: Record<string, boolean> = {
    window_eimu_local: hasEimu,
    local_save:
      typeof g.showSaveFilePicker === "function" || typeof g.showDirectoryPicker === "function",
  };
  if (hasEimu) {
    const probed = await probeLocalCapabilities(g);
    if (typeof probed?.ffmpeg === "boolean") capabilities.ffmpeg = probed.ffmpeg;
    if (typeof probed?.ffprobe === "boolean") capabilities.ffprobe = probed.ffprobe;
  }
  return {
    surface: hasEimu ? "desktop-shell" : "web",
    local_capabilities: capabilities,
  };
}

/**
 * 送一条对话消息。网道回 202 即算已收。
 *
 * 09-12 起帶可選第 4 參數 direct：有現任 SSE 票且未閂鎖 → 先直連網關；
 * 票不可用/401/網路錯/5xx → 落回原有 Vercel 中繼路徑（用戶零感知）。
 * 不帶 direct 時與舊行為逐字元等價（老呼叫點不用改）。
 */
export async function sendAgentMessage(
  sessionId: string,
  content: string,
  options?: SendAgentMessageOptions,
  direct?: DirectSendContext | null,
): Promise<void> {
  // 中繼路由會 trim 後才轉發；直連自己先 trim，兩條路徑送到網關的 content 等價。
  const trimmed = content.trim();
  const body: Record<string, unknown> = { content: trimmed };
  if (options?.canvasState !== undefined && options.canvasState !== null) {
    body.canvas_state = options.canvasState;
  }
  if (typeof options?.sessionDirective === "string" && options.sessionDirective.trim().length > 0) {
    body.session_directive = options.sessionDirective;
  }
  // 客戶端環境上報（本包）：與 content/canvas_state/session_directive 同一 payload，
  // 直連與中繼兩條腿共用同一 body，閘道據此生成環境段（欄位缺失時閘道行為不變）。
  body.client_environment = await collectClientEnvironment();
  if (direct && !direct.capability.rejected) {
    const messagesUrl = deriveMessagesUrl(direct.ticket.events_url);
    if (messagesUrl && directSendEligible(trimmed, options)) {
      const outcome = await attemptDirectSend(messagesUrl, body, direct.ticket.ticket, direct.capability);
      if (outcome === "sent") return;
      // fallback：繼續往下走中繼，僅此一次。
    }
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
 * 拉一個會話的全量聊天歷史（opencode 原始訊息 + 游標元數據）。
 *
 * 站內中繼 GET /api/agent/sessions/[id] 轉發網關 /agent/v1/sessions/:id/messages，
 * 契約：{ messages, event_counter, replay_first_id, fallback?:"replay_only" }。
 * 「回到歷史會話」由這個端點重建 transcript，SSE 只接 event_counter 之後的增量，
 * 不再依賴 1000 幀 ring buffer 回放（長會話會被截斷）。
 *
 * 錯誤沿 agentFetch 既有語義：404 → not_found、非 JSON → parse_error。
 * 這裡只補契約級校驗（messages 必為陣列、event_counter 必為有限非負數），
 * 校驗失敗丟 parse_error 讓調用方走降級路徑；逐 part 防呆歸歸一化層。
 */
export async function fetchAgentSessionMessages(sessionId: string): Promise<AgentSessionHistoryResponse> {
  const data = await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.messages)) {
    throw new AgentChatError("parse_error", "服务器未返回有效的历史消息列表。");
  }
  const counter = d.event_counter;
  if (typeof counter !== "number" || !Number.isFinite(counter) || counter < 0) {
    throw new AgentChatError("parse_error", "服务器未返回有效的事件游标。");
  }
  const replayFirst = d.replay_first_id;
  const fallback = d.fallback === "replay_only" ? ("replay_only" as const) : undefined;
  return {
    messages: d.messages as OpenCodeMessage[],
    event_counter: counter,
    replay_first_id: typeof replayFirst === "number" && Number.isFinite(replayFirst) ? replayFirst : null,
    ...(fallback ? { fallback } : {}),
  };
}

/**
 * REQ-D2：回合中追加一条指引（steer）。
 *
 * 语义与 sendAgentMessage 刻意分开：不终止当前回合、不另起一条用户消息。
 * 回传的 status 是网關的诚实判定——
 *   "injected"：回合卡在 question 断点，这条已注入当前回合（applied_in_turn=true）
 *   "queued"：  当前回合跑着但没有可注入的断点 → 已排队，本回合结束后生效
 * 前端据此显示状态，绝不把 queued 当 injected 用。
 *
 * steer_id 由本端生成（乐观插入的条目要立刻有 id 可以挂状态帧；网關会回显同一个）。
 */
export type AgentSteerAck =
  | { status: "injected"; steer_id: string; injected_into?: string[] }
  | { status: "queued"; steer_id: string; position?: number; deduped?: boolean };

export interface AgentSteerOptions {
  /** 本端生成并上送；非法时网關自行铸号（回传值才是权威）。 */
  steerId?: string;
}

export async function steerAgentSession(
  sessionId: string,
  content: string,
  options?: AgentSteerOptions,
): Promise<AgentSteerAck> {
  const body: Record<string, unknown> = { content: content.trim() };
  if (options?.steerId) body.steer_id = options.steerId;
  const data = await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const d = (data ?? {}) as Record<string, unknown>;
  const steerId = typeof d.steer_id === "string" ? d.steer_id : (options?.steerId ?? "");
  if (d.status === "injected") {
    const into = Array.isArray(d.injected_into)
      ? d.injected_into.filter((x): x is string => typeof x === "string")
      : undefined;
    return { status: "injected", steer_id: steerId, ...(into ? { injected_into: into } : {}) };
  }
  if (d.status === "queued") {
    const position = typeof d.position === "number" && Number.isFinite(d.position) ? d.position : undefined;
    return {
      status: "queued",
      steer_id: steerId,
      ...(typeof position === "number" ? { position } : {}),
      ...(d.deduped === true ? { deduped: true } : {}),
    };
  }
  // 认不得的回应＝契约破裂，照实抛错让调用方显示「未能提交」，不假装成功。
  throw new AgentChatError("parse_error", "服务器未返回有效的引导状态。");
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
    ...(typeof d.spendable === "boolean" ? { spendable: d.spendable as boolean } : {}),
    reason: typeof d.reason === "string" ? (d.reason as string) : undefined,
  };
}

// ─────────────────────────── 用户级设定（罪状 6）

/** 中途输入：turn 中发消息是打断当前轮（steer）还是排队等本轮结束（queue）。 */
export type AgentInterruptMode = "steer" | "queue";
/** 模型性格：高效（先出结果）或沉稳（先充分思考）。 */
export type AgentPersonaMode = "efficient" | "thoughtful";
/** 成本需求：经济 / 均衡 / 高质 三档。 */
export type AgentCostMode = "economy" | "balanced" | "premium";
/** 互动模式：协作 / 预设 / 自动 三档。 */
export type AgentInteractionMode = "collaborate" | "preset" | "auto";

/** 网关 GET/POST /agent/v1/settings 的 shape（默认 steer/efficient/balanced/preset，非法值网关回 400）。
 *  beast_mode：MOE 改革（Wave1-C）转正进白名单——缺字段/脏数据 sanitize 落回 false（默认 OFF）。 */
export interface AgentSettings {
  interrupt_mode: AgentInterruptMode;
  persona: AgentPersonaMode;
  cost_mode: AgentCostMode;
  interaction_mode: AgentInteractionMode;
  beast_mode: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  interrupt_mode: "steer",
  persona: "efficient",
  cost_mode: "balanced",
  interaction_mode: "preset",
  beast_mode: false,
};

const AGENT_SETTINGS_STORAGE_KEY = "agent-settings-v1";

const INTERRUPT_MODES: readonly AgentInterruptMode[] = ["steer", "queue"];
const PERSONA_MODES: readonly AgentPersonaMode[] = ["efficient", "thoughtful"];
const COST_MODES: readonly AgentCostMode[] = ["economy", "balanced", "premium"];
const INTERACTION_MODES: readonly AgentInteractionMode[] = ["collaborate", "preset", "auto"];

/** 逐字段白名单校验：localStorage 与网关的脏数据一律落回默认值。 */
function sanitizeAgentSettings(raw: unknown): AgentSettings {
  const d = (raw ?? {}) as Record<string, unknown>;
  return {
    interrupt_mode: INTERRUPT_MODES.includes(d.interrupt_mode as AgentInterruptMode)
      ? (d.interrupt_mode as AgentInterruptMode)
      : DEFAULT_AGENT_SETTINGS.interrupt_mode,
    persona: PERSONA_MODES.includes(d.persona as AgentPersonaMode)
      ? (d.persona as AgentPersonaMode)
      : DEFAULT_AGENT_SETTINGS.persona,
    cost_mode: COST_MODES.includes(d.cost_mode as AgentCostMode)
      ? (d.cost_mode as AgentCostMode)
      : DEFAULT_AGENT_SETTINGS.cost_mode,
    interaction_mode: INTERACTION_MODES.includes(d.interaction_mode as AgentInteractionMode)
      ? (d.interaction_mode as AgentInteractionMode)
      : DEFAULT_AGENT_SETTINGS.interaction_mode,
    // beast_mode：布尔白名单（=== true 才为 ON，其余脏数据一律默认 OFF）。
    beast_mode: d.beast_mode === true,
  };
}

/**
 * 同步读本地缓存（无窗口环境 / 脏数据 / 缺项都回默认值）。
 * send() 发送前即时读它拿 interrupt_mode —— 零网络，不阻塞发送。
 */
export function readCachedAgentSettings(): AgentSettings {
  if (typeof window === "undefined") return { ...DEFAULT_AGENT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(AGENT_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    return sanitizeAgentSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

/** 只写本地缓存（不触网）。设定弹层改值与挂载回读合并共用这条落盘路径。 */
export function writeCachedAgentSettings(settings: AgentSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeAgentSettings(settings)));
  } catch {
    // 隐私模式等写入失败：只影响下次冷启动的初值，不挡聊天。
  }
}

/**
 * 挂载时回读网关设定：网关为准，缺项用默认。任何失败（未登录 / 网关不可达 /
 * 响应形状不对）静默回默认值 —— 设定不可用不能挡聊天。永不 reject。
 */
export async function getAgentSettings(): Promise<AgentSettings> {
  try {
    const data = await agentFetch("/api/agent/settings", { method: "GET" });
    return sanitizeAgentSettings(data);
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

/**
 * 保存设定：先把合并结果写进本地缓存（立即生效，send 下一拍就能读到），
 * 再异步持久化到网关；网络失败静默 —— 本地已经生效，不打扰对话。
 */
export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<void> {
  const merged = sanitizeAgentSettings({ ...readCachedAgentSettings(), ...patch });
  writeCachedAgentSettings(merged);
  try {
    await agentFetch("/api/agent/settings", { method: "POST", body: JSON.stringify(merged) });
  } catch {
    // 持久化失败不上抛：设定是体验增强，不是对话的前置条件。
  }
}

// ─────────────────────────── 思考级别（2026-10-03）
//
// 输入框「+」右上角的四档菜单：低 / 中 / 高 / 极限，收成一格给用户。
// 它是 persona / cost_mode / beast_mode 三栏的联合快捷档——本表是**唯一真源**，
// 组件与测试都直接读它，不许各自再抄一份 mapping。
// interrupt_mode 不属于这个 mapping（与思考级别正交）：改档时由 saveAgentSettings
// 的「合并现有缓存 + patch」语义原样保留用户当前值（默认 steer）。

/** 思考级别四档（显示名：低/中/高/极限）。 */
export type AgentThinkingLevel = "low" | "medium" | "high" | "extreme";

export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = ["low", "medium", "high", "extreme"];

/** 级別 → AgentSettings 三栏映射（唯一真源，逐档 × 三栏可被测试直接断言）。 */
export const AGENT_THINKING_LEVEL_SETTINGS: Record<
  AgentThinkingLevel,
  Pick<AgentSettings, "persona" | "cost_mode" | "beast_mode">
> = {
  low: { persona: "efficient", cost_mode: "economy", beast_mode: false },
  medium: { persona: "efficient", cost_mode: "balanced", beast_mode: false },
  high: { persona: "thoughtful", cost_mode: "balanced", beast_mode: false },
  extreme: { persona: "thoughtful", cost_mode: "premium", beast_mode: true },
};

/** 显示名（简体中文）。 */
export const AGENT_THINKING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  low: "低",
  medium: "中",
  high: "高",
  extreme: "极限",
};

/** 展开后每个选项的简短说明（不含档名，档名单独占一列）。 */
export const AGENT_THINKING_LEVEL_HINTS: Record<AgentThinkingLevel, string> = {
  low: "更快、更省，适合简单需求",
  medium: "速度与质量兼顾",
  high: "先充分思考再动手，更全面",
  extreme: "最高质量、开启野兽模式",
};

/**
 * 显式选择的思考级别 key：mapping 非满射（如 premium + efficient 无法由四档表达），
 * 所以级别本身另存一份；载入时无记录才由 settings 反推。
 */
export const AGENT_THINKING_LEVEL_STORAGE_KEY = "agent-thinking-level-v1";

/** 级別 → 写入 AgentSettings 的 patch（经 saveAgentSettings 既有链路落地）。 */
export function agentThinkingLevelPatch(level: AgentThinkingLevel): Partial<AgentSettings> {
  return { ...AGENT_THINKING_LEVEL_SETTINGS[level] };
}

/** 由 settings 反推级別：mapping 覆盖不到的組合（如 premium + efficient）回 null。 */
export function inferAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel | null {
  for (const level of AGENT_THINKING_LEVELS) {
    const spec = AGENT_THINKING_LEVEL_SETTINGS[level];
    if (
      settings.persona === spec.persona &&
      settings.cost_mode === spec.cost_mode &&
      settings.beast_mode === spec.beast_mode
    ) {
      return level;
    }
  }
  return null;
}

/** 读取显式保存的思考级别（无记录 / 脏数据 → null）。 */
export function readCachedAgentThinkingLevel(): AgentThinkingLevel | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AGENT_THINKING_LEVEL_STORAGE_KEY);
    return (AGENT_THINKING_LEVELS as readonly string[]).includes(raw ?? "")
      ? (raw as AgentThinkingLevel)
      : null;
  } catch {
    return null;
  }
}

/** 只写本地 localStorage（不触网）：改档立即生效，跨重载保留。 */
export function writeCachedAgentThinkingLevel(level: AgentThinkingLevel): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AGENT_THINKING_LEVEL_STORAGE_KEY, level);
  } catch {
    // 隐私模式等写入失败：只影响下次冷启动的初值，不挡聊天。
  }
}

/**
 * 解析要显示的思考级别：显式记录优先；无记录才由 settings 反推；反推不到显示「中」。
 * **纯读取**——反推不到时绝不改写用户的 settings（只影响显示，用户的真实三栏原样保留）。
 */
export function resolveAgentThinkingLevel(settings: AgentSettings): AgentThinkingLevel {
  return readCachedAgentThinkingLevel() ?? inferAgentThinkingLevel(settings) ?? "medium";
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
  // 0 也要带上：网关靠它区分「从头回放」（历史切换 reset 后重建 transcript）
  // 和「不回放」。省掉 0 会让历史会话载入后永远空白——浏览器 EventSource
  // 首连不带 Last-Event-ID header，query 参数是唯一的游标通道。
  if (typeof lastEventId === "number" && Number.isFinite(lastEventId)) {
    url.searchParams.set("last_event_id", String(lastEventId));
  }
  return url.toString();
}
