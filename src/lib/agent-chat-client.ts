// Agent 聊天的传输层：只负责把请求打到站内的 agent 代理路由，不碰 React。
//
// 身份：token 和 user id 必须成对送出 —— `Authorization: Bearer <token>` 加
// `x-user-id`。agent 代理的 resolveAgentCaller → requireVerifiedUser →
// authenticateImageUser 是拿这两个头一起去问上游 /api/user/self 的：上游会拒绝
// 「令牌持有者 ≠ 头里声称的 id」，所以 id 不是干扰，它是校验的另一半。
// 少送 id，authenticateImageUser 在 `if (!auth || !userId)` 就 401，
// 已登录的用户也会被挡在门外（这正是 agent 一开就报 401 的原因）。
//
// 错误：统一丢 AgentChatError（带 code），UI 分支用 code 判断，不做字串比对。
// 安全：本模组永不 log token、ticket 或任何可能携带它们的 response body。

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
import { UploadAbortedError, xhrUploadForm } from "./agent-uploads";

/** 网道附件清单：download/attachment 解析后可转成 AgentAttachmentRef。 */
export interface AgentAttachment {
  name: string;
  path: string;
  size: number;
  mime: string;
}

// ─────────────────────────── 常数

/** 网道 SSE ticket 的有效期（网道 10 分钟到期），native EventSource 自动重连会拿死票一直重试，所以前端自己管重连。 */
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
  // REQ-D2（2026-09-23 F-D2 对抗性验收修复）：steer 端点的 409 契约——「当前没有
  // 可引导的回合（没在跑／已中止）」。这不是失败，是网关要求前端改走正常送出
  //（见 use-agent-chat.send 的 fallback）；混进 gateway_error 会让那条讯息被吞。
  | "no_active_turn"
  // REQ-D2b（2026-09-23）：steer 重放被拒（同一个 steer_id 的第二次投递）。
  // **不是**「改走正常送出」——改走就等于把同一条指引送第二次（本刀要禁的事故）。
  // 网关回可辨识错误码：steer_replay_settled / steer_replay_in_flight /
  // steer_payload_mismatch / steer_id_conflict。
  | "steer_replay_rejected";

