// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave2）：Phase 0 觀測——per-turn 分段延遲打點
// （TURN_METRICS_RING/beginTurnMetrics/noteTurnPromptDispatch/noteTurnDeferred/markTurnFirst/
// noteTurnUsage/finishTurnMetrics）、event-loop lag 取樣（含模組級 startEventLoopLagSampler()
// 副作用呼叫，原樣搬）、percentile/stageStats/turnMetricsSnapshot（原 index.ts 4378–4592 行）。
import type { SessionState, TurnMetricsEnd, TurnMetricsSnapshot } from "./types-gateway.ts"
// ── Phase 0 觀測（2026-09-18）：per-turn 分段延遲打點 ────────────────────
// 純觀測、行為中性：不新增/改寫任何 SSE 幀（前端 reducer 契約零改動），不動
// prompt 內容/重試邏輯/逾時常數。目的＝把「一個 turn 的 109 秒花在哪」由推斷
// 變成量測：
//   ① journal 單行 `[gateway] turn.metrics {json}`（journalctl | grep 可用）
//   ② 記憶體 ring（最近 200 筆）→ GET /agent/v1/metrics 出各階段 p50/p95/p99
//   ③ event-loop lag 每秒取樣 → 檢驗「記憶體壓力造成 event loop 抖動」假設
// 生命週期安全：每 session 至多一份在途檔（掛在 SessionState 的 volatile 欄位）；
// turn.done 收檔、用戶中止由 handleAbortSession 收檔、被下一輪取代由
// beginTurnMetrics 以 superseded 補收——不掛任何計時器、不持有跨 turn 引用，
// 故無計時器洩漏；全部打點函數對「檔不存在」直接靜默返回，永不拋錯。

export const TURN_METRICS_RING = 200
export const turnMetricsRing: TurnMetricsSnapshot[] = []

/** 本輪計時檔起點；t_accept = handleSendMessage 進入時刻（呼叫方帶入）。
 *  既有在途檔（上一輪未收尾）先以 superseded 收檔，保證每 session 至多一份。 */
export function beginTurnMetrics(state: SessionState, tAccept: number): void {
  try {
    if (state.turnMetrics) finishTurnMetrics(state, "superseded")
    state.turnMetrics = {
      sessionId: state.sessionId,
      gen: state.turnGen ?? 0,
      attempt: 1,
      t_accept: tAccept,
      t_prompt_sent: null,
      t_last_prompt_sent: null,
      t_first_reasoning: null,
      t_first_text: null,
      t_first_tool: null,
      t_first_plan: null,
      deferredAt: null,
      providerID: null,
      modelID: null,
      contextTokens: null,
      cacheRead: null,
      cacheWrite: null,
    }
  } catch (e) {
    console.error(`[gateway] turn.metrics begin failed: session=${state.sessionId}`, e)
  }
}

/** prompt_async 投遞成功打點（呼叫方只在 res.ok 後呼叫）。首次=attempt 1，
 *  同一 turn 的 failover/jitter 重投每次遞增 attempt 並刷新實際使用的模型。 */
export function noteTurnPromptDispatch(state: SessionState, providerID?: string | null, modelID?: string | null): void {
  const m = state.turnMetrics
  if (!m) return
  const now = Date.now()
  if (m.t_prompt_sent === null) m.t_prompt_sent = now
  else m.attempt += 1
  m.t_last_prompt_sent = now
  if (providerID) m.providerID = providerID
  if (modelID) m.modelID = modelID
}

/** compaction 閘擋住本輪 prompt 的時刻（prompt_deferred_ms 起算點）。 */
export function noteTurnDeferred(state: SessionState): void {
  const m = state.turnMetrics
  if (m && m.deferredAt === null) m.deferredAt = Date.now()
}

/** 本輪首個里程碑（reasoning/text/tool/plan）——只記第一次，之後靜默。 */
export function markTurnFirst(state: SessionState, kind: "reasoning" | "text" | "tool" | "plan"): void {
  const m = state.turnMetrics
  if (!m) return
  const now = Date.now()
  if (kind === "reasoning") {
    if (m.t_first_reasoning === null) m.t_first_reasoning = now
  } else if (kind === "text") {
    if (m.t_first_text === null) m.t_first_text = now
  } else if (kind === "tool") {
    if (m.t_first_tool === null) m.t_first_tool = now
  } else if (m.t_first_plan === null) {
    // turn.plan（兩段式首字第一段）：與 d_first_text_ms 分開記——**禁止拿計畫
    // 冒充正文**，兩欄各自獨立、互不寫入。
    m.t_first_plan = now
  }
}

/** context tokens / cache 讀寫：取自 message.updated 事件自帶的 info.tokens（零額外
 *  往返、零延遲）。opencode 未帶此欄位時一律保持 null——不為拿它加額外請求。 */
export function noteTurnUsage(state: SessionState, info: unknown): void {
  const m = state.turnMetrics
  if (!m || !info || typeof info !== "object") return
  const o = info as { role?: unknown; tokens?: unknown }
  if (o.role !== "assistant") return
  const tk = o.tokens
  if (!tk || typeof tk !== "object") return
  const t = tk as { input?: unknown; cache?: unknown }
  if (typeof t.input === "number" && Number.isFinite(t.input)) m.contextTokens = t.input
  if (t.cache && typeof t.cache === "object") {
    const c = t.cache as { read?: unknown; write?: unknown }
    if (typeof c.read === "number" && Number.isFinite(c.read)) m.cacheRead = c.read
    if (typeof c.write === "number" && Number.isFinite(c.write)) m.cacheWrite = c.write
  }
}

