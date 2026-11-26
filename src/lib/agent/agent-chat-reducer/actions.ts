import type { AgentSseEvent, AgentSteerStatus } from "../agent-chat-types/types-events";
import type { AgentAttachmentRef, AgentChatState, AgentQuotaState, AgentUserTurnItem } from "../agent-chat-types/types-core";
import { isSteerTerminal, userItemId } from "./reduce-core";
// ─────────────────────────── 纯 helpers（非 SSE 事件的路径）
/** 乐观插入一则使用者消息，不等网关回声。 */
export function appendUserTurn(
  state: AgentChatState,
  text: string,
  attachments?: AgentAttachmentRef[],
  steer?: { id: string; status: AgentSteerStatus; position?: number },
): AgentChatState {
  const item: AgentUserTurnItem = {
    kind: "user",
    id: userItemId(state),
    seq: 0,
    text,
  };
  if (attachments && attachments.length > 0) {
    item.attachments = attachments;
  }
  // REQ-D2：回合中追加的指引（steer）带着状态徽章入场（queued／injected）。
  // 不传 steer 时与改动前逐位等价（无 steer 的乐观插队语义不变）。
  if (steer) {
    item.steer = steer;
  }
  return { ...state, items: [...state.items, item], turnActive: true, turnStatus: undefined };
}

/**
 * REQ-D2：steer.status 帧 —— 把状态挂回那条 user 条目（乐观插入时带的 id）。
 *
 * 三条纪律：
 *   1. 只有带 steer 徽章的 user 条目会被更新（绝不误标普通消息）。
 *   2. 找不到对应 id（例如重连回放丢了乐观条目）→ 原样返回，不凭空造条目。
 *   3. **终态冻结**：条目一旦进终态（injected/applied/aborted/failed），任何后续帧
 *      都不再改动它——既挡住迟到的 queued 帧把它打回「排队中」（D2-5：injected 原本
 *      不是终态，重放/迟到的 queued 帧能把「已注入本回合」打回假排队），也挡住
 *      终态之间互相覆盖（已中止不得被迟到的 injected 帧复活成「已生效」）。
 */
export function reduceSteerStatus(state: AgentChatState, event: AgentSseEvent & { name: "steer.status" }): AgentChatState {
  return applySteerStatus(state, event.data.steer_id, event.data.status, event.data.position);
}

/** 单条 steer 的状态落地（SSE 帧与本地 ack 共用同一实现，两条来路不会漂移）。
 *  queuedAt 只在状态真的落在 queued 时写入（本地 ack 带本端时刻）；其余状态不携带、
 *  也不抹掉既有值（迟到的帧不该让「排队多久了」失真——D2-3 的逾时判定靠它）。 */
export function applySteerStatus(
  state: AgentChatState,
  steerId: string,
  status: AgentSteerStatus,
  position?: number,
  queuedAt?: number,
): AgentChatState {
  let touched = false;
  const items = state.items.map((item) => {
    if (item.kind !== "user" || !item.steer || item.steer.id !== steerId) return item;
    if (isSteerTerminal(item.steer.status)) return item; // 终态冻结（见 reduceSteerStatus 纪律 3）
    touched = true;
    const anchor = status === "queued" ? (queuedAt ?? item.steer.queuedAt) : item.steer.queuedAt;
    return {
      ...item,
      steer: {
        id: steerId,
        status,
        ...(typeof position === "number" ? { position } : {}),
        ...(typeof anchor === "number" ? { queuedAt: anchor } : {}),
      },
    };
  });
  return touched ? { ...state, items } : state;
}

/**
 * D2-3：把「排队中」的徽章按 TTL 收口成终态。
 *
 * 为什么需要它：网关的 pendingSteers 是 volatile——重启／续期后队列整个消失，而且
 * 网关已经不记得那些 steer_id，永远不会补终态帧。此时前端还原出来的条目会永远停在
 * 「排队中」＝反向假话。所以前端以同一个 TTL 自行兜底：逾时仍未见任何终态帧 →
 * 翻 failed（徽章文案＝「引导未能送达（未生效）」）。
 *
 * 纯函数：时钟从 opts.now 进来。基准 = ste.driven 的 queuedAt ?? opts.baselineAt
 * （缺失＝无基准，本趟不动它，也不凭空猜）。**命中基准缺失且有 baselineAt 时把它
 * 写回条目**（queuedAt = baselineAt），让下一趟有具体锚点可判——不留「无锚点」的
 * 永动机徽章。
 */
