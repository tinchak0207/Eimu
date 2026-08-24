#!/usr/bin/env -S npx tsx
//
// agent-debug —— eimu.dev 生產 Agent 的調試服務。
//
// 目的：不開瀏覽器，直接對生產 agent 網關（store.tinchak0207.xyz）跑一輪真實對話，
// 完整錄下 SSE 事件流，再用「生產前端同一份 reducer」（src/lib/agent-chat-reducer.ts
// + agent-chat-types.ts）把事件還原成用戶看到的 transcript —— 精細到足以反推出
// 用戶所見的體驗：思維鏈（reasoning.delta）、助手文字、工具卡、問題卡、確認卡、
// 畫布/工作流節點圖、出圖結果，以及每一步的延遲（首字延遲、delta 間隙 = 流暢度）。
//
// 用法（bash）：
//   npx tsx tools/agent-debug.ts "帮我画一张赛博朋克猫咪"          # 一輪對話：建會話→發消息→等 turn.done→報告→清理
//   npx tsx tools/agent-debug.ts --keep "画一张..."                # 同上但保留會話（印 session id，後續 --resume 續聊）
//   npx tsx tools/agent-debug.ts --resume <sid> "改成夜景"          # 在既有會話續聊（--resume 之後接消息文本）
//   npx tsx tools/agent-debug.ts --resume <sid> --answer "蓝色"     # 回答上一個 pending 的 question.request
//   npx tsx tools/agent-debug.ts --resume <sid> --confirm yes      # 批准上一個 pending 的 confirm.request
//   npx tsx tools/agent-debug.ts --json out.json "..."             # 原始事件流另存 JSON（離線複查）
//
// 認證：B 端 key（Bearer sk-biz-*），預設從 .env.biz-key 讀；也可 --key 或環境變量 AGENT_DEBUG_KEY。
// 注意：走的是網關直連路徑（與站點代理差一層 profile/lessons 注入），事件層與用戶所見完全同源。
//
// 報告結構：
//   1) Timeline   —— 每個事件的時間軸（相對本輪起點的毫秒 + 事件名 + 摘要）
//   2) UX metrics —— 首字延遲 / 首工具延遲 / delta 數與間隙統計（流暢度）/ 輪總時長
//   3) Transcript —— 用生產 reducer 還原的用戶所見條目（含思維鏈）
//   4) Workflow   —— canvas.* 事件重建的工作流圖（節點、角色、模型、狀態、連線、出圖）
//   5) Language   —— 用戶消息 vs 助手回覆的語言/繁簡判定（語言鏡像驗證）

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

// ─────────────────────────── 常數與參數

const DEFAULT_BASE = "https://store.tinchak0207.xyz";
const TURN_TIMEOUT_MS = 900_000; // 一輪上限 15 分鐘（複雜工作流：模型探測規格+建 10+ 節點可達 5-8 分鐘，300s 會掐斷健康輪次——run3 實錄 303s 被切）
const SSE_CONNECT_TIMEOUT_MS = 15_000;

interface CliOptions {
  message?: string;
  resumeSessionId?: string;
  keepSession: boolean;
  answer?: string;
  confirm?: boolean;
  watch?: boolean;
  jsonOut?: string;
  base: string;
  key: string;
}

function readBizKey(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENT_DEBUG_KEY;
  if (env) return env;
  const file = readFileSync(".env.biz-key", "utf8");
  const m = file.match(/sk-biz-[A-Za-z0-9_-]+/);
  if (!m) throw new Error("在 .env.biz-key 裡找不到 sk-biz-* key；用 --key 指定。");
  return m[0];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { keepSession: false, base: DEFAULT_BASE, key: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") opts.keepSession = true;
    else if (a === "--answer") opts.answer = argv[++i];
    else if (a === "--confirm") opts.confirm = true;
    else if (a === "--watch") opts.watch = true;
    else if (a === "--json") opts.jsonOut = argv[++i];
    else if (a === "--key") opts.key = argv[++i];
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--resume") opts.resumeSessionId = argv[++i];
    else rest.push(a);
  }
  if (rest.length > 0) opts.message = rest.join(" ");
  opts.key = readBizKey(opts.key);
  if (!opts.message && !opts.answer && !opts.confirm && !opts.watch) {
    console.error('用法：npx tsx tools/agent-debug.ts [--keep] [--json out.json] "消息" 或 --resume <sid> (--answer X | --confirm yes | "續聊消息")');
    process.exit(2);
  }
  return opts;
}

