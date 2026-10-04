// Agent 聊天的纯逻辑核心：SSE 事件 → 可渲染 transcript 的 reducer。
//
// 规则：
//   - 纯函数，不碰 React、不碰 DOM、不碰 Math.random —— 同样输入
//     永远产出同样输出，node --test 可直接测。
//     唯一例外（2026-09-20 思維鏈計時）：reasoning.delta / 收尾結算會讀 Date.now()
//     寫入 reasoningStartedAt / reasoningMs 兩個時間欄位——網關不送時間戳，秒數
//     只能由本端時鐘得出。除這兩個欄位外，其餘轉換仍與輸入一一對應。
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
  type AgentAssistantTextItem,
  type AgentAttachmentRef,
  type AgentAudioItem,
  type AgentChatState,
  type AgentDirectorItem,
  type AgentImageItem,
  type AgentNoticeItem,
  type AgentPendingConfirm,
  type AgentPendingQuestion,
  type AgentPlanItem,
  type AgentQuotaState,
  type AgentSseEvent,
  type AgentSubagentItem,
  type AgentSubagentReportItem,
  type AgentSteerStatus,
  type AgentToolCallItem,
  type AgentTranscriptItem,
  type AgentUserTurnItem,
  type AgentVideoItem,
} from "./agent-chat-types";
import { detectBinaryText, parseAuthOptions } from "./agent-chat-types";
// 状态值域的唯一权威（0920 收口）：reducer 只在类型层引用该 union，分支逻辑不变。
import type { AgentTaskStatus } from "./agent-task-status";

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

/**
 * 思維鏈計時結算（2026-09-20 真功能：把預覽承諾的「已思考 · N 秒」做成真數據）。
 *
 * 只對「有起點（reasoningStartedAt）且還沒結算（reasoningMs === undefined）」的
 * 條目生效；回 undefined 代表本次一個欄位都不寫——呼叫方據此保持原本的物件形狀，
 * 沒有思維鏈的條目逐位元與舊行為一致（不長出 undefined 鍵）。
 *
 * 為什麼讀 Date.now()：時長無從由事件推得（網關不送時間戳），唯一誠實的來源是
 * 本端拿到 reasoning 的那一刻與思考結束的那一刻之差。reducer 因此在這兩處
 * 破例碰時鐘——除時間欄位外，其餘狀態轉換仍與輸入一一對應。
 */
function settleReasoningMs(item: AgentAssistantTextItem, now: number): number | undefined {
  if (item.reasoningStartedAt === undefined || item.reasoningMs !== undefined) return undefined;
  return Math.max(0, now - item.reasoningStartedAt);
}

