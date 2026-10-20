import {
  AGENT_STEER_QUEUE_TTL_MS,
  EMPTY_AGENT_CHAT_STATE,
  type AgentAttachmentRef,
  type AgentChatState,
  type AgentNoticeItem,
  type AgentQuotaState,
  type AgentSseEvent,
  type AgentSteerStatus,
} from "@/lib/agent-chat-types";
import {
  agentChatReducer,
  appendUserTurn,
  applyQuotaSnapshot,
  applySteerRejection,
  applySteerStatus,
  expireQueuedSteers,
  markQueuedSteersAborted,
  resumeZombieTurn,
} from "@/lib/agent-chat-reducer";
import { AgentChatError } from "@/lib/agent-chat-client";
import type { AgentTranscriptItem } from "@/lib/agent-chat-types";

// ─────────────────────────── 常数

export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
/** 运行时 transcript 硬上限。超出丢最旧。持久化截断仍由 persistence 自己的上限负责。 */
const MAX_RUNTIME_CHAT_ITEMS = 200;

/** 存档节流：transcript 变化后至少隔 1s 才写一次 localStorage，避免每次 SSE 帧都写。 */
export const SAVE_THROTTLE_MS = 1_000;

/**
 * REQ-D2：steer id（本端生成）。值域与网关 steer-core.isValidSteerId 逐字对齐
 * （[A-Za-z0-9._-]{1,64}）——乐观插入的条目要立刻有 id 可以挂状态帧，
 * 等网关回号那一轮往返会让徽章闪一下空白。
 */
let steerSeq = 0;
export function newSteerId(): string {
  steerSeq += 1;
  return `steer-${Date.now().toString(36)}-${steerSeq.toString(36)}`;
}

/**
 * 僵尸还魂自愈的防抖窗口：turn.done 之后这个时间内到的内容帧当同 tick 毛刺，
 * 不触发自愈（watchdog 发完 turn.done 紧跟的补发帧不属于「还魂」证据）。
 */
export const ZOMBIE_HEAL_GAP_MS = 800;

// ─────────────────────────── 本 hook 专用的非 SSE action
// agentChatReducer 只吃 AgentSseEvent；乐观插入使用者消息、GET /quota 种子
// 余额、本端错误 notice 这三种「不是网关事件」的状态变更，在这里包成
// 额外 action，委派给对应的纯 helper。

export type AgentChatAction =
  | AgentSseEvent
  | { type: "user"; text: string; attachments?: AgentAttachmentRef[]; steer?: { id: string; status: AgentSteerStatus; position?: number } }
  | { type: "quota"; quota: AgentQuotaState }
  | { type: "notice"; tone: "info" | "error"; text: string }
  // D-8/D-17：恢复上次会话时，把存档灌回 state（还原 items + 续传游标）。
  // savedAt = 存档写入时刻：存档里的「排队中」steer 徽章以它为兜底锚点判逾时（D2-3）。
  | { type: "restore"; items: AgentTranscriptItem[]; lastEventId: number; savedAt?: number }
  // D-17：会话被回收 / 使用者选「开新会话」时，把 transcript 清空重来。
  | { type: "reset" }
  // REQ-D2：steer 状态落地（本地 ack 与 SSE 帧共用同一个纯 helper）与「停止优先」
  // 的本地改判（用户按停止 → 排队中的 steer 全数改判中止）。
  | { type: "steer-ack"; steerId: string; status: AgentSteerStatus; position?: number; queuedAt?: number }
  // D2b：重放被拒（同一 steer_id 第二次投递）——把 catch 里落的「未能送达」占位
  // 纠正成网关带回来的真实状态（见 reducer.applySteerRejection）。
  | { type: "steer-rejection"; steerId: string; status: AgentSteerStatus }
  | { type: "steer-abort-queued" }
  // REQ-D2（D2-3）：排队逾时清扫——「排队中」超过 AGENT_STEER_QUEUE_TTL_MS 还没收到
  // 任何终态帧（网关重启后必然如此）→ 翻 failed「未能送达」，不留永久「排队中」。
  | { type: "steer-expire"; now: number }
  // 僵尸还魂自愈：turn.done 宣告收尾后内容帧仍到达，把回合拉回流式中。
  // hook 侧判定时机（防抖/是否新发送），落地交给纯 helper，与上面同范式。
  | { type: "zombie-resurrect" };

function capRuntimeChatItems(state: AgentChatState): AgentChatState {
  if (state.items.length <= MAX_RUNTIME_CHAT_ITEMS) return state;
  return { ...state, items: state.items.slice(-MAX_RUNTIME_CHAT_ITEMS) };
}

export function chatReducer(state: AgentChatState, action: AgentChatAction): AgentChatState {
  return capRuntimeChatItems(reduceAgentChat(state, action));
}

function reduceAgentChat(state: AgentChatState, action: AgentChatAction): AgentChatState {
  // 网关事件都有 name，本端合成 action 用 type —— 用 in 判别，两边互不干扰。
  if ("name" in action) {
    return agentChatReducer(state, action);
  }
  switch (action.type) {
    case "user":
      return appendUserTurn(state, action.text, action.attachments, action.steer);
    case "steer-ack":
      return applySteerStatus(state, action.steerId, action.status, action.position, action.queuedAt);
    case "steer-rejection":
      return applySteerRejection(state, action.steerId, action.status);
    case "steer-abort-queued":
      return markQueuedSteersAborted(state);
    case "steer-expire":
      return expireQueuedSteers(state, { now: action.now, ttlMs: AGENT_STEER_QUEUE_TTL_MS });
    case "quota":
      return applyQuotaSnapshot(state, action.quota);
    case "notice": {
      let count = 0;
      for (const item of state.items) {
        if (item.kind === "notice") count += 1;
      }
      const notice: AgentNoticeItem = {
        kind: "notice",
        id: `notice-local-${count}`,
        seq: 0,
        tone: action.tone,
        text: action.text,
      };
      return { ...state, items: [...state.items, notice] };
    }
    // 恢复存档：items 与续传游标来自持久化层；额度只留已知的，其余字段回初始。
    case "restore": {
      const restored: AgentChatState = {
        ...EMPTY_AGENT_CHAT_STATE,
        items: action.items.map((item) => ({ ...item })),
        lastEventId: action.lastEventId,
      };
      // D2-3：存档里的「排队中」徽章不能原样复活（网关的 pendingSteers 是 volatile，
      // 重启即消失且不再补终态帧）。以存档时刻为兜底锚点扫一趟，逾时的一律落
      // 「未能送达」；仍在时窗内的记下锚点，由下面排定的清扫定时器兜底。
      return expireQueuedSteers(restored, {
        now: Date.now(),
        ttlMs: AGENT_STEER_QUEUE_TTL_MS,
        ...(typeof action.savedAt === "number" ? { baselineAt: action.savedAt } : {}),
      });
    }
    case "reset":
      return EMPTY_AGENT_CHAT_STATE;
    case "zombie-resurrect":
      return resumeZombieTurn(state);
  }
}

// ─────────────────────────── D-17：会话是否已被网关回收
// sse-ticket 端点对「会话不存在」回 404（client 吃到 code "not_found"）；
// 400 通常是网关判定会话无效。401/403（unauthorized）是登录态问题，
// 不能当成「会话被回收」来清档重开。
export function isSessionReclaimed(err: unknown): boolean {
  if (!(err instanceof AgentChatError)) return false;
  if (err.code === "unauthorized") return false;
  if (err.code === "not_found") return true;
  if (err.code === "bad_request") return true;
  if (typeof err.status === "number" && err.status >= 400 && err.status < 500) return true;
  return false;
}