// ─────────────────────────── 網關 HTTP

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

// ─────────────────────────── SSE 錄製

interface RecordedEvent {
  tMs: number; // 相對本輪起點
  name: string;
  eventId: number;
  data: unknown;
}

/** 打開事件流並持續解幀，直到 callback 說停。回傳錄到的事件陣列（含斷流錯誤標記）。 */
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
    return { events: [], error: `sse-ticket 失敗 HTTP ${ticket.status}: ${JSON.stringify(ticket.json).slice(0, 200)}` };
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

/** SSE 幀 → {name, eventId, data}。event:/data: 各取最後一行；id: 行為 event_id 來源。 */
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
  // 網關契約：data 內含 event_id；缺時以幀 id 補（與前端 EventSource 行為對齊）。
  if (parsed && typeof parsed === "object" && !("event_id" in (parsed as object))) {
    (parsed as Record<string, unknown>).event_id = eventId;
  }
  return { tMs: 0, name, eventId, data: parsed };
}

// ─────────────────────────── 報告渲染

function summarizeEvent(name: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case "message.delta":
    case "reasoning.delta":
      return `(text ${String(d.text ?? "").length} 字)`;
    case "tool.invoke":
      return `${d.tool}${d.args_summary ? " · " + String(d.args_summary).slice(0, 80) : ""}`;
    case "tool.result":
      return `${d.tool} · ${d.ok === true ? "ok" : "FAILED"}${d.cost_coins ? ` · ${d.cost_coins} 幣` : ""}`;
    case "question.request": {
      const qs = Array.isArray(d.questions) ? d.questions.length : 0;
      return `(${qs} 題)`;
    }
    case "question.replied":
      return "(已回答)";
    case "confirm.request":
      return `${d.amount_coins ?? "?"} 幣`;
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
      return "(本輪結束)";
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
  const firstTool = events.find((e) => e.name === "tool.invoke")?.tMs;
  const last = events[events.length - 1]?.tMs ?? 0;
  const gaps: number[] = [];
  for (let i = 1; i < deltas.length; i++) gaps.push(deltas[i].tMs - deltas[i - 1].tMs);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const gapOver500 = gaps.filter((g) => g > 500).length;
  console.log(`  首字延遲（首個 delta）: ${firstDelta !== undefined ? Math.round(firstDelta) + "ms" : "—"}`);
  console.log(`  首工具延遲:            ${firstTool !== undefined ? Math.round(firstTool) + "ms" : "—"}`);
  console.log(`  delta 總數:             ${deltas.length}（message=${events.filter((e) => e.name === "message.delta").length}, reasoning=${events.filter((e) => e.name === "reasoning.delta").length}）`);
  console.log(`  delta 平均間隙:         ${avgGap ? Math.round(avgGap) + "ms" : "—"}  最大間隙: ${maxGap ? Math.round(maxGap) + "ms" : "—"}  >500ms 停頓: ${gapOver500} 次`);
  console.log(`  本輪總時長:             ${Math.round(last)}ms`);
  console.log(`  事件總數:               ${events.length}`);
}

function renderTranscript(state: AgentChatState): void {
  console.log("\n─── 3) Transcript（生產 reducer 還原 = 用戶所見）──");
  for (const item of state.items) {
    renderTranscriptItem(item);
  }
  if (state.pendingQuestions.length > 0) {
    console.log("  [浮動] 待回答問題卡：");
    for (const q of state.pendingQuestions) {
      for (const question of q.questions) {
        console.log(`    ❓ ${question.question}`);
        for (const opt of question.options ?? []) console.log(`       · ${opt.label}`);
      }
    }
  }
  if (state.pendingConfirms.length > 0) {
    console.log("  [浮動] 待確認扣費卡：");
    for (const c of state.pendingConfirms) {
      console.log(`    💰 ${c.amountCoins} 幣 ${c.description ? "· " + c.description : ""}`);
    }
  }
  if (state.quota) {
    console.log(`  [額度] ${state.quota.balanceCoins ?? "?"} 幣（${state.quota.available ? "可用" : "不可用"}）`);
  }
}

