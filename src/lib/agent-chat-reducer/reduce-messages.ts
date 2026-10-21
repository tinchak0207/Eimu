import type { AgentSseEvent } from "../agent-chat-types/types-events";
import { detectBinaryText, parseAuthOptions } from "../agent-chat-types/sse-parse";
import type { AgentAudioItem, AgentChatState, AgentDirectorItem, AgentImageItem, AgentNoticeItem, AgentPendingConfirm, AgentPendingQuestion, AgentPlanItem, AgentToolCallItem, AgentVideoItem } from "../agent-chat-types/types-core";
import type { AgentTaskStatus } from "../agent-task-status";
import { eventItemId, settleItems, settlePendingToolItems, settleReasoningMs } from "./reduce-core";
import { retireSubagentItems } from "./reduce-runs";
export function reduceMessageDelta(state: AgentChatState, event: AgentSseEvent & { name: "message.delta" }): AgentChatState {
  const text = event.data.text;
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    // 只对「正在 streaming 的最后一个助手条目」追加；否则开新条目。
    // 思维链结算时机 a（2026-09-20）：想完开始说话——正文首次落到「已经想过」
    // 的既有 streaming 条目。结算只发生一次（reasoningMs 已定就不再写），
    // 纯正文条目（没有 reasoningStartedAt）不长任何时间栏位。
    const reasoningMs = settleReasoningMs(last, Date.now());
    items[items.length - 1] =
      reasoningMs === undefined
        ? { ...last, text: last.text + text }
        : { ...last, text: last.text + text, reasoningMs };
  } else {
    // 计画退场（2026-09-18 turn.plan 契约）：真实正文开「新」条目的这一刻，
    // 代表计画已经让位——把还开著的计画卡收合成一行，让答案占住版面。
    // 只在开新条目这条分支做：追加到既有 streaming 条目的分支是同一条交付物的
    // 续写（工具卡 pending 契约的既有测试语义也挂在那里），一行都不动。
    // 判定用严格 === false（reducer 自己建的计画卡才会有这个值），缺席的
    // **不**收合——「手动收合优先于任何自动行为」的对偶：没被自动展开过的
    // 不该被自动收掉。
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === "plan" && it.collapsed === false) {
        items[i] = { ...it, collapsed: true };
      }
    }
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

export function reduceReasoningDelta(state: AgentChatState, event: AgentSseEvent & { name: "reasoning.delta" }): AgentChatState {
  const text = event.data.text;
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    // 思维链通常先于最终文字到来；若已开 assistant 条目就直接累加。
    // 计时起点只在条目「首次」拿到 reasoning 时写（已有值不覆盖）：后续 frame
    // 累加文字的行为一字不动，形状也一字不改（已有起点时不多长任何键）。
    items[items.length - 1] = {
      ...last,
      reasoning: (last.reasoning ?? "") + text,
      ...(last.reasoningStartedAt === undefined ? { reasoningStartedAt: Date.now() } : {}),
    };
  } else {
    // reasoning 先到、text 还没来：开 streaming 条目，只填 reasoning。
    items.push({
      kind: "assistant",
      id: eventItemId("assistant", event.event_id),
      seq: event.event_id,
      text: "",
      reasoning: text,
      reasoningStartedAt: Date.now(),
      streaming: true,
    });
  }
  return { ...state, items, turnActive: true };
}

export function reduceToolInvoke(state: AgentChatState, event: AgentSseEvent & { name: "tool.invoke" }): AgentChatState {
  const item: AgentToolCallItem = {
    kind: "tool",
    id: eventItemId("tool", event.event_id),
    seq: event.event_id,
    tool: event.data.tool,
    argsSummary: event.data.args_summary,
    status: "running",
  };
  // 思维链结算时机 c（2026-09-29 e2e 像素实锤）：想完直接调工具、中间没有正文时，
  // 原本要等整轮 settleItems 才结算——每段「已思考 · N 秒」都变成「从它开始到整轮
  // 结束」（实测 117/109/104/94… 秒递减排列）。工具一开跑＝这段思考已结束。
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant") {
    const reasoningMs = settleReasoningMs(last, Date.now());
    if (reasoningMs !== undefined) items[items.length - 1] = { ...last, reasoningMs };
  }
  items.push(item);
  return { ...state, items, turnActive: true };
}

