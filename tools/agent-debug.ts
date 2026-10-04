#!/usr/bin/env -S npx tsx
//
// agent-debug —— eimu.dev 生产 Agent 的调试服务。
//
// 目的：不开浏览器，直接对生产 agent 网关（store.tinchak0207.xyz）跑一轮真实对话，
// 完整录下 SSE 事件流，再用「生产前端同一份 reducer」（src/lib/agent-chat-reducer.ts
// + agent-chat-types.ts）把事件还原成用户看到的 transcript —— 精细到足以反推出
// 用户所见的体验：思维链（reasoning.delta）、助手文字、工具卡、问题卡、确认卡、
// 画布/工作流节点图、出图结果，以及每一步的延迟（首字延迟、delta 间隙 = 流畅度）。
//
// 用法（bash）：
//   npx tsx tools/agent-debug.ts "帮我画一张赛博朋克猫咪"          # 一轮对话：建会话→发消息→等 turn.done→报告→清理
//   npx tsx tools/agent-debug.ts --keep "画一张..."                # 同上但保留会话（印 session id，后续 --resume 续聊）
//   npx tsx tools/agent-debug.ts --resume <sid> "改成夜景"          # 在既有会话续聊（--resume 之后接消息文本）
//   npx tsx tools/agent-debug.ts --resume <sid> --answer "蓝色"     # 回答上一个 pending 的 question.request
//   npx tsx tools/agent-debug.ts --resume <sid> --confirm yes      # 批准上一个 pending 的 confirm.request
//   npx tsx tools/agent-debug.ts --json out.json "..."             # 原始事件流另存 JSON（离线复查）
//   npx tsx tools/agent-debug.ts --template <id> "..."             # 先按模板铺画布（泳道快照上行，模拟生产前端）再发消息
//   npx tsx tools/agent-debug.ts --canvas snap.json "..."          # 上传自备画布快照（agent 的 canvas_get_state 读这份）
//
// 认证：B 端 key（Bearer sk-biz-*），预设从 .env.biz-key 读；也可 --key 或环境变量 AGENT_DEBUG_KEY。
// 注意：走的是网关直连路径（与站点代理差一层 profile/lessons 注入），事件层与用户所见完全同源。
// 2026-08-25：--template/--canvas 补上生产前端的「点模板→画布泳道快照上行」行为
// （applyTemplateToCanvas 布局 + postCanvasSnapshot 上传），否则 agent 的
// canvas_get_state 看到空画布，与用户所见不同源。
// 2026-09-03：P2-13 修复——多轮会话重放（last_event_id=0）把历史的 question.replied /
// confirm.resolved / 旧 turn.done 全灌进 events，「是否有待答卡／是否落定」若用全量
// 历史 some 判定会被永久遮蔽（--answer 永假、停机判定永不到达）。改为游标语义：只看
// 「最后一个 request 事件之后」有没有对应 resolution／turn.done。CLI 介面与输出不变。
//
// 报告结构：
//   1) Timeline   —— 每个事件的时间轴（相对本轮起点的毫秒 + 事件名 + 摘要）
//   2) UX metrics —— 首字延迟 / 首工具延迟 / delta 数与间隙统计（流畅度）/ 轮总时长
//   3) Transcript —— 用生产 reducer 还原的用户所见条目（含思维链）
//   4) Workflow   —— canvas.* 事件重建的工作流图（节点、角色、模型、状态、连线、出图）
//   5) Language   —— 用户消息 vs 助手回覆的语言/繁简判定（语言镜像验证）

import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  parseAgentSseEvent,
  EMPTY_AGENT_CHAT_STATE,
  type AgentSseEvent,
  type AgentChatState,
  type AgentTranscriptItem,
} from "../src/lib/agent-chat-types";
import { agentChatReducer, appendUserTurn } from "../src/lib/agent-chat-reducer";
import { AGENT_TEMPLATES_FULL } from "../src/lib/agent-templates-payload";
import { templateToCanvasLayout } from "../src/components/canvas-workstation/agent-template-canvas";

// ─────────────────────────── 常数与参数