export function expireQueuedSteers(
  state: AgentChatState,
  opts: { now: number; ttlMs: number; baselineAt?: number },
): AgentChatState {
  let touched = false;
  const items = state.items.map((item) => {
    if (item.kind !== "user" || !item.steer || item.steer.status !== "queued") return item;
    const anchor = item.steer.queuedAt ?? opts.baselineAt;
    if (typeof anchor !== "number") return item;
    if (opts.now - anchor >= opts.ttlMs) {
      touched = true;
      return { ...item, steer: { id: item.steer.id, status: "failed" as AgentSteerStatus, queuedAt: anchor } };
    }
    if (item.steer.queuedAt !== undefined) return item;
    touched = true; // 只在写回锚点时算改动（拿到锚点，下一趟才判得动）
    return { ...item, steer: { ...item.steer, queuedAt: anchor } };
  });
  return touched ? { ...state, items } : state;
}

/**
 * 用户按了停止：把还在排队中的 steer 全部改判中止（停止优先于 steer）。
 *
 * 为什么本端also改判而不是等网关的 aborted 帧：网关 handleAbortSession 里
 * dropPendingSteers 与 abort 落地是同一次调用（确定性），本端这次改判与它同义；
 * 已 injected / applied / aborted / failed 的终态条目不回退（见 applySteerStatus）。
 */
export function markQueuedSteersAborted(state: AgentChatState): AgentChatState {
  let touched = false;
  const items = state.items.map((item) => {
    if (item.kind !== "user" || !item.steer || item.steer.status !== "queued") return item;
    touched = true;
    return { ...item, steer: { id: item.steer.id, status: "aborted" as AgentSteerStatus } };
  });
  return touched ? { ...state, items } : state;
}
/**
 * D2b（2026-09-23）：重放被拒时的徽章纠正。
 *
 * 为什么需要一条专门的路径：hook 在 catch 里先按「未能送达」占位（那是本地猜测，不是
 * 网关事实），而网关对重放的权威回应带着**既有命令的真实状态**（已生效／已中止／未确认）。
 * 走通用 applySteerStatus 的话，先落的 "failed" 已经是终态，纠正会被终态冻结挡掉，
 * 徽章就永远停在「未能送达」＝假话。
 *
 * 边界刻意收得很窄：**只纠正本地占位的 "failed"**，且拒绝把状态写成 "queued"
 *（那会回到「排队中」等一张永远不会来的终态帧）。已是网关-authored 终态
 *（含 uncertain）的条目一律不动——「uncertain 不得被迟到帧改写」的契约不破。
 */
export function applySteerRejection(
  state: AgentChatState,
  steerId: string,
  status: AgentSteerStatus,
): AgentChatState {
  if (status === "queued") return state;
  let touched = false;
  const items = state.items.map((item) => {
    if (item.kind !== "user" || !item.steer || item.steer.id !== steerId) return item;
    if (item.steer.status !== "failed") return item; // 只纠正本地占位，不覆盖任何网关-authored 状态
    touched = true;
    return {
      ...item,
      steer: {
        id: steerId,
        status,
        ...(typeof item.steer.queuedAt === "number" ? { queuedAt: item.steer.queuedAt } : {}),
      },
    };
  });
  return touched ? { ...state, items } : state;
}

/** 用 GET /quota 的结果（已对齐 AgentQuotaState 形状）填入初始余额。 */
export function applyQuotaSnapshot(state: AgentChatState, quota: AgentQuotaState): AgentChatState {
  return { ...state, quota };
}

/**
 * 僵尸还魂自愈：turn.done 已宣告回合收尾，同一条连线却仍有内容帧到达
 * （watchdog 误判后 retry 的输出继续灌进来）。把回合拉回流式中——发送钮
 * 翻回「中止助理生成」，不再停留在「系统说死亡但内容还在冒」的断点假象。
 * 已终结会话的迟到帧由 agentChatReducer 的 closed 门卫丢弃，但本端合成的
 * action 不走那道门，这里自己再守一道；已在流式中则原样返回（bail out）。
 */
export function resumeZombieTurn(state: AgentChatState): AgentChatState {
  if (state.closed || state.turnActive) return state;
  return { ...state, turnActive: true };
}
