import type { AgentSseEvent } from "../agent-chat-types/types-events";
import type { AgentChatState, AgentSubagentItem, AgentSubagentReportItem, AgentTranscriptItem } from "../agent-chat-types/types-core";
import { eventItemId, lastNonEmptyLine } from "./reduce-core";
/** 派遣子代理的工具名（工具卡与子代理栏的状态必须同源，F1）。 */
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
export function reduceSubagentStarted(
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

export function reduceSubagentDelta(
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

// 2026-10-05：subagent.tool 帧 → 归并进对应子代理条目的 tools。
// 同一 call_id 覆盖状态（网关只在状态变化时发帧，此处仍按 callId 归并以防重连补发）；
// done 之后的迟到帧不再改写已定案的卡（与 delta 同纪律）；只留最近 6 条。
const SUBAGENT_TOOL_CAP = 6;

export function reduceSubagentTool(
  state: AgentChatState,
  event: AgentSseEvent & { name: "subagent.tool" },
): AgentChatState {
  const { id, call_id, tool, status } = event.data;
  const items = state.items.slice();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it.kind !== "subagent" || it.subagentId !== id) continue;
    if (it.status !== "running") return state;
    const prev = it.tools ?? [];
    const idx = prev.findIndex((t) => t.callId === call_id);
    const next = idx >= 0 ? prev.map((t, j) => (j === idx ? { callId: call_id, tool, status } : t)) : [...prev, { callId: call_id, tool, status }];
    items[i] = { ...it, tools: next.slice(-SUBAGENT_TOOL_CAP) };
    return { ...state, items, turnActive: true };
  }
  return state;
}

export function reduceSubagentDone(
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
 * done 帧、条目转为定态，下一次收尾才走上面的转存。
 */
export function retireSubagentItems(items: AgentTranscriptItem[]): AgentTranscriptItem[] {
  const out: AgentTranscriptItem[] = [];
  for (const it of items) {
    if (it.kind !== "subagent" || it.status === "running") {
      out.push(it);
      continue;
    }
    const full = (it.text ?? "").trim();
    const summary = it.summary?.trim() ?? "";
    // 取较完整者：SSE 的 summary 可能被帧长截断，delta 串流才是全文。
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
