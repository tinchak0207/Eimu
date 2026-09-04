// Agent 聊天的纯逻辑核心：SSE 事件 → 可渲染 transcript 的 reducer。
//
// 规则：
//   - 纯函数，不碰 React、不碰 DOM、不碰 Math.random / Date.now —— 同样输入
//     永远产出同样输出，node --test 可直接测。
//   - 永不 mutate 输入 state 或其阵列；每个分支都回新物件（重放的帧除外，
//     直接回同一个 reference，让 React 可以 bail out）。
//   - 条目 id 一律从 seq + kind 推出：`<kind>-<event_id>`（event_id 由网关
//     保证单调递增，所以同 kind 下不会碰撞）；使用者消息 seq 固定 0，
//     用 `user-<该 kind 已有条目数>` 当序，照样稳定且不碰撞。
//
// 断线重连的去重：event_id > 0 且 <= lastEventId 的帧视为重放，整帧丢弃，
// 但 lastEventId 一律推进到看过的最大值。event_id === 0 的帧（手动注入、
// 前端合成的边角）永远处理，也不影响续传游标。

import {
  type AgentAttachmentRef,
  type AgentChatState,
  type AgentDirectorItem,
  type AgentImageItem,
  type AgentNoticeItem,
  type AgentPendingConfirm,
  type AgentPendingQuestion,
  type AgentQuotaState,
  type AgentSseEvent,
  type AgentSubagentItem,
  type AgentToolCallItem,
  type AgentTranscriptItem,
  type AgentUserTurnItem,
  type AgentVideoItem,
} from "./agent-chat-types";

// ─────────────────────────── 条目 id 生成

/** 事件类条目：seq = event_id，id = `<kind>-<event_id>`。 */
function eventItemId(kind: string, eventId: number): string {
  return `${kind}-${eventId}`;
}

/**
 * 使用者消息：seq 契约上是 0，所以 id 用「该 kind 已有条目数」当序，
 * 保证同一个 state 内不碰撞且插入顺序稳定。
 */
function userItemId(state: AgentChatState): string {
  let count = 0;
  for (const item of state.items) {
    if (item.kind === "user") count += 1;
  }
  return `user-${count}`;
}

// ─────────────────────────── 事件对应分支

function reduceMessageDelta(state: AgentChatState, event: AgentSseEvent & { name: "message.delta" }): AgentChatState {
  const text = event.data.text;
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    // 只对「正在 streaming 的最后一个助手条目」追加；否则开新条目。
    items[items.length - 1] = { ...last, text: last.text + text };
  } else {
    items.push({
      kind: "assistant",
      id: eventItemId("assistant", event.event_id),
      seq: event.event_id,
      text,
      streaming: true,
    });
  }
  return { ...state, items, turnActive: true, turnStatus: undefined };
}

function reduceReasoningDelta(state: AgentChatState, event: AgentSseEvent & { name: "reasoning.delta" }): AgentChatState {
  const text = event.data.text;
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    // 思維鏈通常先於最終文字到來；若已開 assistant 條目就直接累加。
    items[items.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + text };
  } else {
    // reasoning 先到、text 還沒來：開 streaming 條目，只填 reasoning。
    items.push({
      kind: "assistant",
      id: eventItemId("assistant", event.event_id),
      seq: event.event_id,
      text: "",
      reasoning: text,
      streaming: true,
    });
  }
  return { ...state, items, turnActive: true };
}

function reduceToolInvoke(state: AgentChatState, event: AgentSseEvent & { name: "tool.invoke" }): AgentChatState {
  const item: AgentToolCallItem = {
    kind: "tool",
    id: eventItemId("tool", event.event_id),
    seq: event.event_id,
    tool: event.data.tool,
    argsSummary: event.data.args_summary,
    status: "running",
  };
  return { ...state, items: [...state.items, item], turnActive: true };
}

function reduceToolProgress(state: AgentChatState, event: AgentSseEvent & { name: "tool.progress" }): AgentChatState {
  const { tool, done, total, label } = event.data;
  const items = state.items.slice();
  // 回填「最近一个同名且仍 running」的工具卡（与 reduceToolResult 同定位逻辑）。
  // 找不到 running 卡 = invoke 丢了或已结算，进度帧无意义，直接丢弃不新建条目。
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "tool" && it.tool === tool && it.status === "running") {
      items[i] = { ...it, progress: { done, total, ...(label ? { label } : {}) } };
      return { ...state, items, turnActive: true };
    }
  }
  return state;
}