export function reduceToolProgress(state: AgentChatState, event: AgentSseEvent & { name: "tool.progress" }): AgentChatState {
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

export function reduceToolResult(state: AgentChatState, event: AgentSseEvent & { name: "tool.result" }): AgentChatState {
  const { tool, ok, cost_coins, task_id, artifact_pending, error } = event.data;
  // 缺陷 C（2026-10-04）：本机档案读取未授权 ＝ needs_authorization。这**不是**
  // 成功，也不是一般失败——是等使用者在卡片上选授权范围的 action 态。判定同时看
  // error.code 与 action_required，避免上游只带其一时语义写反成「完成」。
  const needsAuth =
    error?.code === "needs_authorization" ||
    error?.action_required === "authorize_local_files" ||
    event.data.action_required === "authorize_local_files";
  const authOptions = parseAuthOptions(event.data.auth_options);
  const authorization = needsAuth
    ? {
        root: event.data.auth_root ?? error?.root,
        reason: event.data.auth_reason ?? error?.reason,
        actionRequired: error?.action_required ?? event.data.action_required,
        options: authOptions,
      }
    : undefined;
  // 缺陷 D（2026-10-04）：二进位读取侦测——上游带 binary 旗标或 preview 的
  // U+FFFD 比例超标，都不得把乱码当成功内容呈现。
  const binary = event.data.binary === true || detectBinaryText(event.data.preview);
  const errText = !ok && !needsAuth ? error?.human_message ?? error?.message ?? undefined : undefined;
  // 失败时一并带上 gateway 分类的错误码（如 flowmusic_*）：展示层据此渲染分类状态位，
  // 而不是把上游原文（human_message 里可能夹带 HTTP 码/上游码/原文）直甩到界面。
  const errCode = !ok && !needsAuth ? error?.code : undefined;
  // 终态映射（2026-09-18 契约）：ok + artifact_pending = 任务已提交、成品未到 →
  // 中继态 pending，绝不报「已完成」；成品/失败事件到达时由 settlePendingToolItems
  // 结算成 ok/failed。缺 artifact_pending 的旧格式逐位元照旧走 ok。
  // needs_auth 优先于 ok：授权请求即使被上游标成 ok 也不得显示「完成」。
  const status: AgentToolCallItem["status"] = needsAuth
    ? "needs_auth"
    : !ok
      ? "failed"
      : artifact_pending
        ? "pending"
        : "ok";
  // 卡片上只有 task_id 有值时才写：旧格式不凭空长出 taskId 栏位。
  const taskPatch = task_id !== undefined ? { taskId: task_id } : {};
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
      items[target] = {
        ...existing,
        status,
        costCoins: cost_coins,
        error: errText,
        errorCode: errCode,
        ...(authorization ? { authorization } : {}),
        ...(binary ? { binary: true } : {}),
        ...(event.data.bytes_read !== undefined ? { readBytes: event.data.bytes_read } : {}),
        ...(event.data.bytes_total !== undefined ? { totalBytes: event.data.bytes_total } : {}),
        ...(event.data.truncated !== undefined ? { truncated: event.data.truncated } : {}),
        ...taskPatch,
      };
    }
  } else {
    items.push({
      kind: "tool",
      id: eventItemId("tool", event.event_id),
      seq: event.event_id,
      tool,
      argsSummary: undefined,
      status,
      costCoins: cost_coins,
      error: errText,
      errorCode: errCode,
      ...(authorization ? { authorization } : {}),
      ...(binary ? { binary: true } : {}),
      ...(event.data.bytes_read !== undefined ? { readBytes: event.data.bytes_read } : {}),
      ...(event.data.bytes_total !== undefined ? { totalBytes: event.data.bytes_total } : {}),
      ...(event.data.truncated !== undefined ? { truncated: event.data.truncated } : {}),
      ...taskPatch,
    });
  }
  return { ...state, items, turnActive: true };
}
export function reduceImageDone(state: AgentChatState, event: AgentSseEvent & { name: "image.done" }): AgentChatState {
  const { url, cost_coins, task_id, recipe } = event.data;
  // 成品到了 = 对应的 pending 工具卡可以结算成 ok。先结算再建出图卡：
  // 两件事互不干扰，出图卡照旧建／照旧按 url 去重。
  const items = settlePendingToolItems(state.items, task_id, "ok");
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
    return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
  }
  // 同 url 已存在：忽略内容，但仍是「助手在产出」的讯号，turnActive 照设。
  return { ...state, items, turnActive: true, turnStatus: undefined };
}