const DEFAULT_BASE = "https://store.tinchak0207.xyz";
const TURN_TIMEOUT_MS = 900_000; // 一轮上限 15 分钟（复杂工作流：模型探测规格+建 10+ 节点可达 5-8 分钟，300s 会掐断健康轮次——run3 实录 303s 被切）
const SSE_CONNECT_TIMEOUT_MS = 15_000;

interface CliOptions {
  message?: string;
  resumeSessionId?: string;
  keepSession: boolean;
  answer?: string;
  confirm?: boolean;
  watch?: boolean;
  jsonOut?: string;
  directive?: string;
  templateId?: string;
  canvasFile?: string;
  base: string;
  key: string;
}

/** 生成某模板的画布快照（与生产前端 applyTemplateToCanvas + postCanvasSnapshot 同源）。 */
function snapshotForTemplate(templateId: string): unknown {
  const tpl = AGENT_TEMPLATES_FULL.find((t) => t.id === templateId);
  if (!tpl) throw new Error(`未知模板 id: ${templateId}`);
  const { nodes, connections } = templateToCanvasLayout(tpl);
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: String(n.type),
      title: n.title,
      position: n.position,
      width: n.width,
      height: n.height,
      metadata: n.metadata ?? {},
    })),
    connections,
    selectedNodeIds: [],
    viewport: { x: 0, y: 0, k: 1 },
    character_cards: [],
  };
}

function readBizKey(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENT_DEBUG_KEY;
  if (env) return env;
  const file = readFileSync(".env.biz-key", "utf8");
  const m = file.match(/sk-biz-[A-Za-z0-9_-]+/);
  if (!m) throw new Error("在 .env.biz-key 里找不到 sk-biz-* key；用 --key 指定。");
  return m[0];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { keepSession: false, base: DEFAULT_BASE, key: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") opts.keepSession = true;
    else if (a === "--answer") opts.answer = argv[++i];
    else if (a === "--confirm") {
      opts.confirm = true;
      if (argv[i + 1] === "yes") i++; // "--confirm yes" 的 yes 是确认动作，不是聊天消息
    }
    else if (a === "--watch") opts.watch = true;
    else if (a === "--json") opts.jsonOut = argv[++i];
    else if (a === "--directive") opts.directive = argv[++i];
    else if (a === "--template") opts.templateId = argv[++i];
    else if (a === "--canvas") opts.canvasFile = argv[++i];
    else if (a === "--key") opts.key = argv[++i];
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--resume") opts.resumeSessionId = argv[++i];
    else rest.push(a);
  }
  if (rest.length > 0) opts.message = rest.join(" ");
  opts.key = readBizKey(opts.key);
  if (opts.templateId) {
    const tpl = AGENT_TEMPLATES_FULL.find((t) => t.id === opts.templateId);
    if (!tpl) {
      console.error(`未知模板 id: ${opts.templateId}`);
      process.exit(2);
    }
    if (!opts.message) opts.message = tpl.initialPrompt;
    if (!opts.directive) opts.directive = tpl.directive;
    console.log(`模板: ${tpl.name}（initialPrompt + directive 自动注入）`);
  }
  if (!opts.message && !opts.answer && !opts.confirm && !opts.watch) {
    console.error('用法：npx tsx tools/agent-debug.ts [--keep] [--json out.json] "消息" 或 --resume <sid> (--answer X | --confirm yes | "续聊消息")');
    process.exit(2);
  }
  return opts;
}

// ─────────────────────────── 网关 HTTP

