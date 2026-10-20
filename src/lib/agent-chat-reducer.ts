// Agent 聊天的纯逻辑核心：SSE 事件 → 可渲染 transcript 的 reducer。
//
// 规则：
//   - 纯函数，不碰 React、不碰 DOM、不碰 Math.random —— 同样输入
//     永远产出同样输出，node --test 可直接测。
//     唯一例外（2026-09-20 思维链计时）：reasoning.delta / 收尾结算会读 Date.now()
//     写入 reasoningStartedAt / reasoningMs 两个时间栏位——网关不送时间戳，秒数
//     只能由本端时钟得出。除这两个栏位外，其余转换仍与输入一一对应。
//   - 永不 mutate 输入 state 或其阵列；每个分支都回新物件（重放的帧除外，
//     直接回同一个 reference，让 React 可以 bail out）。
//   - 条目 id 一律从 seq + kind 推出：`<kind>-<event_id>`（event_id 由网关
//     保证单调递增，所以同 kind 下不会碰撞）；使用者消息 seq 固定 0，
//     用 `user-<该 kind 已有条目数>` 当序，照样稳定且不碰撞。
//
// 断线重连的去重：event_id > 0 且 <= lastEventId 的帧视为重放，整帧丢弃，
// 但 lastEventId 一律推进到看过的最大值。event_id === 0 的帧（手动注入、
// 前端合成的边角）永远处理，也不影响续传游标。

import type { AgentSseEvent } from "./agent-chat-types/types-events";
import type { AgentChatState } from "./agent-chat-types/types-core";
import {
  reduceAudioDone,
  reduceConfirmRequest,
  reduceConfirmResolved,
  reduceDirectorDone,
  reduceImageDone,
  reduceImageFailed,
  reduceMessageDelta,
  reduceQuestionRejected,
  reduceQuestionReplied,
  reduceQuestionRequest,
  reduceQuotaChanged,
  reduceReasoningDelta,
  reduceSessionClosed,
  reduceSessionError,
  reduceToolInvoke,
  reduceToolProgress,
  reduceToolResult,
  reduceTurnDone,
  reduceTurnPlan,
  reduceTurnStatus,
  reduceVideoDone,
} from "./agent-chat-reducer/reduce-messages";
import {
  reduceSubagentDelta,
  reduceSubagentDone,
  reduceSubagentStarted,
  reduceSubagentTool,
} from "./agent-chat-reducer/reduce-runs";
import { reduceSteerStatus } from "./agent-chat-reducer/actions";
// 状态值域的唯一权威（0920 收口）：reducer 只在类型层引用该 union，分支逻辑不变。

// ─────────────────────────── reducer

export function agentChatReducer(state: AgentChatState, event: AgentSseEvent): AgentChatState {
  const eventId = event.event_id;

  // 重放去重：断线重连会带 last_event_id 续传，网关可能把已看过的帧再送一次。
  // 这里整帧丢弃（含 lastEventId 维持不动，因为 eventId <= lastEventId）。
  if (eventId > 0 && eventId <= state.lastEventId) {
    return state;
  }

  // 会话已终结（session.closed 已经被归约过）：只放行 session.closed 自己
  // （reduceSessionClosed/settleClosedTurn 已改成幂等——见下方实现，本端
  // end() 会再合成一个 event_id:0 的 session.closed 做本地收尾，必须原地
  // 无害地过一次，不能重复推一条「会话已结束。」notice）。除此之外任何
  // 事件都是「死会话上的迟到帧」——继续跑各自的分支会诈尸（迟到的
  // message.delta 让已收尾的回合重新 turnActive，迟到的 confirm.request
  // 在死会话上重新长出待确认卡）。只推进 lastEventId 记账，不跑正常分支。
  if (state.closed && event.name !== "session.closed") {
    const nextLastEventId = Math.max(state.lastEventId, eventId);
    return nextLastEventId === state.lastEventId ? state : { ...state, lastEventId: nextLastEventId };
  }

  const nextLastEventId = Math.max(state.lastEventId, eventId);
  const base: AgentChatState = nextLastEventId === state.lastEventId ? state : { ...state, lastEventId: nextLastEventId };

  switch (event.name) {
    case "message.delta":
      return reduceMessageDelta(base, event);
    case "reasoning.delta":
      return reduceReasoningDelta(base, event);
    case "tool.invoke":
      return reduceToolInvoke(base, event);
    case "tool.progress":
      return reduceToolProgress(base, event);
    case "tool.result":
      return reduceToolResult(base, event);
    case "image.done":
      return reduceImageDone(base, event);
    case "video.done":
      return reduceVideoDone(base, event);
    case "audio.done":
      return reduceAudioDone(base, event);
    case "director.done":
      return reduceDirectorDone(base, event);
    case "image.failed":
      return reduceImageFailed(base, event);
    case "turn.done":
      return reduceTurnDone(base, event);
    case "turn.status":
      return reduceTurnStatus(base, event);
    case "turn.plan":
      return reduceTurnPlan(base, event);
    case "confirm.request":
      return reduceConfirmRequest(base, event);
    case "confirm.resolved":
      return reduceConfirmResolved(base, event);
    case "question.request":
      return reduceQuestionRequest(base, event);
    case "steer.status":
      return reduceSteerStatus(base, event);
    case "question.replied":
      return reduceQuestionReplied(base, event);
    case "question.rejected":
      return reduceQuestionRejected(base, event);
    case "quota.changed":
      return reduceQuotaChanged(base, event);
    case "session.error":
      return reduceSessionError(base, event);
    case "session.closed":
      return reduceSessionClosed(base, event);
    case "subagent.started":
      return reduceSubagentStarted(base, event);
    case "subagent.delta":
      return reduceSubagentDelta(base, event);
    case "subagent.done":
      return reduceSubagentDone(base, event);
    case "subagent.tool":
      return reduceSubagentTool(base, event);
    default:
      // canvas.* 等由别处（useCanvasChat）消费的事件，reducer 只推 lastEventId。
      return base;
  }
}

export { lastNonEmptyLine } from "./agent-chat-reducer/reduce-core";
export {
  appendUserTurn,
  applySteerStatus,
  expireQueuedSteers,
  markQueuedSteersAborted,
  applySteerRejection,
  applyQuotaSnapshot,
  resumeZombieTurn,
} from "./agent-chat-reducer/actions";
