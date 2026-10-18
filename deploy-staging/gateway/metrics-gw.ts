// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave2）：Phase 0 观测——per-turn 分段延迟打点
// （TURN_METRICS_RING/beginTurnMetrics/noteTurnPromptDispatch/noteTurnDeferred/markTurnFirst/
// noteTurnUsage/finishTurnMetrics）、event-loop lag 取样（含模组级 startEventLoopLagSampler()
// 副作用呼叫，原样搬）、percentile/stageStats/turnMetricsSnapshot（原 index.ts 4378–4592 行）。
import type { SessionState, TurnMetricsEnd, TurnMetricsSnapshot } from "./types-gateway.ts"
import { redactForLog, type LogSafeText } from "./analytics-meta.ts"

// ── journal 出口（2026-10-02）：型别层签核 ＋ 遮罩 ──────────────────────
// 本档所有落 console/journal 的行都只走这两个函数（禁止直接 console.*）。参数型别是
// `LogSafeText`（= never，见 analytics-meta.ts）——呼叫端必须传 redactForLog() 的产物
// （或明示 `as LogSafeText` 自负），否则编译不过。这把「secret 进 journalctl」从
// 靠自觉变成靠签核。设计取自 Claude Code analytics brand type（未复制其程式码）。
function journalLine(line: LogSafeText): void {
  console.log(line)
}
function journalError(line: LogSafeText): void {
  console.error(line)
}

// ── Phase 0 观测（2026-09-18）：per-turn 分段延迟打点 ────────────────────
// 纯观测、行为中性：不新增/改写任何 SSE 帧（前端 reducer 契约零改动），不动
// prompt 内容/重试逻辑/逾时常数。目的＝把「一个 turn 的 109 秒花在哪」由推断
// 变成量测：
//   ① journal 单行 `[gateway] turn.metrics {json}`（journalctl | grep 可用）
//   ② 记忆体 ring（最近 200 笔）→ GET /agent/v1/metrics 出各阶段 p50/p95/p99
//   ③ event-loop lag 每秒取样 → 检验「记忆体压力造成 event loop 抖动」假设
// 生命周期安全：每 session 至多一份在途档（挂在 SessionState 的 volatile 栏位）；
// turn.done 收档、用户中止由 handleAbortSession 收档、被下一轮取代由
// beginTurnMetrics 以 superseded 补收——不挂任何计时器、不持有跨 turn 引用，
// 故无计时器泄漏；全部打点函数对「档不存在」直接静默返回，永不抛错。

export const TURN_METRICS_RING = 200
export const turnMetricsRing: TurnMetricsSnapshot[] = []

/**
 * 计量行 → 会话的匹配。
 *
 * 新行存完整 session id（精确匹配）。旧行曾存前 8 字符；为兼容进程内迁移/热更新
 * 残留的旧行，短于等于 8 字符的记录按前缀匹配。前缀匹配只对「看起来像旧截断值」
 * 的行生效，不会让两个正常完整 id 互相命中。
 */
export function metricsSessionMatches(recorded: unknown, sessionId: string): boolean {
  if (typeof recorded !== "string" || !recorded || !sessionId) return false
  if (recorded === sessionId) return true
  return recorded.length <= 8 && sessionId.startsWith(recorded)
}

/** 取该会话最近一条带 context_tokens 的计量行（倒序扫描）。 */
export function lastTurnContextTokens(sessionId: string): number | undefined {
  for (let i = turnMetricsRing.length - 1; i >= 0; i--) {
    const row = turnMetricsRing[i]
    if (metricsSessionMatches(row.session, sessionId) && typeof row.context_tokens === "number") {
      return row.context_tokens
    }
  }
  return undefined
}

/** 本轮计时档起点；t_accept = handleSendMessage 进入时刻（呼叫方带入）。
 *  既有在途档（上一轮未收尾）先以 superseded 收档，保证每 session 至多一份。 */
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
    journalError(redactForLog(`[gateway] turn.metrics begin failed: session=${state.sessionId} ${e}`))
  }
}

/** prompt_async 投递成功打点（呼叫方只在 res.ok 后呼叫）。首次=attempt 1，
 *  同一 turn 的 failover/jitter 重投每次递增 attempt 并刷新实际使用的模型。 */
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

/** compaction 闸挡住本轮 prompt 的时刻（prompt_deferred_ms 起算点）。 */
export function noteTurnDeferred(state: SessionState): void {
  const m = state.turnMetrics
  if (m && m.deferredAt === null) m.deferredAt = Date.now()
}

/** 本轮首个里程碑（reasoning/text/tool/plan）——只记第一次，之后静默。 */
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
    // turn.plan（两段式首字第一段）：与 d_first_text_ms 分开记——**禁止拿计画
    // 冒充正文**，两栏各自独立、互不写入。
    m.t_first_plan = now
  }
}

/** context tokens / cache 读写：取自 message.updated 事件自带的 info.tokens（零额外
 *  往返、零延迟）。opencode 未带此栏位时一律保持 null——不为拿它加额外请求。 */
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

/** 收档：算衍生阶段差、入 ring、印 journal 单行。end=superseded（被下一轮取代、
 *  从未收尾）时 t_done 留 null——不谎报结束时间。 */
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
      // 存完整 session id：旧版只存前 8 字符，token 提醒与压缩判定的
      // `row.session === state.sessionId` 永远不成立，导致提醒/压缩全失效。
      session: m.sessionId,
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
    // snap 的 provider/model 等栏位虽为识别字，仍可能夹带上游回传的自由文字；一律先遮罩再落盘。
    journalLine(redactForLog(`[gateway] turn.metrics ${JSON.stringify(snap)}`))
  } catch (e) {
    journalError(redactForLog(`[gateway] turn.metrics finish failed: session=${state.sessionId} ${e}`))
  }
}

// ── event-loop lag 取样（Phase 0 ③）────────────────────────────────────
// 每秒量一次 timer drift（performance.now() 对比预期到点时间）：drift 大 =
// event loop 被同步工作/记忆体压力卡住。performance.now() 是 Bun/Node 共有
// 的单调毫秒时钟。取样只进 ring，不影响任何请求路径。
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
      // 取样失败不影响 gateway：本次跳过。
    }
  }, EVENT_LOOP_LAG_INTERVAL_MS)
}

startEventLoopLagSampler()

// ── 聚合视图（GET /agent/v1/metrics）────────────────────────────────────
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[idx].toFixed(2))
}

export function stageStats(values: number[]): { n: number; p50: number | null; p95: number | null; p99: number | null } {
  const sorted = values.slice().sort((a, b) => a - b)
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) }
}

/** 每阶段统计：d_* = 自 t_accept 起算的累积延迟；prompt_deferred_ms = compaction
 *  闸等待（0 = 本轮没被挡）。n = 有观测到该里程碑的样本数。 */
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
