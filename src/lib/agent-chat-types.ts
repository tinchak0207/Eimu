// Agent 聊天的线路契约：网关 SSE 事件 → 前端可渲染的模型。
//
// 这个文件是「唯一的事实来源」，对齐 /opt/agent-harness/gateway/index.ts 的
// serializeSse()：每一帧都是 `id: <n>` + `event: <name>` + `data: <json>`，
// 且 data 一律被注入 `event_id`（= 那个 id）。前端只认这里宣告的栏位；
// 网关多送的栏位一律忽略，少送的栏位一律当 undefined 处理，不抛错 ——
// 一个没见过的栏位不该让整个对话白屏。
//
// 站上目前没有任何 SSE 消费者（全站都是轮询），所以没有既有模式可抄；
// 反过来说也没有既有包袱，这里定的形状就是后续所有 agent UI 的地基。

import type { CanvasAgentOpsEvent } from "@/lib/canvas/types";

// ─────────────────────────── 事件名

export interface AgentQuestionRequest {
  /** opencode 的 que_* id，回覆必須用這個，不能用 tool callID。 */
  request_id: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface AgentQuestionReplied {
  request_id: string;
  answer: string;
}

export interface AgentQuestionRejected {
  request_id: string;
  reason: string;
}

export const AGENT_EVENT_NAMES = [
  "message.delta",
  "reasoning.delta",
  "tool.invoke",
  "tool.result",
  "image.done",
  "turn.done",
  "confirm.request",
  "confirm.resolved",
  "quota.changed",
  "session.error",
  "session.closed",
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.generating",
  "canvas.node.deleted",
  "canvas.derive.started",
  "canvas.budget.updated",
  "canvas.ops",
  "question.request",
  "question.replied",
  "question.rejected",
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(AGENT_EVENT_NAMES);

export function isAgentEventName(name: string): name is AgentEventName {
  return EVENT_NAME_SET.has(name);
}

// ─────────────────────────── 各事件 payload
// 栏位形状逐一对齐网关 emitToSession 的呼叫点（行号为 2026-08-06 的 index.ts）。

/** gateway:477,507 —— 助手文字增量。text 是「这一段新增的字」，不是全文。 */
export interface AgentMessageDelta {
  text: string;
}

/** gateway —— 助手思维链增量（reasoning part）。与 message.delta 同 shape，单独成事件让 UI 区分展示。 */
export interface AgentReasoningDelta {
  text: string;
}

/** gateway:409 —— 工具开始执行。一次 call 只发一次（网关已按 callId 去重）。 */
export interface AgentToolInvoke {
  tool: string;
  /** 参数摘要，网关已截到 500 字并补省略号。可能缺。 */
  args_summary?: string;
}

/** gateway:416,425,1040 —— 工具结束。ok=false 代表失败，cost_coins 只有计费工具才有。 */
export interface AgentToolResult {
  tool: string;
  ok: boolean;
  cost_coins?: number;
}

/** gateway:377 —— 出图完成。网关已按 url 在 session 内去重。 */
export interface AgentImageDone {
  url: string;
  cost_coins?: number;
  task_id?: string;
}

/** gateway:552 —— 这一轮对话结束（网关发的是空对象）。 */
export type AgentTurnDone = Record<string, never>;

/** gateway:945 —— 要求使用者确认一笔花费。90 秒不回会过期（D-20 要改成 15 分钟）。 */
export interface AgentConfirmRequest {
  request_id: string;
  amount_coins: number;
  description?: string;
}

/** gateway:734 —— 确认已被裁决（可能来自另一个装置，所以 UI 必须跟著收起卡片）。 */
export interface AgentConfirmResolved {
  request_id: string;
  approved: boolean;
}

/**
 * gateway:836-840 —— 余额变化。
 * 注意网关刻意不在拿不到余额时发这个事件（见 emitQuotaChanged 的注解），
 * 但 GET /quota 会回 available:false，所以这个类型两种情况都要能表达。
 */
export interface AgentQuotaChanged {
  balance_coins: number | null;
  currency: string;
  available: boolean;
  reason?: string;
}

/** gateway:859 —— 会话层错误。不必然终结会话。 */
export interface AgentSessionError {
  code: string;
  message: string;
}

/** gateway:776 —— 会话已关闭。终结事件，之后不会再有任何事件。 */
export interface AgentSessionClosed {
  reason?: string;
}

// ─────────────────────────── 畫布指揮臺事件 payload
// 由 VPS gateway 攔截 image_* 工具自動產生（autoCreateCanvasUnit 系列），
// 前端畫布 reducer 消費。與 src/lib/canvas/types.ts 的契約一致（此處只做寬鬆解析）。

/** gateway autoCreateCanvasUnit —— 一次生成請求的計畫卡。 */
export interface AgentCanvasPlan {
  unit_id: string;
  tool: string;
  label: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
  kind: string;
  source_image: string | null;
  cost_hint: number | null;
}

export interface AgentCanvasNodeCreated {
  unit_id: string;
  node: {
    id: string;
    type: string;
    title: string;
    metadata?: Record<string, unknown>;
  };
  target_kind?: "result";
}

export interface AgentCanvasNodeUpdated {
  unit_id: string;
  node_id: string;
  patch: Record<string, unknown>;
  url?: string;
  cost_coins?: number;
}

export interface AgentCanvasNodeConnected {
  unit_id: string;
  connection: { id: string; fromNodeId: string; toNodeId: string };
  target_kind?: "result";
}

export interface AgentCanvasNodeGenerating {
  unit_id: string;
  node_id: string;
  status: string;
  progress?: number;
}

export interface AgentCanvasNodeDeleted {
  unit_id: string;
  node_id?: string;
}

export interface AgentCanvasDeriveStarted {
  unit_id: string;
  source_node_id: string;
  instruction: string;
  interpretation?: string;
}

export interface AgentCanvasBudgetUpdated {
  unit_id?: string;
  used_coins: number;
  remaining_coins: number;
}

// ─────────────────────────── 判别联合

interface WithEventId {
  /** 网关注入的单调递增序号，断线重连靠它续传（Last-Event-ID / ?last_event_id=）。 */
  event_id: number;
}

export type AgentSseEvent = WithEventId &
  (
    | { name: "message.delta"; data: AgentMessageDelta }
    | { name: "reasoning.delta"; data: AgentReasoningDelta }
    | { name: "tool.invoke"; data: AgentToolInvoke }
    | { name: "tool.result"; data: AgentToolResult }
    | { name: "image.done"; data: AgentImageDone }
    | { name: "turn.done"; data: AgentTurnDone }
    | { name: "confirm.request"; data: AgentConfirmRequest }
    | { name: "confirm.resolved"; data: AgentConfirmResolved }
    | { name: "quota.changed"; data: AgentQuotaChanged }
    | { name: "session.error"; data: AgentSessionError }
    | { name: "session.closed"; data: AgentSessionClosed }
    | { name: "canvas.plan"; data: AgentCanvasPlan }
    | { name: "canvas.node.created"; data: AgentCanvasNodeCreated }
    | { name: "canvas.node.updated"; data: AgentCanvasNodeUpdated }
    | { name: "canvas.node.connected"; data: AgentCanvasNodeConnected }
    | { name: "canvas.node.generating"; data: AgentCanvasNodeGenerating }
    | { name: "canvas.node.deleted"; data: AgentCanvasNodeDeleted }
    | { name: "canvas.derive.started"; data: AgentCanvasDeriveStarted }
    | { name: "canvas.budget.updated"; data: AgentCanvasBudgetUpdated }
    | { name: "canvas.ops"; data: CanvasAgentOpsEvent }
    | { name: "question.request"; data: AgentQuestionRequest }
    | { name: "question.replied"; data: AgentQuestionReplied }
    | { name: "question.rejected"; data: AgentQuestionRejected }
  );

// ─────────────────────────── 解析（纯函数，可在 node --test 下测）

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 把一帧 SSE 解析成判别联合；任何不合契约的输入回 null（呼叫方直接丢弃该帧）。
 *
 * 为什么「丢弃」而不是「抛错」：SSE 是长连线，一帧坏掉不该让整条流断掉，
 * 更不该让已经渲染好的对话消失。坏帧在此静默落地，序号照样被上层记录，
 * 这样重连时不会反复重放同一帧坏数据。
 */
export function parseAgentSseEvent(name: string, rawData: string): AgentSseEvent | null {
  if (!isAgentEventName(name)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const d = parsed as Record<string, unknown>;

  // event_id 缺失是允许的（例如手动 /internal 注入的边角情况），退化成 0 表示
  // 「不参与续传计算」，而不是把整帧丢掉。
  const eventId = num(d.event_id) ?? 0;

  switch (name) {
    case "message.delta": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "reasoning.delta": {
      const text = str(d.text);
      if (text === undefined) return null;
      return { name, event_id: eventId, data: { text } };
    }
    case "tool.invoke": {
      const tool = str(d.tool);
      if (!tool) return null;
      return { name, event_id: eventId, data: { tool, args_summary: str(d.args_summary) } };
    }
    case "tool.result": {
      const tool = str(d.tool);
      if (!tool) return null;
      return { name, event_id: eventId, data: { tool, ok: d.ok === true, cost_coins: num(d.cost_coins) } };
    }
    case "image.done": {
      const url = str(d.url);
      if (!url) return null;
      return { name, event_id: eventId, data: { url, cost_coins: num(d.cost_coins), task_id: str(d.task_id) } };
    }
    case "turn.done":
      return { name, event_id: eventId, data: {} as AgentTurnDone };
    case "confirm.request": {
      const requestId = str(d.request_id);
      const amount = num(d.amount_coins);
      if (!requestId || amount === undefined) return null;
      return { name, event_id: eventId, data: { request_id: requestId, amount_coins: amount, description: str(d.description) } };
    }
    case "confirm.resolved": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, approved: d.approved === true } };
    }
    case "quota.changed": {
      const balance = num(d.balance_coins);
      return {
        name,
        event_id: eventId,
        data: {
          balance_coins: balance ?? null,
          currency: str(d.currency) ?? "coins",
          available: d.available === true,
          reason: str(d.reason),
        },
      };
    }
    case "session.error": {
      return {
        name,
        event_id: eventId,
        data: { code: str(d.code) ?? "backend_error", message: str(d.message) ?? "会话发生未知错误。" },
      };
    }
    case "session.closed":
      return { name, event_id: eventId, data: { reason: str(d.reason) } };
    case "canvas.plan":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          tool: str(d.tool) ?? "",
          label: str(d.label) ?? "",
          prompt: str(d.prompt) ?? "",
          model: str(d.model) ?? "",
          size: str(d.size) ?? "",
          count: num(d.count) ?? 1,
          kind: str(d.kind) ?? "image",
          source_image: str(d.source_image) ?? null,
          cost_hint: num(d.cost_hint) ?? null,
        },
      };
    case "canvas.node.created":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node: (d.node as AgentCanvasNodeCreated["node"]) ?? { id: "", type: "", title: "" },
          ...(str(d.target_kind) ? { target_kind: str(d.target_kind) as "result" } : {}),
        },
      };
    case "canvas.node.updated":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node_id: str(d.node_id) ?? "",
          patch: (d.patch as Record<string, unknown>) ?? {},
          ...(str(d.url) ? { url: str(d.url) } : {}),
          ...(num(d.cost_coins) !== undefined ? { cost_coins: num(d.cost_coins) } : {}),
        },
      };
    case "canvas.node.connected":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          connection: (d.connection as AgentCanvasNodeConnected["connection"]) ?? { id: "", fromNodeId: "", toNodeId: "" },
          ...(str(d.target_kind) ? { target_kind: str(d.target_kind) as "result" } : {}),
        },
      };
    case "canvas.node.generating":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          node_id: str(d.node_id) ?? "",
          status: str(d.status) ?? "running",
          ...(num(d.progress) !== undefined ? { progress: num(d.progress) } : {}),
        },
      };
    case "canvas.node.deleted":
      return { name, event_id: eventId, data: { unit_id: str(d.unit_id) ?? "", ...(str(d.node_id) ? { node_id: str(d.node_id) } : {}) } };
    case "canvas.derive.started":
      return {
        name,
        event_id: eventId,
        data: {
          unit_id: str(d.unit_id) ?? "",
          source_node_id: str(d.source_node_id) ?? "",
          instruction: str(d.instruction) ?? "",
          ...(str(d.interpretation) ? { interpretation: str(d.interpretation) } : {}),
        },
      };
    case "canvas.budget.updated":
      return {
        name,
        event_id: eventId,
        data: {
          ...(str(d.unit_id) ? { unit_id: str(d.unit_id) } : {}),
          used_coins: num(d.used_coins) ?? 0,
          remaining_coins: num(d.remaining_coins) ?? 0,
        },
      };
    case "canvas.ops": {
      const requestId = str(d.request_id);
      const ops = d.ops;
      if (!requestId || !Array.isArray(ops)) return null;
      return {
        name,
        event_id: eventId,
        data: {
          request_id: requestId,
          ops: ops as CanvasAgentOpsEvent["ops"],
          ...(str(d.label) ? { label: str(d.label) } : {}),
        },
      };
    }
    case "question.request": {
      const requestId = str(d.request_id);
      const questions = parseQuestionItems(d.questions);
      if (!requestId || !questions) return null;
      return { name, event_id: eventId, data: { request_id: requestId, questions } };
    }
    case "question.replied": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, answer: str(d.answer) ?? "" } };
    }
    case "question.rejected": {
      const requestId = str(d.request_id);
      if (!requestId) return null;
      return { name, event_id: eventId, data: { request_id: requestId, reason: str(d.reason) ?? "" } };
    }
  }
}