function reduceToolResult(state: AgentChatState, event: AgentSseEvent & { name: "tool.result" }): AgentChatState {
  const { tool, ok, cost_coins, error } = event.data;
  const errText = !ok ? error?.human_message ?? error?.message ?? undefined : undefined;
  const items = state.items.slice();
  // 找「最近一个同名且还在 running 的工具条目」回填。没有就补一笔
  // 已定案的条目 —— 网关可能因为去重或断线把 invoke 弄丢了。
  let target = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "tool" && it.tool === tool && it.status === "running") {
      target = i;
      break;
    }
  }
  if (target >= 0) {
    const existing = items[target];
    if (existing.kind === "tool") {
      items[target] = { ...existing, status: ok ? "ok" : "failed", costCoins: cost_coins, error: errText };
    }
  } else {
    items.push({
      kind: "tool",
      id: eventItemId("tool", event.event_id),
      seq: event.event_id,
      tool,
      argsSummary: undefined,
      status: ok ? "ok" : "failed",
      costCoins: cost_coins,
      error: errText,
    });
  }
  return { ...state, items, turnActive: true };
}

function reduceImageDone(state: AgentChatState, event: AgentSseEvent & { name: "image.done" }): AgentChatState {
  const { url, cost_coins, task_id, recipe } = event.data;
  const exists = state.items.some((it) => it.kind === "image" && it.url === url);
  if (!exists) {
    // seq 是展示序号（锚定文案里的「第 N 张」）：必须是会话内第几张图，
    // 不是网关全局 event_id——后者是几百上千的流水号，念出来像胡话。
    const imageSeq = state.items.filter((it) => it.kind === "image").length + 1;
    const item: AgentImageItem = {
      kind: "image",
      id: eventItemId("image", event.event_id),
      seq: imageSeq,
      url,
      costCoins: cost_coins,
      taskId: task_id,
      recipe,
    };
    return { ...state, items: [...state.items, item], turnActive: true, turnStatus: undefined };
  }
  // 同 url 已存在：忽略内容，但仍是「助手在产出」的讯号，turnActive 照设。
  return { ...state, turnActive: true, turnStatus: undefined };
}

function reduceVideoDone(state: AgentChatState, event: AgentSseEvent & { name: "video.done" }): AgentChatState {
  const { url, cost_coins, task_id, media_kind } = event.data;
  const exists = state.items.some((it) => it.kind === "video" && it.url === url);
  if (!exists) {
    // seq 是展示序号：会话内第几条影片，不是网关全局 event_id（同 image.done 的理由）。
    const videoSeq = state.items.filter((it) => it.kind === "video").length + 1;
    const item: AgentVideoItem = {
      kind: "video",
      id: eventItemId("video", event.event_id),
      seq: videoSeq,
      url,
      costCoins: cost_coins,
      taskId: task_id,
      mediaKind: media_kind,
    };
    return { ...state, items: [...state.items, item], turnActive: true, turnStatus: undefined };
  }
  // 同 url 已存在：忽略内容，但仍是「助手在产出」的讯号，turnActive 照设。
  return { ...state, turnActive: true, turnStatus: undefined };
}

/**
 * 導演台：會話內唯一活卡。同槽（同一張 director 卡）按 revision 替換，
 * 不堆積歷史卡——director.done 是工程狀態廣播不是成果事件，堆積會把
 * 轉錄刷成版本流水帳。遲到幀（revision <= 現有）原樣 bail out。
 * reset（action="reset"）發 revision 0：小於任何現有 revision，活卡照替換
 * ——工程已被清空，舊卡留著就是謊報。
 */