export function reduceVideoDone(state: AgentChatState, event: AgentSseEvent & { name: "video.done" }): AgentChatState {
  const { url, cost_coins, task_id, media_kind } = event.data;
  // 同 image.done：成品到了先结算对应 pending 卡，出片卡照旧建／照旧去重。
  const items = settlePendingToolItems(state.items, task_id, "ok");
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
    return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
  }
  // 同 url 已存在：忽略内容，但仍是「助手在产出」的讯号，turnActive 照设。
  return { ...state, items, turnActive: true, turnStatus: undefined };
}

export function reduceAudioDone(state: AgentChatState, event: AgentSseEvent & { name: "audio.done" }): AgentChatState {
  const { url, cost_coins, task_id, media_kind, title, cover, lyric_status } = event.data;
  // 同 image.done：成品到了先结算对应 pending 卡，出音频卡照旧建／照旧去重。
  const items = settlePendingToolItems(state.items, task_id, "ok");
  const exists = state.items.some((it) => it.kind === "audio" && it.url === url);
  if (!exists) {
    // seq 是展示序号：会话内第几条音频，不是网关全局 event_id（同 image.done 的理由）。
    const audioSeq = state.items.filter((it) => it.kind === "audio").length + 1;
    const item: AgentAudioItem = {
      kind: "audio",
      id: eventItemId("audio", event.event_id),
      seq: audioSeq,
      url,
      costCoins: cost_coins,
      taskId: task_id,
      mediaKind: media_kind,
      // 三个可选元数据：缺字段一律 undefined（网关可能还没补上），卡片据此降级。
      title,
      cover,
      lyricStatus: lyric_status,
    };
    return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
  }
  // 同 url 已存在：忽略内容，但仍是「助手在产出」的讯号，turnActive 照设。
  return { ...state, items, turnActive: true, turnStatus: undefined };
}

/**
 * 导演台：会话内唯一活卡。同槽（同一张 director 卡）按 revision 替换，
 * 不堆积历史卡——director.done 是工程状态广播不是成果事件，堆积会把
 * 转录刷成版本流水帐。迟到帧（revision <= 现有）原样 bail out。
 * reset（action="reset"）发 revision 0：小于任何现有 revision，活卡照替换
 * ——工程已被清空，旧卡留著就是谎报。
 */
