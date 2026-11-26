import type { AgentSseTicket, DirectSendCapability, SendAgentMessageOptions } from "./types";
import { AgentChatError } from "./types";
import { agentFetch, extractMessage, mapErrorCode } from "./auth";
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
export function createDirectSendCapability(): DirectSendCapability {
  return { rejected: false, networkStrikes: 0 };
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
export function directSendEligible(trimmedContent: string, options?: SendAgentMessageOptions): boolean {
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
export async function attemptDirectSend(
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