function reduceMessageDelta(state: AgentChatState, event: AgentSseEvent & { name: "message.delta" }): AgentChatState {
  const text = event.data.text;
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    // 只对「正在 streaming 的最后一个助手条目」追加；否则开新条目。
    // 思維鏈結算時機 a（2026-09-20）：想完開始說話——正文首次落到「已經想過」
    // 的既有 streaming 條目。結算只發生一次（reasoningMs 已定就不再寫），
    // 純正文條目（沒有 reasoningStartedAt）不長任何時間欄位。
    const reasoningMs = settleReasoningMs(last, Date.now());
    items[items.length - 1] =
      reasoningMs === undefined
        ? { ...last, text: last.text + text }
        : { ...last, text: last.text + text, reasoningMs };
  } else {
    // 計畫退場（2026-09-18 turn.plan 契約）：真實正文開「新」條目的這一刻，
    // 代表計畫已經讓位——把還開著的計畫卡收合成一行，讓答案佔住版面。
    // 只在開新條目這條分支做：追加到既有 streaming 條目的分支是同一條交付物的
    // 續寫（工具卡 pending 契約的既有測試語義也掛在那裡），一行都不動。
    // 判定用嚴格 === false（reducer 自己建的計畫卡才會有這個值），缺席的
    // **不**收合——「手動收合優先於任何自動行為」的對偶：沒被自動展開過的
    // 不該被自動收掉。
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

function reduceReasoningDelta(state: AgentChatState, event: AgentSseEvent & { name: "reasoning.delta" }): AgentChatState {
  const text = event.data.text;
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    // 思維鏈通常先於最終文字到來；若已開 assistant 條目就直接累加。
    // 計時起點只在條目「首次」拿到 reasoning 時寫（已有值不覆蓋）：後續 frame
    // 累加文字的行為一字不動，形狀也一字不改（已有起點時不多長任何鍵）。
    items[items.length - 1] = {
      ...last,
      reasoning: (last.reasoning ?? "") + text,
      ...(last.reasoningStartedAt === undefined ? { reasoningStartedAt: Date.now() } : {}),
    };
  } else {
    // reasoning 先到、text 還沒來：開 streaming 條目，只填 reasoning。
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

function reduceToolInvoke(state: AgentChatState, event: AgentSseEvent & { name: "tool.invoke" }): AgentChatState {
  const item: AgentToolCallItem = {
    kind: "tool",
    id: eventItemId("tool", event.event_id),
    seq: event.event_id,
    tool: event.data.tool,
    argsSummary: event.data.args_summary,
    status: "running",
  };
  // 思維鏈結算時機 c（2026-09-29 e2e 像素實錘）：想完直接調工具、中間沒有正文時，
  // 原本要等整輪 settleItems 才結算——每段「已思考 · N 秒」都變成「從它開始到整輪
  // 結束」（實測 117/109/104/94… 秒遞減排列）。工具一開跑＝這段思考已結束。
  const items = state.items.slice();
  const last = items[items.length - 1];
  if (last && last.kind === "assistant") {
    const reasoningMs = settleReasoningMs(last, Date.now());
    if (reasoningMs !== undefined) items[items.length - 1] = { ...last, reasoningMs };
  }
  items.push(item);
  return { ...state, items, turnActive: true };
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
  const { tool, ok, cost_coins, task_id, artifact_pending, error } = event.data;
  // 缺陷 C（2026-10-04）：本機檔案讀取未授權 ＝ needs_authorization。這**不是**
  // 成功，也不是一般失敗——是等使用者在卡片上選授權範圍的 action 態。判定同時看
  // error.code 與 action_required，避免上游只帶其一時語義寫反成「完成」。
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
  // 缺陷 D（2026-10-04）：二進位讀取偵測——上游帶 binary 旗標或 preview 的
  // U+FFFD 比例超標，都不得把乱码当成功内容呈現。
  const binary = event.data.binary === true || detectBinaryText(event.data.preview);
  const errText = !ok && !needsAuth ? error?.human_message ?? error?.message ?? undefined : undefined;
  // 终态映射（2026-09-18 契约）：ok + artifact_pending = 任務已提交、成品未到 →
  // 中继态 pending，绝不报「已完成」；成品/失敗事件到达时由 settlePendingToolItems
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

/**
 * 成品／失敗事件到來 → 把對應的 pending 工具卡結算掉（2026-09-18 契約）。
 *
 * 匹配優先序：
 *   1. `taskId === 事件的 task_id` 的精確匹配 —— 同一次提交的任務號對號入座；
 *   2. 事件沒帶 task_id、或帶了卻找不到對應卡 → 回退結算**最舊的一張** pending 卡
 *      （FIFO 兜底：寧可早一張結算，也不讓成品已經到了、卡片還在轉）。
 *
 * 只碰 status === "pending" 的卡：running 由 tool.result / turn.done 負責，
 * 已定案的卡絕不被翻案。找不到任何 pending 卡時回傳原陣列（reference 不變，
 * 呼叫端行為與現狀逐位元一致）。就地不 mutate：變更時回新 slice。
 */
function settlePendingToolItems(
  items: AgentTranscriptItem[],
  taskId: string | undefined,
  status: Extract<AgentTaskStatus, "ok" | "failed">,
  errorText?: string,
): AgentTranscriptItem[] {
  let fallback = -1;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.kind !== "tool" || it.status !== "pending") continue;
    if (taskId !== undefined && it.taskId === taskId) {
      const next = items.slice();
      next[i] = { ...it, status, ...(errorText !== undefined ? { error: errorText } : {}) };
      return next;
    }
    if (fallback < 0) fallback = i;
  }
  if (fallback < 0) return items;
  const it = items[fallback];
  if (it.kind !== "tool") return items;
  const next = items.slice();
  next[fallback] = { ...it, status, ...(errorText !== undefined ? { error: errorText } : {}) };
  return next;
}

function reduceImageDone(state: AgentChatState, event: AgentSseEvent & { name: "image.done" }): AgentChatState {
  const { url, cost_coins, task_id, recipe } = event.data;
  // 成品到了 = 對應的 pending 工具卡可以結算成 ok。先結算再建出圖卡：
  // 兩件事互不干擾，出圖卡照舊建／照舊按 url 去重。
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

function reduceVideoDone(state: AgentChatState, event: AgentSseEvent & { name: "video.done" }): AgentChatState {
  const { url, cost_coins, task_id, media_kind } = event.data;
  // 同 image.done：成品到了先結算對應 pending 卡，出片卡照舊建／照舊去重。
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

function reduceAudioDone(state: AgentChatState, event: AgentSseEvent & { name: "audio.done" }): AgentChatState {
  const { url, cost_coins, task_id, media_kind } = event.data;
  // 同 image.done：成品到了先結算對應 pending 卡，出音頻卡照舊建／照舊去重。
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
    };
    return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
  }
  // 同 url 已存在：忽略内容，但仍是「助手在产出」的讯号，turnActive 照设。
  return { ...state, items, turnActive: true, turnStatus: undefined };
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

/**
 * 多行文本的最后一个非空行。subagent 卡片的预览行只取它——置顶跑马灯
 * 永远只滚一行（全文另存在 text 欄，F4：渲染层才截断 + 可展开，模型不丢）。
 */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return "";
}

/** 派遣子代理的工具名（工具卡與子代理欄的狀態必須同源，F1）。 */
const SUBAGENT_DISPATCH_TOOL = "subagent_dispatch";

/**
 * 把刚 started 的子代理绑到「最近一个还 running 且未绑定」的 subagent_dispatch
 * 工具卡上。这不是展示层的事：不绑就会出现同一批子代理两个状态源——工具卡
 * 按 tool.result 停在「运行中」，子代理栏按 subagent.done 显示「已完成」，
 * 同屏互相打脸（F1）。绑定后 done 一次结两处，两端不可能矛盾。
 * 就地改写传入的 items（呼叫方保证那是新 slice，不动输入 state）。
 */
function linkDispatchToolItem(items: AgentTranscriptItem[], subagentId: string): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (
      it.kind === "tool" &&
      it.tool === SUBAGENT_DISPATCH_TOOL &&
      it.status === "running" &&
      it.subagentId === undefined
    ) {
      items[i] = { ...it, subagentId };
      return true;
    }
  }
  return false;
}