export function reduceDirectorDone(state: AgentChatState, event: AgentSseEvent & { name: "director.done" }): AgentChatState {
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

export function reduceImageFailed(state: AgentChatState, event: AgentSseEvent & { name: "image.failed" }): AgentChatState {  // 失败也进对话流（与 image.done 对称）：用户在聊天里直接看到「没排上队，
  // 费用已退回」，不依赖画布节点才知道发生了什么。
  const { task_id, reason, refunded, human_message } = event.data;
  // 失败事件 = 提交出去的那张卡可以判死了（原本只会留一条 notice，卡片会
  // 一直停在「生成中…」）。精确配不到 task_id 时由 settler 按序兜底配对。
  // human_message 有值就顺手填进卡片的 error（G-FE 合同：中文短句优先）。
  const items = settlePendingToolItems(state.items, task_id, "failed", human_message);
  const text = refunded ? `这张图没排上队，费用已退回${reason ? `（${reason}）` : ""}。` : `这张图生成失败${reason ? `（${reason}）` : ""}。`;
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "error",
    text,
  };
  return { ...state, items: [...items, notice], turnActive: true, turnStatus: undefined };
}
// turn.done 只结算当前条目，事件本体不参与；参数保留以符合 reducer 统一签名。
// 2026-09-21 暴君裁定：异步子代理跨回合在跑，回合收尾只转存**已定态**条目，
// running 卡原样保留（见 retireSubagentItems），wakeParent 后的回合收到
// subagent.done 帧才把终态裁决定下来——settleItems 判死 running 工具卡，但
// 子代理 lifecycle 的终态归 gateway 的 done 帧独占，与 pending 工具卡同构。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function reduceTurnDone(state: AgentChatState, _event: AgentSseEvent & { name: "turn.done" }): AgentChatState {
  const items = retireSubagentItems(settleItems(state.items));
  return { ...state, items, turnActive: false, turnStatus: undefined };
}

export function reduceTurnStatus(state: AgentChatState, event: AgentSseEvent & { name: "turn.status" }): AgentChatState {
  // 暂态单行：替换不累加。展示由 Transcript 专用状态行承担，绝不进 items 正文。
  return { ...state, turnStatus: event.data.text, turnActive: true };
}

/**
 * 本轮计画（turn.plan，2026-09-18 契约）：建立一张独立的 `kind:"plan"` 条目。
 *
 * 为什么不并进 assistant 条目：计画是**导航**不是交付物。并进去会让 100 秒后
 * 才到的重模型正文物理接在计画后面（同一条 streaming:true 条目），使用者分不清
 * 「计画 vs 答案」，agent-debug 的「首字延迟」语义也会被污染。所以这里开新条目。
 *
 * 与 message.delta 同款清掉罐头状态行（turnStatus: undefined）并设 turnActive:true
 * ——计画帧到的这一刻回合确实已经开始了（送讯后 ~1.4–2.0s），状态行/停止钮
 * 必须立刻反映，不能等到 100 秒后首行正文。
 *
 * `superseded === true`：就地换掉既有计画条目的文字（同一 id，React 不重挂），
 * 不新增第二张卡——同一轮只有一份计画。找不到既有卡时照样建立（宁可多一张卡，
 * 也不让网关送来的计画文字消失）。
 */
export function reduceTurnPlan(state: AgentChatState, event: AgentSseEvent & { name: "turn.plan" }): AgentChatState {
  const { plan, experts, provisional, superseded } = event.data;
  const items = state.items.slice();
  if (superseded === true) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "plan") {
        items[i] = {
          ...it,
          text: plan,
          ...(experts !== undefined ? { experts } : {}),
          ...(provisional !== undefined ? { provisional } : {}),
        };
        return { ...state, items, turnActive: true, turnStatus: undefined };
      }
    }
  }
  const item: AgentPlanItem = {
    kind: "plan",
    id: eventItemId("plan", event.event_id),
    seq: event.event_id,
    text: plan,
    ...(experts !== undefined ? { experts } : {}),
    ...(provisional !== undefined ? { provisional } : {}),
    // 初始展开：计画刚到、正文还没来，这张卡此刻是画面上唯一的资讯。
    collapsed: false,
  };
  return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
}