async function gw(
  base: string,
  key: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

// ─────────────────────────── SSE 录制

interface RecordedEvent {
  tMs: number; // 相对本轮起点
  name: string;
  eventId: number;
  data: unknown;
}

/** 打开事件流并持续解帧，直到 callback 说停。回传录到的事件阵列（含断流错误标记）。 */
async function recordSse(
  base: string,
  key: string,
  sessionId: string,
  shouldStop: () => boolean,
  onEvent?: (ev: RecordedEvent) => void,
  sink?: RecordedEvent[],
  replayFrom?: number,
): Promise<{ events: RecordedEvent[]; error?: string }> {
  const ticket = await gw(base, key, `/agent/v1/sessions/${sessionId}/sse-ticket`, { method: "POST" });
  if (ticket.status !== 200 || !ticket.json?.ticket) {
    return { events: [], error: `sse-ticket 失败 HTTP ${ticket.status}: ${JSON.stringify(ticket.json).slice(0, 200)}` };
  }
  const events: RecordedEvent[] = sink ?? [];
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSE_CONNECT_TIMEOUT_MS + TURN_TIMEOUT_MS);

  const pump = (async () => {
    const replayQs = replayFrom !== undefined ? `&last_event_id=${replayFrom}` : "";
    const res = await fetch(
      `${base}/agent/v1/sessions/${sessionId}/events?ticket=${encodeURIComponent(ticket.json.ticket)}${replayQs}`,
      { signal: controller.signal, headers: { Accept: "text/event-stream" } },
    );
    if (!res.ok || !res.body) {
      events.push({ tMs: performance.now() - start, name: "__http_error", eventId: 0, data: { status: res.status } });
      return;
    }
    clearTimeout(timer);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      if (shouldStop()) {
        controller.abort();
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        events.push({ tMs: performance.now() - start, name: "__stream_closed", eventId: 0, data: {} });
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) {
          ev.tMs = performance.now() - start;
          events.push(ev);
          onEvent?.(ev);
        }
      }
    }
  })().catch((e: Error) => {
    if (e.name !== "AbortError") {
      events.push({ tMs: performance.now() - start, name: "__stream_error", eventId: 0, data: { message: e.message } });
    }
  });

  await pump;
  return { events };
}

/** SSE 帧 → {name, eventId, data}。event:/data: 各取最后一行；id: 行为 event_id 来源。 */
function parseFrame(frame: string): RecordedEvent | null {
  let name = "";
  let data = "";
  let eventId = 0;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
    else if (line.startsWith("id:")) eventId = Number(line.slice(3).trim()) || 0;
  }
  if (!name || !data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  // 网关契约：data 内含 event_id；缺时以帧 id 补（与前端 EventSource 行为对齐）。
  if (parsed && typeof parsed === "object" && !("event_id" in (parsed as object))) {
    (parsed as Record<string, unknown>).event_id = eventId;
  }
  return { tMs: 0, name, eventId, data: parsed };
}

// ─────────────────────────── 报告渲染

function summarizeEvent(name: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "message.delta":
    case "reasoning.delta":
      return `(text ${String(d.text ?? "").length} 字)`;
    case "tool.invoke":
      return `${d.tool}${d.args_summary ? " · " + String(d.args_summary).slice(0, 80) : ""}`;
    case "tool.result":
      return `${d.tool} · ${d.ok === true ? "ok" : "FAILED"}${d.cost_coins ? ` · ${d.cost_coins} 币` : ""}`;
    case "question.request": {
      const qs = Array.isArray(d.questions) ? d.questions.length : 0;
      return `(${qs} 题)`;
    }
    case "question.replied":
      return "(已回答)";
    case "confirm.request":
      return `${d.amount_coins ?? "?"} 币`;
    case "canvas.plan":
      return `${d.tool ?? ""} ${d.label ?? ""}`.trim();
    case "canvas.node.created":
      return `node=${(d.node as any)?.id ?? "?"} role=${(d.node as any)?.role ?? (d.node as any)?.metadata?.role ?? ""} model=${(d.node as any)?.metadata?.model ?? ""}`;
    case "canvas.node.updated":
      return `node=${d.node_id} ${(d.patch as any)?.status ?? ""}`;
    case "canvas.node.generating":
      return `node=${d.node_id} ${d.status ?? ""}`;
    case "canvas.node.connected":
      return `\u{2192} ${(d.connection as any)?.toNodeId ?? "?"}`;
    case "image.done":
      return `task=${d.task_id ?? "?"} url=${String(d.url ?? "").slice(0, 60)}`;
    case "turn.done":
      return "(本轮结束)";
    case "turn.plan":
      // 首计画延迟的来源帧（由网关在送讯后 ~1.4–2.0s 先送）。摘要要能一眼看出
      // 是真模型计画还是规则兜底：source + 命中的专家。
      return `${d.source === "rule" ? "[rule]" : "[model]"} ${String(d.plan ?? "").slice(0, 60)}${Array.isArray(d.experts) && d.experts.length > 0 ? ` · 专家=${(d.experts as unknown[]).join(",")}` : ""}`;
    default:
      return JSON.stringify(d).slice(0, 90);
  }
}