/**
 * 子代理定案时同步结算它绑定的派遣工具卡（F1）。
 *   - 子代理 ok：只把还在 running 的卡升成 ok —— 派遣工具自己失败（tool.result
 *     ok:false）的事实比子代理成功更具体，不覆写。
 *   - 子代理 error：把已 ok 的卡也拉回 failed —— async 派遣时工具早就回了 ok，
 *     子代理随后失败；若卡片还留「已完成」就是同一批任务两处状态互相打脸。
 *   - 子代理 stopped（2026-09-20）：人工停止成功＝中性收尾，走 **ok 同款分支**
 *     —— 派遣动作本身成功执行过，工具卡不许被打脸成 failed，也不显 abort 文案。
 */
function settleLinkedDispatchTool(
  items: AgentTranscriptItem[],
  subagentId: string,
  outcome: "ok" | "error" | "stopped",
): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind !== "tool" || it.subagentId !== subagentId) continue;
    if (outcome !== "error") {
      if (it.status !== "running") return;
      items[i] = { ...it, status: "ok" };
      return;
    }
    if (it.status === "failed") return;
    items[i] = { ...it, status: "failed" };
    return;
  }
}

function reduceSubagentStarted(
  state: AgentChatState,
  event: AgentSseEvent & { name: "subagent.started" },
): AgentChatState {
  const { id, label } = event.data;
  const items = state.items.slice();
  const linked = linkDispatchToolItem(items, id);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "subagent" && it.subagentId === id) {
      // 同 id 重复 started（重连补发等）：标签没变就 bail out，变了才替换。
      if (it.label === label) return linked ? { ...state, items } : state;
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
  const { id, text, kind } = event.data;
  // 2026-09-11 跨片契约（S2）：kind === "reasoning" 是思考，不是交付物。
  // 两种增量都算「子代理在工作」→ 都 append 进 activity（跑马灯专读它）；
  // 只有正文进 text/lastLine —— text 会被产出卡当全文带走，混入思考就是谎报交付物。
  const isReasoning = kind === "reasoning";
  const items = state.items.slice();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind === "subagent" && it.subagentId === id) {
      // done 之后的迟到 delta 不再改写已定案的卡。
      if (it.status !== "running") return state;
      const activity = (it.activity ?? "") + text;
      if (isReasoning) {
        items[i] = { ...it, activity };
        return { ...state, items, turnActive: true };
      }
      // F4：模型层累积全文（text），lastLine 只是渲染预览（末行）；不再硬切到只剩末行。
      const full = (it.text ?? "") + text;
      items[i] = { ...it, text: full, lastLine: lastNonEmptyLine(full), activity };
      return { ...state, items, turnActive: true };
    }
  }
  // started 丢失（坏帧/断线）：补一条 running 条目，别让 delta 落空。
  // 首帧就是 reasoning 时不造 text（思考不是交付物）。
  const item: AgentSubagentItem = {
    kind: "subagent",
    id: eventItemId("subagent", event.event_id),
    seq: event.event_id,
    subagentId: id,
    label: "子任务",
    lastLine: isReasoning ? "" : lastNonEmptyLine(text),
    ...(isReasoning ? {} : { text }),
    activity: text,
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
      settleLinkedDispatchTool(items, id, status);
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
  settleLinkedDispatchTool(items, id, status);
  return { ...state, items: [...items, item] };
}