function parseQuestionItems(raw: unknown): AgentQuestionRequest["questions"] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AgentQuestionRequest["questions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    const question = str(rec.question);
    if (!question) return null;
    const optionsRaw = rec.options;
    const options: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(optionsRaw)) {
      for (const opt of optionsRaw) {
        if (!opt || typeof opt !== "object") continue;
        const label = str((opt as Record<string, unknown>).label);
        if (!label) continue;
        const description = str((opt as Record<string, unknown>).description);
        options.push(description ? { label, description } : { label });
      }
    }
    const header = str(rec.header);
    out.push(header ? { question, header, options } : { question, options });
  }
  return out.length > 0 ? out : null;
}

// ─────────────────────────── 前端渲染模型（transcript）
//
// 对话不是「一串事件」，是「一串可渲染的条目」。事件流会把同一个条目改很多次
// （message.delta 追加文字、tool.result 回填先前的 tool.invoke），所以条目必须
// 有稳定 id，让 React 不会每来一帧就整段重挂。

export type AgentTranscriptItem =
  | AgentUserTurnItem
  | AgentAssistantTextItem
  | AgentToolCallItem
  | AgentImageItem
  | AgentNoticeItem;

interface TranscriptItemBase {
  /** React key。同一条目的多次更新必须沿用同一个 id。 */
  id: string;
  /** 产生这条目的首个事件序号，用于稳定排序。使用者自己发的消息用 0。 */
  seq: number;
}