function renderTimeline(events: RecordedEvent[]): void {
  console.log("\n─── 1) Timeline ───────────────────────────────");
  for (const e of events) {
    console.log(`  +${String(Math.round(e.tMs)).padStart(6)}ms  ${e.name.padEnd(22)} ${summarizeEvent(e.name, e.data)}`);
  }
}

function renderUxMetrics(events: RecordedEvent[]): void {
  console.log("\n─── 2) UX metrics ─────────────────────────────");
  const deltas = events.filter((e) => e.name === "message.delta" || e.name === "reasoning.delta");
  const firstDelta = deltas[0]?.tMs;
  // 首计画延迟（turn.plan）：独立于上面的 deltas ——「首字延迟」必须维持
  // 「真模型正文首个 delta」的语义，turn.plan 帧不得混进 deltas 的 filter
  // （否则计画帧一到就报 +1.5s 首字，是谎报）。这一条量的正是计画卡上屏时间。
  const firstPlan = events.find((e) => e.name === "turn.plan")?.tMs;
  const firstTool = events.find((e) => e.name === "tool.invoke")?.tMs;
  const last = events[events.length - 1]?.tMs ?? 0;
  const gaps: number[] = [];
  for (let i = 1; i < deltas.length; i++) gaps.push(deltas[i].tMs - deltas[i - 1].tMs);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const gapOver500 = gaps.filter((g) => g > 500).length;
  console.log(`  首字延迟（首个 delta）: ${firstDelta !== undefined ? Math.round(firstDelta) + "ms" : "—"}`);
  console.log(`  首计画延迟（turn.plan）: ${firstPlan !== undefined ? Math.round(firstPlan) + "ms" : "—"}`);
  console.log(`  首工具延迟:            ${firstTool !== undefined ? Math.round(firstTool) + "ms" : "—"}`);
  console.log(`  delta 总数:             ${deltas.length}（message=${events.filter((e) => e.name === "message.delta").length}, reasoning=${events.filter((e) => e.name === "reasoning.delta").length}）`);
  console.log(`  delta 平均间隙:         ${avgGap ? Math.round(avgGap) + "ms" : "—"}  最大间隙: ${maxGap ? Math.round(maxGap) + "ms" : "—"}  >500ms 停顿: ${gapOver500} 次`);
  console.log(`  本轮总时长:             ${Math.round(last)}ms`);
  console.log(`  事件总数:               ${events.length}`);
}

function renderTranscript(state: AgentChatState): void {
  console.log("\n─── 3) Transcript（生产 reducer 还原 = 用户所见）──");
  for (const item of state.items) {
    renderTranscriptItem(item);
  }
  if (state.pendingQuestions.length > 0) {
    console.log("  [浮动] 待回答问题卡：");
    for (const q of state.pendingQuestions) {
      for (const question of q.questions) {
        console.log(`    ❓ ${question.question}`);
        for (const opt of question.options ?? []) console.log(`       · ${opt.label}`);
      }
    }
  }
  if (state.pendingConfirms.length > 0) {
    console.log("  [浮动] 待确认扣费卡：");
    for (const c of state.pendingConfirms) {
      console.log(`    💰 ${c.amountCoins} 币 ${c.description ? "· " + c.description : ""}`);
    }
  }
  if (state.quota) {
    console.log(`  [额度] ${state.quota.balanceCoins ?? "?"} 币（${state.quota.available ? "可用" : "不可用"}）`);
  }
}

