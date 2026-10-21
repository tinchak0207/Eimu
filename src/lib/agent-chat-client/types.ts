import type { AgentSteerStatus } from "../agent-chat-types/types-events";
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
/** 直连能力探测的闩锁状态（生命周期＝一张票代，重新铸票即重设）。 */
export interface DirectSendCapability {
  /** true = 本票代停止直连尝试（401/403，或连续 ≥2 次网路类失手）。 */
  rejected: boolean;
  /** 连续网路类失手计数；任何一次直连成功即归零。 */
  networkStrikes: number;
}
/** 发送直连上下文：现任连线的 SSE 票 + 该票代的能力闩锁。 */
export interface DirectSendContext {
  ticket: AgentSseTicket;
  capability: DirectSendCapability;
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

export const AGENT_SETTINGS_STORAGE_KEY = "agent-settings-v1";

export const INTERRUPT_MODES: readonly AgentInterruptMode[] = ["steer", "queue"];
export const PERSONA_MODES: readonly AgentPersonaMode[] = ["efficient", "thoughtful"];
export const COST_MODES: readonly AgentCostMode[] = ["economy", "balanced", "premium"];
export const INTERACTION_MODES: readonly AgentInteractionMode[] = ["collaborate", "preset", "auto"];
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