/** 收檔：算衍生階段差、入 ring、印 journal 單行。end=superseded（被下一輪取代、
 *  從未收尾）時 t_done 留 null——不謊報結束時間。 */
export function finishTurnMetrics(state: SessionState, end: TurnMetricsEnd): void {
  const m = state.turnMetrics
  if (!m) return
  state.turnMetrics = null
  try {
    const now = Date.now()
    const tDone = end === "superseded" ? null : now
    const promptDeferredMs =
      m.deferredAt === null ? 0 : Math.max(0, (m.t_last_prompt_sent ?? now) - m.deferredAt)
    const snap: TurnMetricsSnapshot = {
      session: m.sessionId.length > 8 ? m.sessionId.slice(0, 8) : m.sessionId,
      gen: m.gen,
      attempt: m.attempt,
      provider: m.providerID,
      model: m.modelID,
      t_accept: m.t_accept,
      t_prompt_sent: m.t_prompt_sent,
      t_last_prompt_sent: m.t_last_prompt_sent,
      t_first_reasoning: m.t_first_reasoning,
      t_first_text: m.t_first_text,
      t_first_tool: m.t_first_tool,
      t_first_plan: m.t_first_plan,
      t_done: tDone,
      prompt_deferred_ms: promptDeferredMs,
      context_tokens: m.contextTokens,
      cache_read: m.cacheRead,
      cache_write: m.cacheWrite,
      end,
      d_prompt_ms: m.t_prompt_sent === null ? null : m.t_prompt_sent - m.t_accept,
      d_first_reasoning_ms: m.t_first_reasoning === null ? null : m.t_first_reasoning - m.t_accept,
      d_first_text_ms: m.t_first_text === null ? null : m.t_first_text - m.t_accept,
      d_first_tool_ms: m.t_first_tool === null ? null : m.t_first_tool - m.t_accept,
      d_first_plan_ms: m.t_first_plan === null ? null : m.t_first_plan - m.t_accept,
      d_total_ms: tDone === null ? null : tDone - m.t_accept,
    }
    turnMetricsRing.push(snap)
    if (turnMetricsRing.length > TURN_METRICS_RING) {
      turnMetricsRing.splice(0, turnMetricsRing.length - TURN_METRICS_RING)
    }
    console.log(`[gateway] turn.metrics ${JSON.stringify(snap)}`)
  } catch (e) {
    console.error(`[gateway] turn.metrics finish failed: session=${state.sessionId}`, e)
  }
}

// ── event-loop lag 取樣（Phase 0 ③）────────────────────────────────────
// 每秒量一次 timer drift（performance.now() 對比預期到點時間）：drift 大 =
// event loop 被同步工作/記憶體壓力卡住。performance.now() 是 Bun/Node 共有
// 的單調毫秒時鐘。取樣只進 ring，不影響任何請求路徑。
export const EVENT_LOOP_LAG_INTERVAL_MS = 1000
export const EVENT_LOOP_LAG_RING = 300
export const eventLoopLagSamples: number[] = []

export function startEventLoopLagSampler(): void {
  let expected = performance.now() + EVENT_LOOP_LAG_INTERVAL_MS
  setInterval(() => {
    try {
      const at = performance.now()
      eventLoopLagSamples.push(Math.max(0, at - expected))
      if (eventLoopLagSamples.length > EVENT_LOOP_LAG_RING) {
        eventLoopLagSamples.splice(0, eventLoopLagSamples.length - EVENT_LOOP_LAG_RING)
      }
      expected = at + EVENT_LOOP_LAG_INTERVAL_MS
    } catch {
      // 取樣失敗不影響 gateway：本次跳過。
    }
  }, EVENT_LOOP_LAG_INTERVAL_MS)
}

startEventLoopLagSampler()

// ── 聚合視圖（GET /agent/v1/metrics）────────────────────────────────────
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[idx].toFixed(2))
}

export function stageStats(values: number[]): { n: number; p50: number | null; p95: number | null; p99: number | null } {
  const sorted = values.slice().sort((a, b) => a - b)
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) }
}

/** 每階段統計：d_* = 自 t_accept 起算的累積延遲；prompt_deferred_ms = compaction
 *  閘等待（0 = 本輪沒被擋）。n = 有觀測到該里程碑的樣本數。 */
export function turnMetricsSnapshot(): Record<string, unknown> {
  const stages: Record<string, { n: number; p50: number | null; p95: number | null; p99: number | null }> = {}
  const fields = [
    "d_prompt_ms",
    "d_first_reasoning_ms",
    "d_first_text_ms",
    "d_first_tool_ms",
    "d_first_plan_ms",
    "d_total_ms",
    "prompt_deferred_ms",
  ] as const
  for (const f of fields) {
    stages[f] = stageStats(
      turnMetricsRing.map((r) => r[f]).filter((v): v is number => typeof v === "number"),
    )
  }
  const lag = eventLoopLagSamples.slice().sort((a, b) => a - b)
  return {
    turns: { ring_size: TURN_METRICS_RING, sampled: turnMetricsRing.length, stages },
    event_loop_lag_ms: {
      sample_interval_ms: EVENT_LOOP_LAG_INTERVAL_MS,
      samples: lag.length,
      window_s: Math.round((lag.length * EVENT_LOOP_LAG_INTERVAL_MS) / 1000),
      p50: percentile(lag, 50),
      p95: percentile(lag, 95),
      max: lag.length > 0 ? Number(lag[lag.length - 1].toFixed(2)) : null,
    },
    last_turn: turnMetricsRing.length > 0 ? turnMetricsRing[turnMetricsRing.length - 1] : null,
  }
}