function renderTranscriptItem(item: AgentTranscriptItem): void {
  switch (item.kind) {
    case "user":
      console.log(`  \u{1F464} 用户: ${item.text}`);
      break;
    case "assistant":
      console.log(`  \u{1F916} 助手: ${item.text}`);
      if (item.reasoning) console.log(`      \u{1F9E0} 思维链: ${item.reasoning.slice(0, 600)}${item.reasoning.length > 600 ? " …(截断)" : ""}`);
      break;
    case "tool":
      console.log(`  \u{1F527} 工具[${item.tool}] ${item.status}${item.argsSummary ? " · " + item.argsSummary : ""}${item.costCoins ? " · " + item.costCoins + " 币" : ""}`);
      break;
    case "plan":
      console.log(
        `  \u{1F5C2} 计划${item.provisional ? "（进行中）" : ""}${item.collapsed ? "（已收合）" : ""}: ${item.text}${item.experts && item.experts.length > 0 ? ` · 专家=${item.experts.join(",")}` : ""}`,
      );
      break;
    case "image":
      console.log(`  \u{1F5BC}  图: ${item.url}`);
      break;
    case "notice":
      console.log(`  \u{26A0}\u{FE0F} 通知[${item.tone}]: ${item.text}`);
      break;
  }
}

interface WfNode {
  id: string;
  role?: string;
  model?: string;
  status?: string;
  image?: string;
}

function renderWorkflow(events: RecordedEvent[]): void {
  const canvasEvents = events.filter((e) => e.name.startsWith("canvas."));
  if (canvasEvents.length === 0) {
    console.log("\n─── 4) Workflow ───────────────────────────────\n  （本轮无画布/工作流事件）");
    return;
  }
  console.log("\n─── 4) Workflow（canvas.* 事件重建）───────────");
  const nodes = new Map<string, WfNode>();
  const connections: Array<{ from: string; to: string }> = [];
  let unitLabel = "";
  for (const e of canvasEvents) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if (e.name === "canvas.plan") {
      unitLabel = `${d.tool ?? ""} ${d.label ?? ""}`.trim();
      console.log(`  计画: ${unitLabel}（unit=${d.unit_id}）`);
    } else if (e.name === "canvas.node.created") {
      const n = (d.node ?? {}) as Record<string, unknown>;
      const meta = (n.metadata ?? {}) as Record<string, unknown>;
      const node: WfNode = {
        id: String(n.id ?? "?"),
        role: String(n.role ?? meta.role ?? ""),
        model: String(meta.model ?? ""),
        status: "created",
      };
      nodes.set(node.id, node);
      console.log(`  节点 + ${node.id} role=${node.role} model=${node.model}`);
    } else if (e.name === "canvas.node.connected") {
      const c = (d.connection ?? {}) as Record<string, unknown>;
      connections.push({ from: String(c.fromNodeId), to: String(c.toNodeId) });
    } else if (e.name === "canvas.node.updated") {
      const patch = (d.patch ?? {}) as Record<string, unknown>;
      const node = nodes.get(String(d.node_id));
      if (node) {
        if (patch.status) node.status = String(patch.status);
        const url = patch.image_url ?? patch.url;
        if (typeof url === "string" && url) node.image = url;
      }
      console.log(`  节点 ~ ${d.node_id} → ${patch.status ?? ""}${patch.errorDetails ? " 错误: " + JSON.stringify(patch.errorDetails).slice(0, 80) : ""}`);
    } else if (e.name === "canvas.node.generating") {
      console.log(`  节点 ⟳ ${d.node_id} ${d.status ?? ""}`);
    } else if (e.name === "canvas.budget.updated") {
      console.log(`  预算: 已用 ${d.used_coins} 币 / 剩 ${d.remaining_coins} 币`);
    }
  }
  if (connections.length > 0) {
    console.log("  连线: " + connections.map((c) => `${c.from}→${c.to}`).join(", "));
  }
  const unresolved = [...nodes.values()].filter((n) => n.status !== "completed");
  if (unresolved.length > 0) {
    console.log(`  ⚠ 未完成节点: ${unresolved.map((n) => `${n.id}(${n.status})`).join(", ")}`);
  }
}

