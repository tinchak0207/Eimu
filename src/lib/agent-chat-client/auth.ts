import type { AgentSteerStatus } from "../agent-chat-types/types-events";
import type { AgentChatErrorCode } from "./types";
import { AgentChatError } from "./types";
import { AGENT_STEER_STATUSES } from "../agent-chat-types/types-events";
import { getStoredToken, getStoredUser } from "../new-api-client";
import { LOCAL_TEST_MODE } from "../local-test-mode";
// ─────────────────────────── 内部 helper

export function mapHttpStatus(status: number): AgentChatErrorCode {
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
export function mapErrorCode(data: unknown, status: number): AgentChatErrorCode {
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

export function fallbackMessage(status: number): string {
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

export function extractMessage(data: unknown, status: number): string {
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
export function authHeaders(reason: string): Record<string, string> {
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
export async function agentFetch(path: string, init?: RequestInit): Promise<unknown> {
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