function reduceDirectorDone(state: AgentChatState, event: AgentSseEvent & { name: "director.done" }): AgentChatState {
  const { session_id, revision, action, plan, active_shot, schematic, health, counts } = event.data;
  const items = state.items.slice();
  let existing = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "director" && it.directorSessionId === session_id) {
      existing = i;
      break;
    }
  }
  if (existing >= 0) {
    const prev = items[existing];
    if (prev.kind === "director") {
      if (revision > prev.revision || action === "reset") {
        items[existing] = {
          ...prev,
          seq: event.event_id,
          revision,
          action,
          plan,
          activeShot: active_shot,
          schematic,
          health,
          counts,
        };
        return { ...state, items, turnActive: true, turnStatus: undefined };
      }
      return state;
    }
  }
  const item: AgentDirectorItem = {
    kind: "director",
    id: eventItemId("director", event.event_id),
    seq: event.event_id,
    directorSessionId: session_id,
    revision,
    action,
    plan,
    activeShot: active_shot,
    schematic,
    health,
    counts,
  };
  return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
}

function reduceImageFailed(state: AgentChatState, event: AgentSseEvent & { name: "image.failed" }): AgentChatState {  // 失败也进对话流（与 image.done 对称）：用户在聊天里直接看到「没排上队，
  // 费用已退回」，不依赖画布节点才知道发生了什么。
  const { reason, refunded } = event.data;
  const text = refunded ? `这张图没排上队，费用已退回${reason ? `（${reason}）` : ""}。` : `这张图生成失败${reason ? `（${reason}）` : ""}。`;
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "error",
    text,
  };
  return { ...state, items: [...state.items, notice], turnActive: true, turnStatus: undefined };
}

/**
 * 多行文本的最后一个非空行。subagent.delta 并入后只保留它——子代理输出可能
 * 上千行，条目里永远只存一行，这是防溢出的硬要求，不是优化。
 */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return "";
}

function reduceSubagentStarted(
  state: AgentChatState,
  event: AgentSseEvent & { name: "subagent.started" },
): AgentChatState {
  const { id, label } = event.data;
  const items = state.items.slice();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "subagent" && it.subagentId === id) {
      // 同 id 重复 started（重连补发等）：标签没变就 bail out，变了才替换。
      if (it.label === label) return state;
      items[i] = { ...it, label };
      return { ...state, items, turnActive: true };
    }
  }
  const item: AgentSubagentItem = {
    kind: "subagent",
    id: eventItemId("subagent", event.event_id),
    seq: event.event_id,
    subagentId: id,
    label,
    lastLine: "",
    status: "running",
  };
  return { ...state, items: [...items, item], turnActive: true };
}

function reduceSubagentDelta(
  state: AgentChatState,
  event: AgentSseEvent & { name: "subagent.delta" },
): AgentChatState {
  const { id, text } = event.data;
  const items = state.items.slice();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "subagent" && it.subagentId === id) {
      // done 之后的迟到 delta 不再改写已定案的卡。
      if (it.status !== "running") return state;
      items[i] = { ...it, lastLine: lastNonEmptyLine(it.lastLine + text) };
      return { ...state, items, turnActive: true };
    }
  }
  // started 丢失（坏帧/断线）：补一条 running 条目，别让 delta 落空。
  const item: AgentSubagentItem = {
    kind: "subagent",
    id: eventItemId("subagent", event.event_id),
    seq: event.event_id,
    subagentId: id,
    label: "子任务",
    lastLine: lastNonEmptyLine(text),
    status: "running",
  };
  return { ...state, items: [...items, item], turnActive: true };
}

function reduceSubagentDone(
  state: AgentChatState,
  event: AgentSseEvent & { name: "subagent.done" },
): AgentChatState {
  const { id, status, summary } = event.data;
  const items = state.items.slice();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "subagent" && it.subagentId === id) {
      items[i] = { ...it, status, ...(summary !== undefined ? { summary } : {}) };
      return { ...state, items };
    }
  }
  // started/delta 全丢：补一条已定案条目（lastLine 留空，摘要进卡）。
  const item: AgentSubagentItem = {
    kind: "subagent",
    id: eventItemId("subagent", event.event_id),
    seq: event.event_id,
    subagentId: id,
    label: "子任务",
    lastLine: "",
    status,
    ...(summary !== undefined ? { summary } : {}),
  };
  return { ...state, items: [...items, item] };
}

/** 回合收尾时把 subagent 条目整批清掉：状态栏只在回合进行中有意义。 */
function clearSubagentItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  return items.filter((it) => it.kind !== "subagent");
}