/** 粗判繁/简/拉丁。用差异字符集计分：命中越多该类可能性越高。 */
function detectScript(s: string): string {
  const TRAD = "繁体语系们发说时么这个请绍长们里后点让画图对与体点风猫赛";
  const SIMP = "简体语们发说时么这个请绍长们里后点让画图对与体点风猫赛";
  let trad = 0;
  let simp = 0;
  for (const ch of s) {
    if (TRAD.includes(ch)) trad++;
    if (SIMP.includes(ch)) simp++;
  }
  if (!/[\u4e00-\u9fff]/.test(s)) return /[A-Za-z]/.test(s) ? "latin/英文" : "其他";
  if (simp > 0 && trad === 0) return "简体";
  if (trad > 0 && simp === 0) return "繁体";
  if (simp > 0 && trad > 0) return trad >= simp ? "繁体为主" : "简体为主";
  return "中文（无差异字，无法判别）";
}

function renderLanguage(userText: string, assistantText: string): void {
  console.log("\n─── 5) Language（语言镜像检查）────────────────");
  console.log(`  用户: ${detectScript(userText)}`);
  console.log(`  助手: ${detectScript(assistantText)}`);
}

// ─────────────────────────── 主流程

/** 最后一个指定名称事件的索引（-1 = 没有）。events 按到达顺序 append，索引即游标。 */
function lastEventIndex(events: RecordedEvent[], name: string): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].name === name) return i;
  return -1;
}

/** 游标语义（P2-13）：request 事件「之后」是否出现过任一 resolution 事件。
 *  禁止用全量历史 some——上一轮已答的卡会遮蔽本轮判定。 */
function resolvedAfter(events: RecordedEvent[], requestIndex: number, resolutionNames: string[]): boolean {
  for (let i = requestIndex + 1; i < events.length; i++) {
    if (resolutionNames.includes(events[i].name)) return true;
  }
  return false;
}