export function reduceConfirmRequest(state: AgentChatState, event: AgentSseEvent & { name: "confirm.request" }): AgentChatState {
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

export function reduceQuestionRequest(state: AgentChatState, event: AgentSseEvent & { name: "question.request" }): AgentChatState {
  const { request_id, questions } = event.data;
  if (state.pendingQuestions.some((q) => q.requestId === request_id)) return state;
  const question: AgentPendingQuestion = {
    requestId: request_id,
    questions,
    seq: event.event_id,
  };
  return { ...state, pendingQuestions: [...state.pendingQuestions, question], turnActive: true, turnStatus: undefined };
}

export function reduceQuestionReplied(state: AgentChatState, event: AgentSseEvent & { name: "question.replied" }): AgentChatState {
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

export function reduceQuestionRejected(state: AgentChatState, event: AgentSseEvent & { name: "question.rejected" }): AgentChatState {
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

export function reduceConfirmResolved(state: AgentChatState, event: AgentSseEvent & { name: "confirm.resolved" }): AgentChatState {
  const { request_id, approved, auto } = event.data;
  // 可能是另一台装置裁掉的，本机没看过 request_id —— filter 自然落空，不抛错。
  const pendingConfirms = state.pendingConfirms.filter((c) => c.requestId !== request_id);
  // 自动放行（互动模式=auto）不是使用者做过的动作，不留 notice：30 笔批量出图
  // 曾因此堆出 30 条「已同意该笔花费。」。卡片收起即可。
  if (auto === true) return { ...state, pendingConfirms };

  // 人工裁决可能连点多次：同类通知合并到末尾那一条（保留原 id/seq，避免 React
  // 重挂载与顺序跳动），文字带笔数；不同类型（同意/拒绝）不互相合并。
  const dedupeKey = approved ? "confirm-approved" : "confirm-denied";
  const last = state.items[state.items.length - 1];
  if (last && last.kind === "notice" && last.dedupeKey === dedupeKey) {
    const count = (last.count ?? 1) + 1;
    const merged: AgentNoticeItem = {
      ...last,
      count,
      text: approved ? `已同意 ${count} 笔花费。` : `已拒绝 ${count} 笔花费。`,
    };
    return { ...state, pendingConfirms, items: [...state.items.slice(0, -1), merged] };
  }
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "info",
    text: approved ? "已同意该笔花费。" : "已拒绝该笔花费。",
    dedupeKey,
    count: 1,
  };
  return { ...state, pendingConfirms, items: [...state.items, notice] };
}

export function reduceQuotaChanged(state: AgentChatState, event: AgentSseEvent & { name: "quota.changed" }): AgentChatState {
  const { balance_coins, currency, available, spendable, reason } = event.data;

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
  return {
    ...state,
    quota: { balanceCoins: balance_coins, currency, available, ...(spendable === undefined ? {} : { spendable }), reason },
  };
}

export function reduceSessionError(state: AgentChatState, event: AgentSseEvent & { name: "session.error" }): AgentChatState {
  const notice: AgentNoticeItem = {
    kind: "notice",
    id: eventItemId("notice", event.event_id),
    seq: event.event_id,
    tone: "error",
    // G-FE 合同：human_message（中文短句）优先，缺省回落原 message。
    text: event.data.human_message || event.data.message,
  };
  // 错误不终结会话；但中止类错误（Tool execution aborted）到的这一刻，
  // **已定态**子代理的产出必须落成产出卡（F3）——本端可能等不到 turn.done。
  // 0921 契约：仍在跑（running）的条目由 retireSubagentItems 原样保留，终态
  // 等 gateway 的 subagent.done 裁决；「画面比中止前更空」自此不再发生。
  return { ...state, items: [...retireSubagentItems(state.items), notice] };
}

/** 收尾：停掉 streaming、把还在 running 的工具判死、已定态子代理条目转存产出卡（running 跨回合保留，0921 契约）、清待确认、推一条 notice。 */
function settleClosedTurn(state: AgentChatState, eventId: number, reason?: string): AgentChatState {
  const items = retireSubagentItems(settleItems(state.items));
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

export function reduceSessionClosed(state: AgentChatState, event: AgentSseEvent & { name: "session.closed" }): AgentChatState {
  // 幂等：已经关过一次的会话再收到 session.closed（本端 end() 合成的
  // event_id:0 收尾帧，紧跟在网关自己那一帧后面）——不能再跑一次
  // settleClosedTurn，否则会在已经结算过的 items 上重复推一条
  // 「会话已结束。」notice。只把 lastEventId 记账推进（走到这里时
  // base 已经算过 nextLastEventId），原样放行。
  if (state.closed) return state;
  return settleClosedTurn(state, event.event_id, event.data.reason);
}
