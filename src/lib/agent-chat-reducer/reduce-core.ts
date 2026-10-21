import type { AgentSteerStatus } from "../agent-chat-types/types-events";
import type { AgentAssistantTextItem, AgentChatState, AgentTranscriptItem } from "../agent-chat-types/types-core";
import type { AgentTaskStatus } from "../agent-task-status";
// ─────────────────────────── 条目 id 生成

/** 事件类条目：seq = event_id，id = `<kind>-<event_id>`。 */
export function eventItemId(kind: string, eventId: number): string {
  return `${kind}-${eventId}`;
}

/**
 * 使用者消息：seq 契约上是 0，所以 id 用「该 kind 已有条目数」当序，
 * 保证同一个 state 内不碰撞且插入顺序稳定。
 */
export function userItemId(state: AgentChatState): string {
  let count = 0;
  for (const item of state.items) {
    if (item.kind === "user") count += 1;
  }
  return `user-${count}`;
}
// ─────────────────────────── 事件对应分支

/**
 * 思维链计时结算（2026-09-20 真功能：把预览承诺的「已思考 · N 秒」做成真数据）。
 *
 * 只对「有起点（reasoningStartedAt）且还没结算（reasoningMs === undefined）」的
 * 条目生效；回 undefined 代表本次一个栏位都不写——呼叫方据此保持原本的物件形状，
 * 没有思维链的条目逐位元与旧行为一致（不长出 undefined 键）。
 *
 * 为什么读 Date.now()：时长无从由事件推得（网关不送时间戳），唯一诚实的来源是
 * 本端拿到 reasoning 的那一刻与思考结束的那一刻之差。reducer 因此在这两处
 * 破例碰时钟——除时间栏位外，其余状态转换仍与输入一一对应。
 */
export function settleReasoningMs(item: AgentAssistantTextItem, now: number): number | undefined {
  if (item.reasoningStartedAt === undefined || item.reasoningMs !== undefined) return undefined;
  return Math.max(0, now - item.reasoningStartedAt);
}
/**
 * 成品／失败事件到来 → 把对应的 pending 工具卡结算掉（2026-09-18 契约）。
 *
 * 匹配优先序：
 *   1. `taskId === 事件的 task_id` 的精确匹配 —— 同一次提交的任务号对号入座；
 *   2. 事件没带 task_id、或带了却找不到对应卡 → 回退结算**最旧的一张** pending 卡
 *      （FIFO 兜底：宁可早一张结算，也不让成品已经到了、卡片还在转）。
 *
 * 只碰 status === "pending" 的卡：running 由 tool.result / turn.done 负责，
 * 已定案的卡绝不被翻案。找不到任何 pending 卡时回传原阵列（reference 不变，
 * 呼叫端行为与现状逐位元一致）。就地不 mutate：变更时回新 slice。
 */
export function settlePendingToolItems(
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
/**
 * 多行文本的最后一个非空行。subagent 卡片的预览行只取它——置顶跑马灯
 * 永远只滚一行（全文另存在 text 栏，F4：渲染层才截断 + 可展开，模型不丢）。
 */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return "";
}
/**
 * 收尾用的条目转换：把 streaming 的助手标记停掉、把还在 running 的工具判死。
 * 用 for 循环而非 map，是为了让每个分支都有确定性别（map 的回传类型会被
 * 宽化成 status: string），assignment 到 AgentTranscriptItem[] 也能给字面类型
 * 正确的 context。
 *
 * `pending`（2026-09-18 中继态）**不在这里判死**：turn 结束只代表这一轮助手文本
 * 说完了，不代表成品到了 —— 提交型生图/生片工具的任务此刻仍在上游跑，成品
 * （image/video/audio.done）或失败（image.failed）事件可能落在下一轮里。判死它
 * 就是谎报失败，所以 pending 必须留着等那两类事件结算。
 */
export function settleItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const next: AgentTranscriptItem[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.kind === "assistant" && it.streaming) {
      // 思维链结算时机 b（2026-09-20）：想完就直接结束、没有正文可等——收尾这一刻
      // 就是思考的终点。已在时机 a 结算过的条目（reasoningMs 已定）不再覆写，
      // 没有计时起点的条目维持原本形状。
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
/** 终态：已生效／已中止／未生效／未确认。到了这里就不再被后续帧改回进行中。
 *  injected（D2-5 修复，2026-09-23）：它也是终态——「已注入本回合」是已经发生过的事，
 *  迟到的 queued 帧（重连回放）不得把它打回「排队中」的假象。
 *  uncertain（D2b，2026-09-23）：网关明说「投递已发出但没等到确认，永不自动重发」——
 *  它同样是终态：迟到的 applied/queued 帧不得把「未确认」改写成已生效或排队中，
 *  那正是「模型收到两次而 View 只显示一次」的镜像假话。 */
export function isSteerTerminal(status: AgentSteerStatus): boolean {
  return (
    status === "applied" ||
    status === "aborted" ||
    status === "failed" ||
    status === "injected" ||
    status === "uncertain"
  );
}