function requestIdOf(e: RecordedEvent): string {
  return String((e.data as Record<string, unknown> | null)?.request_id ?? "");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const base = opts.base.replace(/\/+$/, "");
  let sessionId = opts.resumeSessionId;
  let created = false;

  if (!sessionId) {
    const created0 = await gw(base, opts.key, "/agent/v1/sessions", { method: "POST", body: {} });
    if (created0.status !== 200 || !created0.json?.session_id) {
      console.error(`建会话失败 HTTP ${created0.status}: ${JSON.stringify(created0.json).slice(0, 300)}`);
      process.exit(1);
    }
    sessionId = String(created0.json.session_id);
    created = true;
    console.log(`会话已建立: ${sessionId}`);
  } else {
    console.log(`续用会话: ${sessionId}`);
  }

  // ── 画布快照上行（模拟生产前端 postCanvasSnapshot：agent 的 canvas_get_state 读这份）
  let canvasSnapshot: unknown;
  if (opts.templateId) {
    canvasSnapshot = snapshotForTemplate(opts.templateId);
    console.log(`模板画布快照已生成（${opts.templateId}，节点 ${(canvasSnapshot as { nodes: unknown[] }).nodes.length} 颗）`);
  } else if (opts.canvasFile) {
    try {
      canvasSnapshot = JSON.parse(readFileSync(opts.canvasFile, "utf8"));
    } catch (err) {
      console.error(`读取画布快照失败 ${opts.canvasFile}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  if (canvasSnapshot !== undefined) {
    const up = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/canvas/state`, {
      method: "POST",
      body: { state: canvasSnapshot },
    });
    console.log(`画布快照上行 HTTP ${up.status}${up.status >= 300 ? " " + JSON.stringify(up.json).slice(0, 200) : ""}`);
    if (up.status >= 300) {
      if (created) await gw(base, opts.key, `/agent/v1/sessions/${sessionId}`, { method: "DELETE" });
      process.exit(1);
    }
  }

  // ── 录制与驱动并行：先起 SSE（不 await），再发消息/答题，轮询事件决定何时停。
  const start = performance.now();
  const events: RecordedEvent[] = [];
  let recordError: string | undefined;
  let stopRecording = false;

  const recorded = recordSse(
    base,
    opts.key,
    sessionId,
    () => stopRecording,
    (ev) => {
      // 进度提示：重要事件即时可见，不影响最终报告。
      if (ev.name === "turn.done" || ev.name === "session.closed" || ev.name === "question.request" || ev.name === "confirm.request" || ev.name === "image.done") {
        console.log(`  … +${Math.round(ev.tMs)}ms ${ev.name}`);
      }
    },
    events,
    // 续用会话时重放全部历史事件（含未答的 question/confirm 卡），新建会话不重放。
    opts.resumeSessionId !== undefined ? 0 : undefined,
  ).then((r) => {
    recordError = r.error;
    return r;
  });

  // 给 SSE 一点连接时间再发消息。
  await new Promise((r) => setTimeout(r, 1_500));

  // ── resume 重放稳定等待：重放可能慢于 1.5s（实录 201 事件 ~1.2s 仍在流），
  //    基准线取太早会把重放的旧 turn.done 误判为本轮终止（round-5 踩中：消息发了
  //    但 0 新事件，录到 1.2s 就结束）。等「连续 2s 无新事件」或 15s 兜底再取基准。
  {
    const settleDeadline = performance.now() + 15_000;
    let idleSince = performance.now();
    for (;;) {
      const before = events.length;
      await new Promise((r) => setTimeout(r, 200));
      if (events.length > before) {
        idleSince = performance.now();
        continue;
      }
      if (performance.now() - idleSince >= 2_000) break;
      if (performance.now() >= settleDeadline) break;
    }
  }

  // resume 重放（last_event_id=0）会把历史事件（含旧 turn.done）重新灌入；只有
  // event_id 高于重放水位、且时间晚于消息发出时刻的新 turn.done 才是本轮真实终止信号。
  const baselineEventId = events.reduce((max, e) => Math.max(max, e.eventId), 0);
  let sentAtMs: number | undefined;

  if (opts.message) {
    const sent = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: {
        content: opts.message,
        ...(opts.directive ? { session_directive: opts.directive } : {}),
        ...(canvasSnapshot !== undefined ? { canvas_state: canvasSnapshot } : {}),
      },
    });
    if (sent.status >= 300) {
      console.error(`发消息失败 HTTP ${sent.status}: ${JSON.stringify(sent.json).slice(0, 300)}`);
      stopRecording = true;
      await recorded;
      if (created) await gw(base, opts.key, `/agent/v1/sessions/${sessionId}`, { method: "DELETE" });
      process.exit(1);
    }
    sentAtMs = performance.now() - start;
    console.log(`消息已发送（${opts.message.length} 字）`);
  }

  // ── 轮询：等 turn.done / session.closed / 超时；途中处理 --answer / --confirm。
  let stopAt = performance.now() + (opts.message || opts.watch ? TURN_TIMEOUT_MS : 30_000);
  let answered = false;
  let confirmed = false;
  const failedAnswerReqs = new Set<string>();
  const failedConfirmReqs = new Set<string>();
  for (;;) {
    if (performance.now() >= stopAt) break;
    const terminal = events.some(
      (e) =>
        (e.name === "turn.done" || e.name === "session.closed") &&
        e.eventId > baselineEventId &&
        (sentAtMs === undefined || e.tMs > sentAtMs - 100),
    );
    if (terminal) break;

    // question.request 出现且指定了 --answer：回答它（一轮只答最后一张卡；非 2xx 视为
    // 卡已失效/重发，不标记已答，等新卡）。
    // P2-13：待答判定采游标语义——只看最后一个 question.request「之后」有没有
    // question.replied/rejected；全量历史 some 会被上一轮已答过的卡永久遮蔽。
    const qIdx = lastEventIndex(events, "question.request");
    const qOpen = qIdx >= 0 && !resolvedAfter(events, qIdx, ["question.replied", "question.rejected"]);
    const pendingQ = qOpen && !failedAnswerReqs.has(requestIdOf(events[qIdx])) ? events[qIdx] : undefined;
    if (opts.answer && !answered && pendingQ) {
      const reqId = (pendingQ.data as Record<string, unknown>).request_id;
      const r = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/question`, {
        method: "POST",
        body: { request_id: reqId, answers: [[opts.answer]] },
      });
      console.log(`已回答问题 ${reqId} → "${opts.answer}"（HTTP ${r.status}）`);
      if (r.status >= 200 && r.status < 300) {
        answered = true;
        stopAt = performance.now() + TURN_TIMEOUT_MS;
      } else {
        failedAnswerReqs.add(String(reqId));
      }
    }
    // confirm.request 同理采游标语义（P2-13）：只看最后一个 confirm.request 之后有无 confirm.resolved。
    const cIdx = lastEventIndex(events, "confirm.request");
    const cOpen = cIdx >= 0 && !resolvedAfter(events, cIdx, ["confirm.resolved"]);
    const pendingC = cOpen && !failedConfirmReqs.has(requestIdOf(events[cIdx])) ? events[cIdx] : undefined;
    if (opts.confirm && !confirmed && pendingC) {
      const reqId = (pendingC.data as Record<string, unknown>).request_id;
      const r = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/confirm`, {
        method: "POST",
        body: { request_id: reqId, approved: true },
      });
      console.log(`已批准确认 ${reqId}（HTTP ${r.status}）`);
      if (r.status >= 200 && r.status < 300) {
        confirmed = true;
        stopAt = performance.now() + TURN_TIMEOUT_MS;
      } else {
        failedConfirmReqs.add(String(reqId));
      }
    }

    // 出现待答卡且没有自动回答手段：停（该等人工输入了，用 --resume --answer 续）。
    // P2-13：turn.done 同理取游标——只有「最新待答卡之后」的 turn.done 才算本轮落定；
    // 历史重放进来的旧 turn.done 不得参与 hasPendingCard/pendingUnresolved 的全量判定。
    const lastT = events[events.length - 1]?.tMs ?? 0;
    const newestCardIdx = Math.max(qOpen ? qIdx : -1, cOpen ? cIdx : -1);
    const pendingUnresolved = newestCardIdx >= 0 && lastEventIndex(events, "turn.done") < newestCardIdx;
    if (pendingUnresolved && performance.now() - start - lastT > 8_000) {
      console.log("（出现待答卡且无自动回答，停止录制——用 --resume <sid> --answer \"…\" 续）");
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  stopRecording = true;
  await recorded;
  const error = recordError;
  if (error) console.error(`⚠ SSE 录制异常: ${error}`);

  // ── 还原 transcript（用生产 reducer）
  let state: AgentChatState = EMPTY_AGENT_CHAT_STATE;
  if (opts.message) state = appendUserTurn(state, opts.message);
  for (const e of events) {
    if (e.name.startsWith("__")) continue;
    const parsed = parseAgentSseEvent(e.name, JSON.stringify(e.data));
    if (parsed) state = agentChatReducer(state, parsed);
  }

  // ── 报告
  renderTimeline(events);
  renderUxMetrics(events);
  renderTranscript(state);
  renderWorkflow(events);
  const assistantText = state.items
    .filter((i): i is Extract<AgentTranscriptItem, { kind: "assistant" }> => i.kind === "assistant")
    .map((i) => i.text)
    .join("\n");
  renderLanguage(opts.message ?? "(无新消息)", assistantText);

  if (opts.jsonOut) {
    writeFileSync(opts.jsonOut, JSON.stringify({ sessionId, events }, null, 2));
    console.log(`\n原始事件流已存: ${opts.jsonOut}`);
  }

  // ── 清理（续用会话隐含保留：多轮上下文在后端；只有新建的单轮测试会话才默认清理）
  if (!opts.keepSession && opts.resumeSessionId === undefined) {
    const del = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}`, { method: "DELETE" });
    console.log(`会话已清理（HTTP ${del.status}）`);
  } else {
    console.log(`\n会话保留: ${sessionId}（续聊: npx tsx tools/agent-debug.ts --resume ${sessionId} "下一句"）`);
  }
}

main().catch((e: Error) => {
  console.error("agent-debug 失败:", e.message);
  process.exit(1);
});