export class AgentChatError extends Error {
  readonly code: AgentChatErrorCode;
  readonly status?: number;
  /**
   * D2b：重放被拒时，网关带回的**既有命令真实状态**（applied/injected/uncertain…）。
   * 前端据此把徽章从本地占位的「未能送达」纠正成事实——没有这个栏位就只能是猜测。
   * 只有 steer 端点的重放拒绝会带它。
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
 * body 里的 code 比 HTTP status 精确时就用它。
 *
 * `agent_not_signed_in`（guard 判定根本没送凭证）映到 not_authenticated：
 * hook 收到它会直接关掉连线并提示登录，而不是把它当「登录过期」反覆重连 ——
 * 没登录的人重连一万次也还是没登录。
 *
 * `no_active_turn` / `turn_aborted`（steer 端点的 409 契约）映到 no_active_turn：
 * 看的是这条讯息「该不该改走正常送出」，不是哪个端点回的。网关的错误 body 有两种
 * 形状（站内代理 flat {success,error,code} 与网关 {error:{message,type,code}}），
 * 两种都读。
 */
function mapErrorCode(data: unknown, status: number): AgentChatErrorCode {
  if (data !== null && typeof data === "object") {
    const d = data as Record<string, unknown>;
    // 站内代理回 flat {code}，网关回巢状 {error:{code}}——两种形状都读。
    const code =
      d.code ?? (d.error !== null && typeof d.error === "object" ? (d.error as Record<string, unknown>).code : undefined);
    if (code === "agent_not_signed_in") return "not_authenticated";
    if (code === "no_active_turn" || code === "turn_aborted") return "no_active_turn";
    // D2b：重放拒绝（同一 steer_id 的第二次投递）——与「没有可引导的回合」分开归类，
    // 否则呼叫端会把它当成 409 契约落回正常送出，把同一条指引送第二次。
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

/** 网关重放拒绝回应里的任务状态（真实状态；认不得就当作没带）。 */
function replayStatusFromBody(data: unknown): AgentSteerStatus | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const raw = (data as Record<string, unknown>).status;
  return typeof raw === "string" && (AGENT_STEER_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSteerStatus)
    : undefined;
}

/**
 * steer 端点的「没有可引导的回合」讯号（409）。前端唯一的合法反应是**改走正常送出**
 * ——内容不得被吞（D2-2 实锤：旧版只把徽章改 failed 就 return，turnActive 陈旧为真
 * 时每次送出都变成失败的 steer，讯息永远发不出去）。
 * status 409 也算：steer 端点的 409 只有这一个语义（网关契约）。code 的精确映射
 * 是给 body 透传完整的情况用的（见 mapErrorCode）。
 *
 * D2b（2026-09-23）唯一的例外：**重放被拒**（steer_replay_rejected）同样是 409，
 * 但它说的是「这条指引已经有结论／还在途中，不要再送」——落回正常送出就等于把它
 * 送第二次（正是本刀要禁的事故）。所以它明确排除在外（呼叫端另走纠正徽章那条路）。
 */
export function isSteerUnavailableError(err: unknown): boolean {
  if (!(err instanceof AgentChatError)) return false;
  if (err.code === "steer_replay_rejected") return false;
  return err.code === "no_active_turn" || err.status === 409;
}

/** D2b：这次失败是不是「重放被拒」（同 id 第二次投递）。 */
export function isSteerReplayRejected(err: unknown): boolean {
  return err instanceof AgentChatError && err.code === "steer_replay_rejected";
}

/**
 * D2b：重放被拒时网关带回的既有任务状态；带不出来时回 "uncertain"——
 * 「已经有结论/还在途中，且不会重送」的最小诚实陈述，绝不回 "queued"（那会让徽章
 * 停在排队中，等一张永远不会来的终态帧）。
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
 * 网道回 `{ error: { message, type, code } }`，两种都要能读。
 */
/** 网关技术名词 → 使用者能懂的人话。只映射确定语义的，未知的原样透传。 */
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
  // LOCAL_TEST_MODE：本机视觉重放/截图用，送假凭证即可——站内代理的
  // resolveAgentCaller 在该模式下直接换 B 端 key，不验证这组头。
  if (process.env.NODE_ENV !== "production" && LOCAL_TEST_MODE) {
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
  if (process.env.NODE_ENV !== "production" && LOCAL_TEST_MODE) {
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
    // D2b：重放拒绝的回应带既有命令的真实状态（status），透传进错误物件——
    // 呼叫端据此把徽章从本地占位的「未能送达」纠正成事实（见 steerReplayStatus）。
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

/** 会话目录项：对话历史 dropdown 的数据源（网关 GET /agent/v1/sessions 透传）。 */
export interface AgentSessionSummary {
  session_id: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number;
  /**
   * 网关 2026-08-31 契约新增的会话运转状态。选填——旧网关/快取没这栏位时
   * 不得崩溃，渲染端按 idle 处理。
   */
  status?: "running" | "waiting" | "idle";
  /**
   * 网关 2026-09-12 契约新增的会话摘要标题（opencode 首轮生成）。选填——
   * null/缺栏（占位名已在网关侧归一化为 null）时不得崩溃，渲染端降级为时间标签。
   */
  title?: string | null;
}

/** 会话记忆补注：resume/switch 的老会话补上帐户画像（best-effort，失败不打扰）。 */
export async function patchAgentSessionMemory(sessionId: string): Promise<void> {
  try {
    await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/memory`, { method: "POST" });
  } catch {
    // 补不上就算了：下一次建新会话时记忆仍会正常注入。
  }
}
/** 列出当前用户的历史会话（按 updated_at 降序）。 */
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
 * 直连网关发送腿（09-12）：砍掉首字关键路径上的中继 RTT。
 *
 * 为什么：消息 POST 一直绕 Vercel 中继，多付一整个跨境往返 ≈370–494ms
 * （审计实锤）；SSE token 流本就是浏览器→网关公网直连，发送腿走同一条路
 * 是对称性修复。
 *
 * 凭证：复用 requestSseTicket 已酿的同一张票，不另造第二套凭证——票绑定单一
 * session、短时效（10 分钟）、不含 sk-biz/owner key，外泄半径只有这一路会话
 * 与这一时窗。票放 Authorization 头而非 query：query 会被 nginx access log
 * 原样记录，POST 我们控制得了头。
 *
 * 条件化（本补丁先于网关补丁上线，行为必须零回归）：网关今天不接受带票的
 * POST /messages（票按「只读」设计——sse-ticket 路由注释与 tools/* 的票用法
 * 全部是 GET）。所以直连腿是「探测」不是「保证」：
 * - 401/403（票被拒——含「老网关不认票」）→ 本票代闩锁，后续发送全走中继，
 *   每代最多只付一次学费 RTT。
 * - 网路/CORS preflight/超时错误在 fetch 层不可分辨（都是 TypeError）：
 *   连续 2 次失手才闩锁，成功一次即归零——防「补丁没上时反覆流血」，
 *   也防「使用者真网路抖一下就永久缩回中继」。
 * - 5xx → 这次落回中继（降级不断），但不闩锁：5xx 是服务端瞬态，
 *   不是「票没有权限」的证据。
 * - 4xx 且带 JSON body：网关看过 payload 并拒绝——中继转发的是同一个 body，
 *   重发一次只会把同一个错再走一遍，直接抛出（与中继路径既有语义一致）。
 *
 * 永不重放：直连失手后中继只发一次；中继也失败就照掷错让使用者看到真实
 * 原因。成功之后绝不出现第二次 POST。
 *
 * 幂等：档内（client/hook/gateway 封装）无任何 idempotency-key 惯例
 * （grep 核实：request_id 仅存在于 confirm/question 的业务回执），与中继路径
 * 维持同一等级——依赖「每用户动作至多一次 POST」而非重试语义。
 */

/** 直连硬超时：与服务端 callAgentGateway 的 10 秒同一把尺。 */
export const DIRECT_SEND_TIMEOUT_MS = 10_000;

/** 预检上限：镜像中继 messages/route.ts 的栏位校验，确保两路径 400 语义等价。 */
const DIRECT_MAX_CONTENT_LEN = 8_000;
const DIRECT_MAX_CANVAS_STATE_BYTES = 128 * 1024;
const DIRECT_MAX_DIRECTIVE_LEN = 4_000;

/** 直连能力探测的闩锁状态（生命周期＝一张票代，重新铸票即重设）。 */
export interface DirectSendCapability {
  /** true = 本票代停止直连尝试（401/403，或连续 ≥2 次网路类失手）。 */
  rejected: boolean;
  /** 连续网路类失手计数；任何一次直连成功即归零。 */
  networkStrikes: number;
}

export function createDirectSendCapability(): DirectSendCapability {
  return { rejected: false, networkStrikes: 0 };
}

/** 发送直连上下文：现任连线的 SSE 票 + 该票代的能力闩锁。 */
export interface DirectSendContext {
  ticket: AgentSseTicket;
  capability: DirectSendCapability;
}

/**
 * events_url → 同会话消息端点的公网 URL。
 *
 * 构造契约的源头是中继 sse-ticket 路由：events_url 恒为
 * `${AGENT_GATEWAY_ORIGIN}/agent/v1/sessions/<id>/events`。只认这个形状，
 *  pathname 不符（网关换路由/中继换拼法）就回 null 老实走中继，不做猜测式
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

/** 预检：与中继同款形状/体积校验。不合格 → 不走直连，让中继出 canon 400。 */
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

/** 网路/CORS/超时类失手记一笔；凑满两笔升级为票代闩锁。 */
function noteNetworkStrike(capability: DirectSendCapability): void {
  capability.networkStrikes += 1;
  if (capability.networkStrikes >= 2) capability.rejected = true;
}

/**
 * 打一次直连。回 "sent" 即完成；回 "fallback" 交调用方落回中继（每票代
 * 闩锁规则见上）。确定性 4xx（带可解析 JSON 错误体）直接掷 AgentChatError，
 * 不允许落回——那是重放同一个必败请求。
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
    // fetch 抛错＝连不上／pre-flight 被拒／超时。请求未获伺服器裁决，落回安全。
    noteNetworkStrike(capability);
    return "fallback";
  }
  if (res.ok) {
    capability.networkStrikes = 0;
    return "sent";
  }
  if (res.status === 401 || res.status === 403) {
    // 票被拒（过期/绑定不符/老网关不认票）：本票代不再试，避免每次发送付学费。
    capability.rejected = true;
    return "fallback";
  }
  if (res.status >= 500) {
    // 服务端瞬态：这次走中继，保留下轮直连资格。
    return "fallback";
  }
  // 其余 4xx：尝试还原网关错误体。能还原 → 确定性拒绝，照中继语义抛错；
  // 还原不了（nginx 兜底页等）→ 属基建异常而非网关裁决，记一笔后落回。
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
 * 客户端环境上报（型别化白名单；闸道侧 sanitizeClientEnvironmentReport 逐值白名单净化）。
 *
 * 只有客户端知道的事实随讯息上报，闸道据此生成环境段。只从**可实证的讯号**推导，
 * 推不出的一律不送（闸道语义＝unknown），绝不送猜测值：
 *   - surface：globalThis.eimuLocal 是否存在（桌面壳 preload 注入）→ desktop-shell / web。
 *   - window_eimu_local / local_save：存在性检查。
 *   - ffmpeg / ffprobe：仅桌面壳内向 capabilities() 探测（有界等待；失败／超时即不送）。
 *   - renderHost：客户端无可信讯号（由部署/伺服器决定）⇒ 不上报，闸道语义 unknown。
 *
 * 回传值直接作为 POST body 的顶层 client_environment；不含任何自由文字。
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
 * 09-12 起带可选第 4 参数 direct：有现任 SSE 票且未闩锁 → 先直连网关；
 * 票不可用/401/网路错/5xx → 落回原有 Vercel 中继路径（用户零感知）。
 * 不带 direct 时与旧行为逐字元等价（老呼叫点不用改）。
 */
export async function sendAgentMessage(
  sessionId: string,
  content: string,
  options?: SendAgentMessageOptions,
  direct?: DirectSendContext | null,
): Promise<void> {
  // 中继路由会 trim 后才转发；直连自己先 trim，两条路径送到网关的 content 等价。
  const trimmed = content.trim();
  const body: Record<string, unknown> = { content: trimmed };
  if (options?.canvasState !== undefined && options.canvasState !== null) {
    body.canvas_state = options.canvasState;
  }
  if (typeof options?.sessionDirective === "string" && options.sessionDirective.trim().length > 0) {
    body.session_directive = options.sessionDirective;
  }
  // 客户端环境上报（本包）：与 content/canvas_state/session_directive 同一 payload，
  // 直连与中继两条腿共用同一 body，闸道据此生成环境段（栏位缺失时闸道行为不变）。
  body.client_environment = await collectClientEnvironment();
  if (direct && !direct.capability.rejected) {
    const messagesUrl = deriveMessagesUrl(direct.ticket.events_url);
    if (messagesUrl && directSendEligible(trimmed, options)) {
      const outcome = await attemptDirectSend(messagesUrl, body, direct.ticket.ticket, direct.capability);
      if (outcome === "sent") return;
      // fallback：继续往下走中继，仅此一次。
    }
  }
  await agentFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * 网道附件清单：每个元素带 path/mime/size，直接转成 AgentAttachmentRef。
 * 依 mime 决定 kind：影像 → "image"，影片 → "video"，其余 → "document"。
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
 * 上传一组附件。FormData 可带多个 `file` 栏位；站内代理原样透传给网道，
 * 网道回 `{ attachments: [...] }`。走的不是 agentFetch —— 它会把 body 当 JSON
 * 再盖 Content-Type，multipart 必须保留 boundary。
 */
export async function uploadAgentAttachments(
  sessionId: string,
  files: File[],
  opts: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<AgentAttachment[]> {
  const form = new FormData();
  for (const file of files) form.append("file", file);

  // 不设 Content-Type：FormData 要由浏览器补 multipart boundary。
  const headers = authHeaders("尚未登录，无法上传附件。");

  // 缺陷 A（2026-10-04）：改用带进度的 XHR（xhrUploadForm）而非裸 fetch——
  // 大档上传期间给得出真实字节进度，且能经 signal 取消。错误语义与旧 fetch 版逐条对齐。
  let status: number;
  let text: string;
  try {
    ({ status, text } = await xhrUploadForm(
      `/api/agent/sessions/${encodeURIComponent(sessionId)}/attachments`,
      form,
      { headers, onProgress: opts.onProgress, signal: opts.signal },
    ));
  } catch (err) {
    if (err instanceof UploadAbortedError) throw err;
    throw new AgentChatError("network_error", "网络连接失败，请检查网络后再试。");
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (status < 200 || status >= 300) throw new AgentChatError(mapHttpStatus(status), fallbackMessage(status), status);
    throw new AgentChatError("parse_error", "服务器回应格式错误。", status);
  }

  if (status < 200 || status >= 300) {
    throw new AgentChatError(mapErrorCode(data, status), extractMessage(data, status), status);
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

/** 回复一次 opencode question。answers 是依题目顺序的选中标签。 */
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
 * 拉一个会话的全量聊天历史（opencode 原始讯息 + 游标元数据）。
 *
 * 站内中继 GET /api/agent/sessions/[id] 转发网关 /agent/v1/sessions/:id/messages，
 * 契约：{ messages, event_counter, replay_first_id, fallback?:"replay_only" }。
 * 「回到历史会话」由这个端点重建 transcript，SSE 只接 event_counter 之后的增量，
 * 不再依赖 1000 帧 ring buffer 回放（长会话会被截断）。
 *
 * 错误沿 agentFetch 既有语义：404 → not_found、非 JSON → parse_error。
 * 这里只补契约级校验（messages 必为阵列、event_counter 必为有限非负数），
 * 校验失败丢 parse_error 让调用方走降级路径；逐 part 防呆归归一化层。
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
 * 回传的 status 是网关的诚实判定——
 *   "injected"：回合卡在 question 断点，这条已注入当前回合（applied_in_turn=true）
 *   "queued"：  当前回合跑着但没有可注入的断点 → 已排队，本回合结束后生效
 * 前端据此显示状态，绝不把 queued 当 injected 用。
 *
 * steer_id 由本端生成（乐观插入的条目要立刻有 id 可以挂状态帧；网关会回显同一个）。
 */
export type AgentSteerAck =
  | { status: "injected"; steer_id: string; injected_into?: string[] }
  | { status: "queued"; steer_id: string; position?: number; deduped?: boolean };

export interface AgentSteerOptions {
  /** 本端生成并上送；非法时网关自行铸号（回传值才是权威）。 */
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
 * 强制中止当下这轮生成（系统层取消，不是发 prompt 软停）。
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

/** 级别 → AgentSettings 三栏映射（唯一真源，逐档 × 三栏可被测试直接断言）。 */
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

/** 级别 → 写入 AgentSettings 的 patch（经 saveAgentSettings 既有链路落地）。 */
export function agentThinkingLevelPatch(level: AgentThinkingLevel): Partial<AgentSettings> {
  return { ...AGENT_THINKING_LEVEL_SETTINGS[level] };
}

/** 由 settings 反推级别：mapping 覆盖不到的组合（如 premium + efficient）回 null。 */
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

/** 组出带 ticket（与可选 last_event_id 续传游标）的 SSE URL。 */
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