/** 使用者发出的一轮。乐观插入，不等网关回声。 */
export interface AgentUserTurnItem extends TranscriptItemBase {
  kind: "user";
  text: string;
  /** 附件（图／影片）在 step 8 才接，先留位子，避免之后改类型牵动所有渲染。 */
  attachments?: AgentAttachmentRef[];
}

export interface AgentAttachmentRef {
  kind: "image" | "video" | "document";
  /** 图／影片的展示 URL；document 类型是上传 blob 的短暂 URL（如有）。 */
  url?: string;
  /** 附件在网关上的储存路径，[附件] 区块的字面值。 */
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
}

/** 助手文字。streaming 期间 text 会不断变长。 */
export interface AgentAssistantTextItem extends TranscriptItemBase {
  kind: "assistant";
  text: string;
  /** 思维链（reasoning.delta 累积）。streaming 期间可能还在长。UI 可折叠显示。 */
  reasoning?: string;
  /** true = 还在收 delta。turn.done 后转 false。 */
  streaming: boolean;
}

/** 一次工具调用，从 invoke 到 result 是同一个条目。 */
export interface AgentToolCallItem extends TranscriptItemBase {
  kind: "tool";
  tool: string;
  argsSummary?: string;
  status: "running" | "ok" | "failed";
  costCoins?: number;
}