/**
 * 收尾用的条目转换：把 streaming 的助手标记停掉、把还在 running 的工具判死。
 * 用 for 循环而非 map，是为了让每个分支都有确定性别（map 的回传类型会被
 * 宽化成 status: string），assignment 到 AgentTranscriptItem[] 也能给字面类型
 * 正确的 context。
 */
function settleItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const next: AgentTranscriptItem[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.kind === "assistant" && it.streaming) {
      next[i] = { ...it, streaming: false };
    } else if (it.kind === "tool" && it.status === "running") {
      next[i] = { ...it, status: "failed" };
    } else {
      next[i] = it;
    }
  }
  return next;
}

// turn.done 只结算当前条目，事件本体不参与；参数保留以符合 reducer 统一签名。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function reduceTurnDone(state: AgentChatState, _event: AgentSseEvent & { name: "turn.done" }): AgentChatState {
  const items = clearSubagentItems(settleItems(state.items));
  return { ...state, items, turnActive: false, turnStatus: undefined };
}

function reduceTurnStatus(state: AgentChatState, event: AgentSseEvent & { name: "turn.status" }): AgentChatState {
  // 暂态单行：替换不累加。展示由 Transcript 专用状态行承担，绝不进 items 正文。
  return { ...state, turnStatus: event.data.text, turnActive: true };
}

function reduceConfirmRequest(state: AgentChatState, event: AgentSseEvent & { name: "confirm.request" }): AgentChatState {
  const { request_id, amount_coins, description } = event.data;
  if (state.pendingConfirms.some((c) => c.requestId === request_id)) return state;
  const confirm: AgentPendingConfirm = {
    requestId: request_id,
    amountCoins: amount_coins,
    description,
    seq: event.event_id,
  };
  return { ...state, pendingConfirms: [...state.pendingConfirms, confirm], turnStatus: undefined };
}

function reduceQuestionRequest(state: AgentChatState, event: AgentSseEvent & { name: "question.request" }): AgentChatState {
  const { request_id, questions } = event.data;
  if (state.pendingQuestions.some((q) => q.requestId === request_id)) return state;
  const question: AgentPendingQuestion = {
    requestId: request_id,
    questions,
    seq: event.event_id,
  };
  return { ...state, pendingQuestions: [...state.pendingQuestions, question], turnActive: true, turnStatus: undefined };
}

function reduceQuestionReplied(state: AgentChatState, event: AgentSseEvent & { name: "question.replied" }): AgentChatState {
  const { request_id, answer } = event.data;
  const pendingQuestions = state.pendingQuestions.filter((q) => q.requestId !== request_id);
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "info",
    text: answer ? `已选择：${answer}` : "已回答该问题。",
  };
  return { ...state, pendingQuestions, items: [...state.items, notice] };
}

function reduceQuestionRejected(state: AgentChatState, event: AgentSseEvent & { name: "question.rejected" }): AgentChatState {
  const { request_id, reason } = event.data;
  const pendingQuestions = state.pendingQuestions.filter((q) => q.requestId !== request_id);
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "info",
    text: reason || "该问题已取消。",
  };
  return { ...state, pendingQuestions, items: [...state.items, notice] };
}

function reduceConfirmResolved(state: AgentChatState, event: AgentSseEvent & { name: "confirm.resolved" }): AgentChatState {
  const { request_id, approved } = event.data;
  // 可能是另一台装置裁掉的，本机没看过 request_id —— filter 自然落空，不抛错。
  const pendingConfirms = state.pendingConfirms.filter((c) => c.requestId !== request_id);
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "info",
    text: approved ? "已同意该笔花费。" : "已拒绝该笔花费。",
  };
  return { ...state, pendingConfirms, items: [...state.items, notice] };
}