function renderTranscriptItem(item: AgentTranscriptItem): void {
  switch (item.kind) {
    case "user":
      console.log(`  \u{1F464} 用戶: ${item.text}`);
      break;
    case "assistant":
      console.log(`  \u{1F916} 助手: ${item.text}`);
      if (item.reasoning) console.log(`      \u{1F9E0} 思維鏈: ${item.reasoning.slice(0, 600)}${item.reasoning.length > 600 ? " …(截斷)" : ""}`);
      break;
    case "tool":
      console.log(`  \u{1F527} 工具[${item.tool}] ${item.status}${item.argsSummary ? " · " + item.argsSummary : ""}${item.costCoins ? " · " + item.costCoins + " 幣" : ""}`);
      break;
    case "image":
      console.log(`  \u{1F5BC}  圖: ${item.url}`);
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
    console.log("\n─── 4) Workflow ───────────────────────────────\n  （本輪無畫布/工作流事件）");
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
      console.log(`  計畫: ${unitLabel}（unit=${d.unit_id}）`);
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
      console.log(`  節點 + ${node.id} role=${node.role} model=${node.model}`);
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
      console.log(`  節點 ~ ${d.node_id} → ${patch.status ?? ""}${patch.errorDetails ? " 錯誤: " + JSON.stringify(patch.errorDetails).slice(0, 80) : ""}`);
    } else if (e.name === "canvas.node.generating") {
      console.log(`  節點 ⟳ ${d.node_id} ${d.status ?? ""}`);
    } else if (e.name === "canvas.budget.updated") {
      console.log(`  預算: 已用 ${d.used_coins} 幣 / 剩 ${d.remaining_coins} 幣`);
    }
  }
  if (connections.length > 0) {
    console.log("  連線: " + connections.map((c) => `${c.from}→${c.to}`).join(", "));
  }
  const unresolved = [...nodes.values()].filter((n) => n.status !== "completed");
  if (unresolved.length > 0) {
    console.log(`  ⚠ 未完成節點: ${unresolved.map((n) => `${n.id}(${n.status})`).join(", ")}`);
  }
}

/** 粗判繁/簡/拉丁。用差異字符集計分：命中越多該類可能性越高。 */
function detectScript(s: string): string {
  const TRAD = "繁體語係們發說時麼這個請紹長們裡後點讓畫圖對與體點風貓賽";
  const SIMP = "简体语们发说时么这个请绍长们里后点让画图对与体点风猫赛";
  let trad = 0;
  let simp = 0;
  for (const ch of s) {
    if (TRAD.includes(ch)) trad++;
    if (SIMP.includes(ch)) simp++;
  }
  if (!/[\u4e00-\u9fff]/.test(s)) return /[A-Za-z]/.test(s) ? "latin/英文" : "其他";
  if (simp > 0 && trad === 0) return "簡體";
  if (trad > 0 && simp === 0) return "繁體";
  if (simp > 0 && trad > 0) return trad >= simp ? "繁體為主" : "簡體為主";
  return "中文（無差異字，無法判別）";
}

function renderLanguage(userText: string, assistantText: string): void {
  console.log("\n─── 5) Language（語言鏡像檢查）────────────────");
  console.log(`  用戶: ${detectScript(userText)}`);
  console.log(`  助手: ${detectScript(assistantText)}`);
}