/** 出图结果。step 6 会在这张卡上挂「存图库／改图／放大／下载」。 */
export interface AgentImageItem extends TranscriptItemBase {
  kind: "image";
  url: string;
  costCoins?: number;
  taskId?: string;
}

/** 系统告知：错误、会话关闭、确认被裁决等需要留痕的事。 */
export interface AgentNoticeItem extends TranscriptItemBase {
  kind: "notice";
  tone: "info" | "error";
  text: string;
}

/** 待裁决的花费确认。不进 transcript，单独浮在输入区上方（随时只有 0..n 张）。 */
export interface AgentPendingConfirm {
  requestId: string;
  amountCoins: number;
  description?: string;
  seq: number;
}

/** 待回答的 opencode question。不进 transcript，浮在输入区上方。 */
export interface AgentPendingQuestion {
  requestId: string;
  questions: AgentQuestionRequest["questions"];
  seq: number;
}

export interface AgentQuotaState {
  balanceCoins: number | null;
  currency: string;
  available: boolean;
  reason?: string;
}

/** 整个聊天区的可渲染状态。reducer 的输出，元件的输入。 */
export interface AgentChatState {
  items: AgentTranscriptItem[];
  pendingConfirms: AgentPendingConfirm[];
  pendingQuestions: AgentPendingQuestion[];
  quota: AgentQuotaState | null;
  /** 最后见过的事件序号，重连时当 last_event_id 续传。 */
  lastEventId: number;
  /** true = 助手正在产出（收到过 delta / tool 事件，还没 turn.done）。 */
  turnActive: boolean;
  /** 会话已终结（session.closed）。之后所有输入都该被禁掉。 */
  closed: boolean;
  closedReason?: string;
}

export const EMPTY_AGENT_CHAT_STATE: AgentChatState = {
  items: [],
  pendingConfirms: [],
  pendingQuestions: [],
  quota: null,
  lastEventId: 0,
  turnActive: false,
  closed: false,
};