function reduceQuotaChanged(state: AgentChatState, event: AgentSseEvent & { name: "quota.changed" }): AgentChatState {
  const { balance_coins, currency, available, reason } = event.data;

  // 整份替换，不保留旧数字。
  //
  // 曾经想过：available=false 时留住上一个已知余额，免得使用者看到「20 币」
  // 忽然变「余额未知」。那是错的——available=false 就是上游明说「这个数我
  // 认不了」，把 20 留在 state 里等于存一个没人敢显示的过期值（UI 只在
  // available && balanceCoins != null 时才显示数字），而且余额真变了又碰上
  // 上游挂掉时会长期停在旧数。
  //
  // 另外 parseAgentEvent 已把缺字段规约成 null（agent-chat-types.ts:196
  // `balance ?? null`），所以 reducer 这层分不出「没提到」和「明确未知」，
  // 想做更细的保留也没有依据。诚实优于好看：未知就显示未知。
  return { ...state, quota: { balanceCoins: balance_coins, currency, available, reason } };
}

function reduceSessionError(state: AgentChatState, event: AgentSseEvent & { name: "session.error" }): AgentChatState {
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "error",
    // G-FE 合同：human_message（中文短句）优先，缺省回落原 message。
    text: event.data.human_message || event.data.message,
  };
  // 错误不终结会话。
  return { ...state, items: [...state.items, notice] };
}

/** 收尾：停掉 streaming、把还在转的工具判死、清掉子代理栏与待确认、推一条 notice。 */
function settleClosedTurn(state: AgentChatState, eventId: number, reason?: string): AgentChatState {
  const items = clearSubagentItems(settleItems(state.items));
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", eventId),
    seq: eventId,
    tone: "info",
    text: "会话已结束。",
  };
  return {
    ...state,
    items: [...items, notice],
    pendingConfirms: [],
    pendingQuestions: [],
    turnActive: false,
    closed: true,
    closedReason: reason,
  };
}

function reduceSessionClosed(state: AgentChatState, event: AgentSseEvent & { name: "session.closed" }): AgentChatState {
  // 幂等：已经关过一次的会话再收到 session.closed（本端 end() 合成的
  // event_id:0 收尾帧，紧跟在网关自己那一帧后面）——不能再跑一次
  // settleClosedTurn，否则会在已经结算过的 items 上重复推一条
  // 「会话已结束。」notice。只把 lastEventId 记账推进（走到这里时
  // base 已经算过 nextLastEventId），原样放行。
  if (state.closed) return state;
  return settleClosedTurn(state, event.event_id, event.data.reason);
}

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
    case "director.done":
      return reduceDirectorDone(base, event);
    case "image.failed":
      return reduceImageFailed(base, event);
    case "turn.done":
      return reduceTurnDone(base, event);
    case "turn.status":
      return reduceTurnStatus(base, event);
    case "confirm.request":
      return reduceConfirmRequest(base, event);
    case "confirm.resolved":
      return reduceConfirmResolved(base, event);
    case "question.request":
      return reduceQuestionRequest(base, event);
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
    default:
      // canvas.* 等由别处（useCanvasChat）消费的事件，reducer 只推 lastEventId。
      return base;
  }
}

// ─────────────────────────── 纯 helpers（非 SSE 事件的路径）

/** 乐观插入一则使用者消息，不等网关回声。 */
export function appendUserTurn(state: AgentChatState, text: string, attachments?: AgentAttachmentRef[]): AgentChatState {
  const item: AgentUserTurnItem = {
    kind: "user",
    id: userItemId(state),
    seq: 0,
    text,
  };
  if (attachments && attachments.length > 0) {
    item.attachments = attachments;
  }
  return { ...state, items: [...state.items, item], turnActive: true, turnStatus: undefined };
}

/** 用 GET /quota 的结果（已对齐 AgentQuotaState 形状）填入初始余额。 */
export function applyQuotaSnapshot(state: AgentChatState, quota: AgentQuotaState): AgentChatState {
  return { ...state, quota };
}

/**
 * 殭屍还魂自愈：turn.done 已宣告回合收尾，同一条连线却仍有内容帧到达
 * （watchdog 误判后 retry 的输出继续灌进来）。把回合拉回流式中——发送钮
 * 翻回「中止助理生成」，不再停留在「系统说死亡但内容还在冒」的断点假象。
 * 已终结会话的迟到帧由 agentChatReducer 的 closed 门卫丢弃，但本端合成的
 * action 不走那道门，这里自己再守一道；已在流式中则原样返回（bail out）。
 */
export function resumeZombieTurn(state: AgentChatState): AgentChatState {
  if (state.closed || state.turnActive) return state;
  return { ...state, turnActive: true };
}