/**
 * 回合收尾转存：只对**已定态**（done 帧到过的 ok/error/stopped）的子代理条目
 * 做产出卡转存（F3）——带 summary / 串流全文的转成一张可展开的 subagent_result，
 * 绝不把 1082 字产出随卡片一起删掉。条目位置原地保留，产出卡就落在原子代理卡
 * 所在的转录位置。
 *
 * `status === "running"` 的条目**原样保留，不转卡不丢弃**（2026-09-21 暴君裁定）：
 * 异步子代理的生命周期刻意长于派出回合——完工才 wakeParent 发 `subagent.done`
 * （ok/error/stopped），子代理 lifecycle 的终态由那一帧独占裁决。回合收尾时把
 * running 判死/丢弃，等于在跑的 3D 导演跨回合消失（暴君实测「没看到子代理啊」）。
 * 与 09-18 pending 工具卡同构：turn 结束 ≠ 任务结束。wakeParent 后的回合收到
 * done 幀、条目转为定态，下一次收尾才走上面的转存。
 */
function retireSubagentItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const out: AgentTranscriptItem[] = [];
  for (const it of items) {
    if (it.kind !== "subagent" || it.status === "running") {
      out.push(it);
      continue;
    }
    const full = (it.text ?? "").trim();
    const summary = it.summary?.trim() ?? "";
    // 取較完整者：SSE 的 summary 可能被帧长截斷，delta 串流才是全文。
    const text = summary.length > full.length ? summary : full;
    const report: AgentSubagentReportItem = {
      kind: "subagent_result",
      id: `${it.id}-result`,
      seq: it.seq,
      subagentId: it.subagentId,
      label: it.label,
      status: it.status,
      text,
    };
    out.push(report);
  }
  return out;
}

/**
 * 收尾用的条目转换：把 streaming 的助手标记停掉、把还在 running 的工具判死。
 * 用 for 循环而非 map，是为了让每个分支都有确定性别（map 的回传类型会被
 * 宽化成 status: string），assignment 到 AgentTranscriptItem[] 也能给字面类型
 * 正确的 context。
 *
 * `pending`（2026-09-18 中继态）**不在这里判死**：turn 结束只代表这一轮助手文本
 * 说完了，不代表成品到了 —— 提交型生图/生片工具的任務此刻仍在上游跑，成品
 * （image/video/audio.done）或失敗（image.failed）事件可能落在下一轮里。判死它
 * 就是谎报失败，所以 pending 必须留着等那两类事件结算。
 */
function settleItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const next: AgentTranscriptItem[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.kind === "assistant" && it.streaming) {
      // 思維鏈結算時機 b（2026-09-20）：想完就直接結束、沒有正文可等——收尾這一刻
      // 就是思考的終點。已在時機 a 結算過的條目（reasoningMs 已定）不再覆寫，
      // 沒有計時起點的條目維持原本形狀。
      const reasoningMs = settleReasoningMs(it, Date.now());
      next[i] = reasoningMs === undefined ? { ...it, streaming: false } : { ...it, streaming: false, reasoningMs };
    } else if (it.kind === "tool" && it.status === "running") {
      next[i] = { ...it, status: "failed" };
    } else {
      next[i] = it;
    }
  }
  return next;
}