// ─────────────────────────── 主流程

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const base = opts.base.replace(/\/+$/, "");
  let sessionId = opts.resumeSessionId;
  let created = false;

  if (!sessionId) {
    const created0 = await gw(base, opts.key, "/agent/v1/sessions", { method: "POST", body: {} });
    if (created0.status !== 200 || !created0.json?.session_id) {
      console.error(`建會話失敗 HTTP ${created0.status}: ${JSON.stringify(created0.json).slice(0, 300)}`);
      process.exit(1);
    }
    sessionId = String(created0.json.session_id);
    created = true;
    console.log(`會話已建立: ${sessionId}`);
  } else {
    console.log(`續用會話: ${sessionId}`);
  }

  // ── 錄製與驅動並行：先起 SSE（不 await），再發消息/答題，輪詢事件決定何時停。
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
      // 進度提示：重要事件即時可見，不影響最終報告。
      if (ev.name === "turn.done" || ev.name === "session.closed" || ev.name === "question.request" || ev.name === "confirm.request" || ev.name === "image.done") {
        console.log(`  … +${Math.round(ev.tMs)}ms ${ev.name}`);
      }
    },
    events,
    // 續用會話時重放全部歷史事件（含未答的 question/confirm 卡），新建會話不重放。
    opts.resumeSessionId !== undefined ? 0 : undefined,
  ).then((r) => {
    recordError = r.error;
    return r;
  });

  // 給 SSE 一點連接時間再發消息。
  await new Promise((r) => setTimeout(r, 1_500));

  if (opts.message) {
    const sent = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { content: opts.message },
    });
    if (sent.status >= 300) {
      console.error(`發消息失敗 HTTP ${sent.status}: ${JSON.stringify(sent.json).slice(0, 300)}`);
      stopRecording = true;
      await recorded;
      if (created) await gw(base, opts.key, `/agent/v1/sessions/${sessionId}`, { method: "DELETE" });
      process.exit(1);
    }
    console.log(`消息已發送（${opts.message.length} 字）`);
  }

  // ── 輪詢：等 turn.done / session.closed / 超時；途中處理 --answer / --confirm。
  const stopAt = performance.now() + (opts.message || opts.watch ? TURN_TIMEOUT_MS : 30_000);
  let answered = false;
  let confirmed = false;
  for (;;) {
    if (performance.now() >= stopAt) break;
    const terminal = events.some((e) => e.name === "turn.done" || e.name === "session.closed");
    if (terminal) break;

    // question.request 出現且指定了 --answer：回答它（一輪只答最後一張卡）。
    const pendingQ = [...events].reverse().find((e) => e.name === "question.request");
    if (opts.answer && !answered && pendingQ && !events.some((e) => e.name === "question.replied" || e.name === "question.rejected")) {
      const reqId = (pendingQ.data as Record<string, unknown>).request_id;
      const r = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/question`, {
        method: "POST",
        body: { request_id: reqId, answers: [[opts.answer]] },
      });
      console.log(`已回答問題 ${reqId} → "${opts.answer}"（HTTP ${r.status}）`);
      answered = true;
    }
    const pendingC = [...events].reverse().find((e) => e.name === "confirm.request");
    if (opts.confirm && !confirmed && pendingC && !events.some((e) => e.name === "confirm.resolved")) {
      const reqId = (pendingC.data as Record<string, unknown>).request_id;
      const r = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}/confirm`, {
        method: "POST",
        body: { request_id: reqId, approved: true },
      });
      console.log(`已批准確認 ${reqId}（HTTP ${r.status}）`);
      confirmed = true;
    }

    // 出現待答卡且沒有自動回答手段：停（該等人工輸入了，用 --resume --answer 續）。
    const lastT = events[events.length - 1]?.tMs ?? 0;
    const hasPendingCard = events.some((e) => e.name === "question.request" || e.name === "confirm.request");
    const pendingUnresolved =
      hasPendingCard &&
      !events.some((e) => e.name === "turn.done" || e.name === "question.replied" || e.name === "confirm.resolved");
    if (pendingUnresolved && performance.now() - start - lastT > 8_000) {
      console.log("（出現待答卡且無自動回答，停止錄製——用 --resume <sid> --answer \"…\" 續）");
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  stopRecording = true;
  await recorded;
  const error = recordError;
  if (error) console.error(`⚠ SSE 錄製異常: ${error}`);

  // ── 還原 transcript（用生產 reducer）
  let state: AgentChatState = EMPTY_AGENT_CHAT_STATE;
  if (opts.message) state = appendUserTurn(state, opts.message);
  for (const e of events) {
    if (e.name.startsWith("__")) continue;
    const parsed = parseAgentSseEvent(e.name, JSON.stringify(e.data));
    if (parsed) state = agentChatReducer(state, parsed);
  }

  // ── 報告
  renderTimeline(events);
  renderUxMetrics(events);
  renderTranscript(state);
  renderWorkflow(events);
  const assistantText = state.items
    .filter((i): i is Extract<AgentTranscriptItem, { kind: "assistant" }> => i.kind === "assistant")
    .map((i) => i.text)
    .join("\n");
  renderLanguage(opts.message ?? "(無新消息)", assistantText);

  if (opts.jsonOut) {
    writeFileSync(opts.jsonOut, JSON.stringify({ sessionId, events }, null, 2));
    console.log(`\n原始事件流已存: ${opts.jsonOut}`);
  }

  // ── 清理（續用會話隱含保留：多輪上下文在後端；只有新建的單輪測試會話才默認清理）
  if (!opts.keepSession && opts.resumeSessionId === undefined) {
    const del = await gw(base, opts.key, `/agent/v1/sessions/${sessionId}`, { method: "DELETE" });
    console.log(`會話已清理（HTTP ${del.status}）`);
  } else {
    console.log(`\n會話保留: ${sessionId}（續聊: npx tsx tools/agent-debug.ts --resume ${sessionId} "下一句"）`);
  }
}

main().catch((e: Error) => {
  console.error("agent-debug 失敗:", e.message);
  process.exit(1);
});