// turn.done 只结算当前条目，事件本体不参与；参数保留以符合 reducer 统一签名。
// 2026-09-21 暴君裁定：异步子代理跨回合在跑，回合收尾只转存**已定态**条目，
// running 卡原样保留（见 retireSubagentItems），wakeParent 后的回合收到
// subagent.done 幀才把终态裁决定下来——settleItems 判死 running 工具卡，但
// 子代理 lifecycle 的终态归 gateway 的 done 幀独占，与 pending 工具卡同构。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function reduceTurnDone(state: AgentChatState, _event: AgentSseEvent & { name: "turn.done" }): AgentChatState {
  const items = retireSubagentItems(settleItems(state.items));
  return { ...state, items, turnActive: false, turnStatus: undefined };
}

function reduceTurnStatus(state: AgentChatState, event: AgentSseEvent & { name: "turn.status" }): AgentChatState {
  // 暂态单行：替换不累加。展示由 Transcript 专用状态行承担，绝不进 items 正文。
  return { ...state, turnStatus: event.data.text, turnActive: true };
}

/**
 * 本輪計畫（turn.plan，2026-09-18 契約）：建立一張獨立的 `kind:"plan"` 條目。
 *
 * 為什麼不併進 assistant 條目：計畫是**導航**不是交付物。併進去會讓 100 秒後
 * 才到的重模型正文物理接在計畫後面（同一條 streaming:true 條目），使用者分不清
 * 「計畫 vs 答案」，agent-debug 的「首字延遲」語義也會被污染。所以這裡開新條目。
 *
 * 與 message.delta 同款清掉罐頭狀態行（turnStatus: undefined）並設 turnActive:true
 * ——計畫幀到的這一刻回合確實已經開始了（送訊後 ~1.4–2.0s），狀態行/停止鈕
 * 必須立刻反映，不能等到 100 秒後首行正文。
 *
 * `superseded === true`：就地換掉既有計畫條目的文字（同一 id，React 不重掛），
 * 不新增第二張卡——同一輪只有一份計畫。找不到既有卡時照樣建立（寧可多一張卡，
 * 也不讓網關送來的計畫文字消失）。
 */
function reduceTurnPlan(state: AgentChatState, event: AgentSseEvent & { name: "turn.plan" }): AgentChatState {
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
    // 初始展開：計畫剛到、正文還沒來，這張卡此刻是畫面上唯一的資訊。
    collapsed: false,
  };
  return { ...state, items: [...items, item], turnActive: true, turnStatus: undefined };
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

function reduceSessionError(state: AgentChatState, event: AgentSseEvent & { name: "session.error" }): AgentChatState {
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
    default:
      // canvas.* 等由别处（useCanvasChat）消费的事件，reducer 只推 lastEventId。
      return base;
  }
}

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
  // 不传 steer 时与改动前逐位等價（无 steer 的乐观插队语义不变）。
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
function reduceSteerStatus(state: AgentChatState, event: AgentSseEvent & { name: "steer.status" }): AgentChatState {
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
 * 为什么需要它：网關的 pendingSteers 是 volatile——重启／续期后队列整个消失，而且
 * 网關已经不记得那些 steer_id，永远不会补终态帧。此时前端还原出来的条目会永远停在
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
 * 为什么本端also改判而不是等网关的 aborted 帧：网關 handleAbortSession 里
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

/** 终态：已生效／已中止／未生效／未确认。到了这里就不再被后续帧改回进行中。
 *  injected（D2-5 修复，2026-09-23）：它也是终态——「已注入本回合」是已经发生过的事，
 *  迟到的 queued 帧（重连回放）不得把它打回「排队中」的假象。
 *  uncertain（D2b，2026-09-23）：网关明说「投递已发出但没等到确认，永不自动重发」——
 *  它同样是终态：迟到的 applied/queued 帧不得把「未确认」改写成已生效或排队中，
 *  那正是「模型收到两次而 View 只显示一次」的镜像假话。 */
function isSteerTerminal(status: AgentSteerStatus): boolean {
  return (
    status === "applied" ||
    status === "aborted" ||
    status === "failed" ||
    status === "injected" ||
    status === "uncertain"
  );
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
