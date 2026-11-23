import { opencodeFetch } from "./opencode-client.ts"
import { UPSTREAM_HARD_TOKEN_LIMIT, COMPACT_BLOCKED_BREAKER_COUNT, COMPACT_BLOCKED_BREAKER_MS, COMPACT_INFLIGHT_MAX_MS, SESSION_COMPACT_RETRY_TIMEOUT_MS } from "./constants-gateway.ts"
import { emitToSession } from "./sse-core.ts"
import { markDirty } from "./sessions-core.ts"
import { turnMetricsRing, metricsSessionMatches } from "./metrics-gw.ts"
import { microcompactPlan, compactionDecision, buildPreCompactHookInput, buildPostCompactHookInput, applyPreCompactResult, applyPostCompactResult } from "./compaction-policy.ts"
import { runHooksWithBudget } from "./hooks-http.ts"
import { markCompactionBoundary, modelWindowTokens } from "./context-injection.ts"
import type { SessionState } from "./types-gateway.ts"
import { unfreezeSystemStaticSections, setHookCompactionContinuation, hookSessionStarted, hookSessionSource, compactTurnsSince } from "./messages-gw-types.ts"

// ---- 滚动摘要压缩（rolling summary via opencode native summarize）----
// 讯息历史的 owner 是 opencode：压缩直接用它的 AI compaction 端点
// POST /session/:id/summarize（已实测：生成 summary 讯息 + compaction part，
// 模型后续上下文以摘要为准；旧讯息仍留在存储供前端展示与 GET history 端点读取）。
// 不在 gateway 另存一份 messages —— 那是第二份会漂移的历史副本。
// 防抖两层：in-memory in-flight Set（一次压缩完成前不重复触发）+ 持久化水位
// compact.lastCount（自上次压缩新增不足半个阈值不触发，重启后水位仍在）。
export const SESSION_COMPACT_THRESHOLD = Number.parseInt(process.env.SESSION_COMPACT_THRESHOLD || "40", 10) || 40
export const SESSION_COMPACT_MIN_NEW = Math.max(4, Math.floor(SESSION_COMPACT_THRESHOLD / 2))
// 2026-10-18 止血：单次 summarize 从 180s 缩到 60s（env 可覆写）。180s 是生产
// 「AbortError→水位不推进→下轮再压→再 180s」死循环的单次成本；压缩已在 idle
// 异步路径，缩短超时不会拖住回合。紧急压缩失败再给一次 30s 有界重试。
export const SESSION_COMPACT_TIMEOUT_MS =
  Number.parseInt(process.env.SESSION_COMPACT_TIMEOUT_MS || "60000", 10) || 60_000
// 压缩闸的有界等待上限（2026-09-18）：压缩在途时 prompt 最多被挡这么久，超时即
// 径行投递（见 handleSendMessage 的 compactionJob 分支）。env 可覆写。
export const COMPACTION_MAX_DEFER_MS =
  Number.parseInt(process.env.COMPACTION_MAX_DEFER_MS || "4000", 10) || 4_000
// R2-A 根因修复：in-flight 从 Set 升级为可等待的 Map——handleSendMessage
// 能感知「压缩在途」并把 prompt 投递推迟到压缩落地之后，消除
// 「summarize 写盘中途收到新 turn → turn 静默死亡」的时序竞态。
export const compactionJobs = new Map<string, Promise<void>>()
// P1-7（2026-10-18）：同步占位必须在第一个 await 之前完成。只用 compactionJobs
// 不够——两个并发 idle 都能在 set() 之前通过 has() 检查而双跑 summarize。
const compactionInFlight = new Set<string>()

// 2026-10-18 超大会话止血：metrics 的 context_tokens 缺失时（生产日志里
// used_tokens=2441457(estimate) 即此形态），仍要让「投递前硬闸」拿得到用量。
// WeakMap 随 SessionState 生命周期回收，不额外泄漏。
const sessionUsedTokens = new WeakMap<SessionState, number>()

/** blocked/失败熔断状态：连续失败 N 次或持续 T 毫秒未成功 → 紧急压缩 + 安全降级。 */
interface CompactBreakerState {
  streak: number
  since: number
}
const compactBreakerBySession = new WeakMap<SessionState, CompactBreakerState>()

function compactBreaker(state: SessionState): CompactBreakerState {
  let cur = compactBreakerBySession.get(state)
  if (!cur) {
    cur = { streak: 0, since: 0 }
    compactBreakerBySession.set(state, cur)
  }
  return cur
}

export function rememberSessionUsedTokens(state: SessionState, tokens: number | undefined): void {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return
  sessionUsedTokens.set(state, Math.round(tokens))
}

/**
 * 最近一条带 context_tokens 的计量行＋时间。
 * 压缩成功后旧行已过期（它统计的是压缩前的历史），必须能分辨。
 */
function lastMetricContext(state: SessionState): { tokens: number; at: number } | undefined {
  for (let i = turnMetricsRing.length - 1; i >= 0; i--) {
    const row = turnMetricsRing[i]
    if (!metricsSessionMatches(row.session, state.sessionId)) continue
    if (typeof row.context_tokens !== "number") continue
    return { tokens: row.context_tokens, at: row.t_done ?? row.t_accept }
  }
  return undefined
}

/** 本会话已知用量：metrics 须晚于最后一次压缩；否则用压缩后的估算值／缓存。 */
export function knownSessionUsedTokens(state: SessionState): number | undefined {
  const metric = lastMetricContext(state)
  const compactedAt = state.compact?.at ?? 0
  const cached = sessionUsedTokens.get(state)
  if (metric && metric.at >= compactedAt) return metric.tokens
  if (cached !== undefined) return cached
  return metric?.tokens
}

/**
 * 2026-10-18 关键口径修正：opencode 压缩后旧讯息仍留在存储（供历史展示），
 * 但它们已不在模型上下文中。旧码用 estimateTokensFromMessages(msgs) 估算会把
 * 压缩前的整段历史重复计入 → 永远 blocked / 每轮重压（生产 2.4M 估值病灶）。
 * 只估「最近一条 summary/compaction 之后」的有效上下文。
 */
export function estimateActiveContextTokens(msgs: unknown[]): number | undefined {
  if (!Array.isArray(msgs) || msgs.length === 0) return undefined
  let start = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const info = (msgs[i] as { info?: { summary?: boolean; mode?: string; agent?: string } } | null)?.info
    if (info?.summary === true || info?.mode === "compaction" || info?.agent === "compaction") {
      start = i
      break
    }
  }
  return estimateTokensFromMessages(msgs.slice(start))
}

/** 工具结果规模：供 microcompact 触发判据（不逐条清理，Eimu 用整段摘要压缩）。 */
function summarizeToolUsage(msgs: Array<{ parts?: unknown[] }>): {
  toolUseCount: number
  estimatedTokens: number
} {
  let toolUseCount = 0
  let chars = 0
  for (const msg of msgs) {
    const parts = msg?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const p = part as { type?: unknown; state?: { output?: unknown } } | null | undefined
      if (p?.type !== "tool") continue
      toolUseCount += 1
      const out = p.state?.output
      if (typeof out === "string") chars += out.length
    }
  }
  // 与 compaction-policy 口径一致：4 字符 ≈ 1 token。
  return { toolUseCount, estimatedTokens: Math.ceil(chars / 4) }
}

/** 压缩后新增的 summary/compaction 讯息正文（PostCompact hook 输入）。 */

/** P3-A4：摘要正文含探针/INTERNAL/账本倾倒则拒推进水位（语义门；对照 0918 只认 error）。 */
function isCompactSummaryPoisoned(summary: string): boolean {
  if (!summary) return false
  const s = summary.toLowerCase()
  if (summary.includes("【生成结果耐久收件箱】")) return true
  if (s.includes("verify_no_row")) return true
  if (summary.includes("账本：")) return true
  return false
}

function extractCompactedSummary(
  msgs: Array<{ info?: { summary?: boolean; mode?: string }; parts?: Array<{ type?: string; text?: string }> }>,
  fromIndex: number,
): string {
  for (let i = msgs.length - 1; i >= fromIndex; i--) {
    const m = msgs[i]
    if (m?.info?.summary !== true && m?.info?.mode !== "compaction") continue
    const text = (m.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
    if (text.trim()) return text
  }
  return ""
}

export async function maybeCompactSession(state: SessionState): Promise<void> {
  // 并发闸：占位发生在任何 await 之前（本函数同步执行到 add 为止），finally 清除。
  if (compactionInFlight.has(state.sessionId) || compactionJobs.has(state.sessionId)) return
  compactionInFlight.add(state.sessionId)
  try {
    await maybeCompactSessionUnlocked(state)
  } finally {
    compactionInFlight.delete(state.sessionId)
  }
}

/** 2026-10-18 止血：turn 收尾 / 生成任务终态收口点调用。
 *  仅当 pendingCompact 已登记时再进 maybeCompactSession，避免每个 task 终态都扫一遍。 */
export function flushPendingCompact(state: SessionState): void {
  if (!state.pendingCompact) return
  void maybeCompactSession(state)
}

async function maybeCompactSessionUnlocked(state: SessionState): Promise<void> {
  if (compactionJobs.has(state.sessionId)) return
  try {
    // 2026-10-18：超大会话的 GET /message（整段历史序列化）可能远超 10s，旧码一次
    // AbortError 就退出 → 压缩永不发生。保留一次更长窗口的重试（只在大会话上多花）。
    let res: Awaited<ReturnType<typeof opencodeFetch>> | null = null
    let lastFetchError = ""
    for (const timeoutMs of [10_000, 45_000]) {
      try {
        const r = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, { timeoutMs })
        if (r.ok) {
          res = r
          break
        }
        lastFetchError = `status ${r.status}`
      } catch (e) {
        lastFetchError = `fetch error: ${e}`
      }
    }
    if (!res) {
      console.warn(`[gateway] session compact skipped (message fetch failed: ${lastFetchError}) — session=${state.sessionId}`)
      return
    }
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; model?: { providerID?: string; modelID?: string } }
    }>
    if (!Array.isArray(msgs)) return
    const count = msgs.length
    const lastCount = state.compact?.lastCount ?? 0
    // ── CC 2.1.302 压缩触发判定（2026-10-18 接线）────────────────────────────
    // Eimu 采用整段摘要压缩（opencode /summarize），无法像 CC 一样逐条清 tool_result；
    // 因此 microcompactPlan 在这里只作为「提前触发判据」：它判定工具结果已达可清理量
    // （≥20000 token / ≥20 次 tool_use / idle ≥3900s）时，让整段压缩提前执行，
    // 不伪造逐条清理，也不改写摘要内容。
    const toolUsage = summarizeToolUsage(msgs as Array<{ parts?: unknown[] }>)
    const idleSeconds = Math.max(0, (Date.now() - (state.lastActivityAt ?? Date.now())) / 1000)
    const microPlan = microcompactPlan({
      idleSeconds,
      toolUseCount: toolUsage.toolUseCount,
      estimatedTokens: toolUsage.estimatedTokens,
    })
    // compactionDecision 用真实窗口与最近一轮 context_tokens 判 over_limit/warn；
    // 窗口未知（模型不在映射表）时 windowTokens=0 → action none，不猜。
    // 2026-10-18 止血：lastTurnContextTokens 缺失时用「有效上下文」粗估，禁止静默当 0
    // （当 0 会让 token 路径永不触发，超长制作会话涨到百万 token）；压缩成功后
    // 旧 metrics 行过期，改用最近一次压缩之后的估算。
    const metric = lastMetricContext(state)
    const compactedAt = state.compact?.at ?? 0
    const metricUsable = metric !== undefined && metric.at >= compactedAt
    const estimatedUsedTokens = estimateActiveContextTokens(msgs)
    const usedTokens = (metricUsable ? metric.tokens : undefined) ?? estimatedUsedTokens ?? metric?.tokens
    const usedTokensSource = metricUsable ? "metrics" : estimatedUsedTokens !== undefined ? "estimate" : "none"
    const lastModelID = (() => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info as
          | { model?: { providerID?: string; modelID?: string } }
          | undefined
        const modelID = info?.model?.modelID
        if (typeof modelID !== "string" || !modelID) continue
        // 带 provider 前缀一并交给 modelWindowTokens（happycoding/deepseek-…）。
        const providerID = info?.model?.providerID
        if (typeof providerID === "string" && providerID && !modelID.includes("/")) {
          return `${providerID}/${modelID}`
        }
        return modelID
      }
      // 讯息缺 model 时回退本会话最近实际 dispatch 的模型，避免 window=0 永久不压。
      const fallback =
        state.lastDispatchedModel?.modelID ||
        state.stickyModel?.modelID ||
        state.lastPromptBody?.model?.modelID
      if (typeof fallback === "string" && fallback) {
        const providerID =
          state.lastDispatchedModel?.providerID ||
          state.stickyModel?.providerID ||
          state.lastPromptBody?.model?.providerID
        if (typeof providerID === "string" && providerID && !fallback.includes("/")) {
          return `${providerID}/${fallback}`
        }
        return fallback
      }
      return null
    })()
    const windowTokens = modelWindowTokens(lastModelID) ?? 0
    // 2026-10-18：把估算值也记进会话缓存——生产上 metrics 的 context_tokens 常缺失，
    // 投递前硬闸必须仍能拿到「这个会话已经很大了」的事实。
    rememberSessionUsedTokens(state, usedTokens)
    const breaker = compactBreaker(state)
    const decision = compactionDecision({
      windowTokens,
      usedTokens: usedTokens ?? 0,
      // 本会话尚未压缩过时 lastCompactTurns=undefined：不做 thrashing 判定。
      // 已压缩过时用真实用户回合计数；重启后计数缺失同样传 undefined（不猜）。
      lastCompactTurns: state.compact !== undefined ? compactTurnsSince.get(state) : undefined,
      hardLimitTokens: UPSTREAM_HARD_TOKEN_LIMIT,
    })
    const thresholdReached = count >= SESSION_COMPACT_THRESHOLD
    const earlyTrigger =
      !thresholdReached &&
      count > lastCount &&
      (microPlan !== null || decision.action === "compact")
    // pendingCompact 重试：上次因在途 turn 登记的强制压缩，本轮继续走判定。
    const pendingRetry = state.pendingCompact === true
    // 2026-10-18：blocked 持续计时——不是只有「压缩失败」才升级；一直 blocked
    // （含被在途任务 defer）超过上界同样要升级为紧急压缩。
    if (decision.action === "blocked" && breaker.since === 0) breaker.since = Date.now()
    const blockedSinceMs = breaker.since > 0 ? Date.now() - breaker.since : 0
    const breakerOpen =
      breaker.streak >= COMPACT_BLOCKED_BREAKER_COUNT ||
      (breaker.since > 0 && blockedSinceMs >= COMPACT_BLOCKED_BREAKER_MS)
    // 2026-10-18：紧急压缩＝熔断已开（连续失败/持续 blocked）或已超硬上限。
    const emergencyCompact = breakerOpen || decision.hardLimitExceeded
    // 硬上限/紧急压缩是绝对触发条件——即使讯息数不到阈值、microcompact 未命中，
    // 也必须压缩，否则 2.4M token 的会话会一轮轮直送上游。
    if (!thresholdReached && !earlyTrigger && !pendingRetry && !emergencyCompact) return
    // 强制 token 压缩：decision 已要 compact/blocked/warn 或已达到硬上限/紧急态。
    // 制作会话几乎永远有 generation 在途；若仍无限 defer → 上下文涨到百万。
    const forceTokenCompact =
      emergencyCompact ||
      ((decision.action === "compact" || decision.action === "blocked" || decision.action === "warn") &&
        (usedTokens ?? 0) >= decision.compactAt &&
        decision.compactAt > 0)
    // 0831 竞态根治：opencode binary 对摘要讯息硬挡 tool call（"Tool call not allowed
    // while generating summary"）。摘要模型若看到「还有任务待查」就会吐 tool call →
    // 整条摘要作废、session 无声 idle。
    // 2026-10-18 止血改动：
    // - 有在途 LLM turn（turnMetrics）→ 仍必须 defer，并登记 pendingCompact（禁止 silent drop）。
    // - 仅 generation sessionTasks 在途 + forceTokenCompact → 允许压缩。
    //   理由：turn 已 idle 时 generation 是 poller 侧任务，与 summarize 写盘无同一 LLM 竞态；
    //   summarize 假成功仍有既有校验挡水位；无限 defer 的代价是百万 token / OOM。
    // - 非 force 路径（纯讯息数阈值）仍要求无在途 generation，保持原安全闸。
    // - 2026-10-18：在途任务有上界——超过 COMPACT_INFLIGHT_MAX_MS 视为已死（与遗留
    //   durable run 结论一致），不得永久阻塞压缩。
    // 注：state.sessionTasks 在网关重启后为空（hydrate 补空 Map）→ 在途闸自然放行，可接受。
    const inflight = [...state.sessionTasks.values()].filter(
      (t) => t.status === "queued" || t.status === "running",
    )
    const nowMs = Date.now()
    const liveInflight = inflight.filter((t) => {
      const submittedAt = typeof t.submitted_at === "number" ? t.submitted_at : 0
      return submittedAt > 0 && nowMs - submittedAt <= COMPACT_INFLIGHT_MAX_MS
    })
    const staleInflight = inflight.length - liveInflight.length
    if (staleInflight > 0) {
      console.warn(
        `[gateway] compact ignoring ${staleInflight} stale in-flight task(s) older than ${COMPACT_INFLIGHT_MAX_MS}ms (treated dead): session=${state.sessionId}`,
      )
    }
    const hasTurnInFlight = state.turnMetrics !== null && state.turnMetrics !== undefined
    if (hasTurnInFlight) {
      if (forceTokenCompact || pendingRetry) {
        state.pendingCompact = true
        console.log(
          `[gateway] compact deferred (pendingCompact=1): ${state.sessionId} has in-flight turn; used_tokens=${usedTokens ?? "unknown"}(${usedTokensSource}) compactAt=${decision.compactAt}`,
        )
      } else {
        console.log(`[gateway] compact deferred: ${state.sessionId} has an in-flight turn or undelivered prompt`)
      }
      return
    }
    if (liveInflight.length > 0) {
      if (forceTokenCompact || pendingRetry) {
        console.log(
          `[gateway] compact proceeding despite ${liveInflight.length} generation task(s): session=${state.sessionId} force_token=1 used_tokens=${usedTokens ?? "unknown"}(${usedTokensSource}) compactAt=${decision.compactAt} window=${windowTokens || "unknown"}`,
        )
        // 继续往下走 summarize；不 return。
      } else {
        if (earlyTrigger || thresholdReached) {
          state.pendingCompact = true
          console.log(
            `[gateway] compact deferred (pendingCompact=1): ${state.sessionId} has ${liveInflight.length} in-flight task(s); will retry on task terminal / next idle`,
          )
        } else {
          console.log(`[gateway] compact deferred: ${state.sessionId} has ${liveInflight.length} in-flight task(s)`)
        }
        return
      }
    }
    // 已通过在途闸：清除 pending 标记（无论本次最终 summarize 成败，避免卡死旗标；
    // 失败时水位不推进，下轮 threshold/force 仍会再触发）。
    if (state.pendingCompact) state.pendingCompact = false
    // 正常阈值路径仍要求「自上次压缩新增 ≥ 半个阈值」；microcompact/decision 的
    // early trigger 只要求确有待压缩的新讯息（count > lastCount，已在上面判定）。
    // forceTokenCompact / pendingRetry 已证明用量或先前判定需要压缩，不得再被 MIN_NEW 挡掉。
    if (!forceTokenCompact && !pendingRetry && thresholdReached && count - lastCount < SESSION_COMPACT_MIN_NEW) return
    if (microPlan) {
      // clearAtLeastTokens 只作判据：整段摘要不会逐条清理这些 tool result。
      console.log(
        `[gateway] microcompact plan (trigger only; Eimu uses whole-summary compaction): session=${state.sessionId} trigger=${microPlan.trigger} tool_uses=${toolUsage.toolUseCount} clearable=${microPlan.clearToolUses} estimated_saved=${microPlan.estimatedTokensSaved} clear_at_least=${microPlan.clearAtLeastTokens}${earlyTrigger ? " early_trigger=1" : ""}`,
      )
    }
    if (decision.action !== "none" || forceTokenCompact) {
      console.log(
        `[gateway] compact decision: session=${state.sessionId} action=${decision.action} used_tokens=${usedTokens ?? "unknown"}(${usedTokensSource}) window=${windowTokens || "unknown"} compactAt=${decision.compactAt} pct_left=${decision.pctLeft}${earlyTrigger ? " early_trigger=1" : ""}${forceTokenCompact ? " force_token=1" : ""}${decision.hardLimitExceeded ? ` hard_limit=1(hardLimit=${decision.hardLimit})` : ""}${emergencyCompact ? " emergency=1" : ""}`,
      )
    }
    // summarize 需要 providerID+modelID：取最近一条带 model 资讯的讯息（与该会话实际模型一致）。
    let providerID: string | undefined
    let modelID: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]?.info?.model
      if (m?.providerID && m?.modelID) {
        providerID = m.providerID
        modelID = m.modelID
        break
      }
    }
    if (!providerID || !modelID) {
      console.warn(`[gateway] compact skipped: no model info in session ${state.sessionId}`)
      return
    }
    // CC 2.1.302 PreCompact：压缩前唯一闸门。blocked → 跳过本次压缩，并把原因落日志
    // 与 SSE 可见文案（不得静默）。失败/超时 fail-open（runHooksWithBudget 不 throw）。
    {
      const pre = await runHooksWithBudget(
        "PreCompact",
        { ...buildPreCompactHookInput({ trigger: "auto", sessionId: state.sessionId, cwd: process.cwd() }) },
        // 不传 timeoutMs：hooks-http 对压缩事件默认 5s（HOOKS_HTTP_COMPACTION_TIMEOUT_MS），
        // 避免 PreCompact 拖长与压缩任务双跑。
      )
      if (pre.errors.length > 0) {
        console.warn(`[gateway] hooks PreCompact errors session=${state.sessionId}: ${pre.errors.join(" | ")}`)
      }
      const applied = applyPreCompactResult({
        blocked: pre.blocked,
        reason: pre.reason,
        additionalContext: pre.additionalContext,
        results: pre.results,
      })
      if (applied.blocked) {
        const blockedReason = applied.blockedReason ?? "PreCompact hook blocked compaction"
        console.warn(
          `[gateway] compact blocked by PreCompact hook: session=${state.sessionId} reason=${blockedReason}`,
        )
        // 用户可见：压缩被跳过是会话行为的变化，不能只留在服务器日志。
        try {
          emitToSession(state, "turn.status", {
            text: `本次上下文压缩已被 hook 跳过：${blockedReason.slice(0, 500)}`,
          })
        } catch {
          /* SSE 不可达不改变「压缩已跳过」的事实 */
        }
        return
      }
      if (applied.newCustomInstructions) {
        // opencode /summarize 不接受自定义摘要指令——不伪造「已应用」。
        console.log(
          `[gateway] PreCompact hook returned extra instructions; ignored because opencode summarize takes no custom instructions: session=${state.sessionId}`,
        )
      }
    }
    // 2026-10-18 熔断记账：失败不是「静默 return」——连续失败/持续失败要升级为
    // 紧急压缩，超过上界则安全降级（重置压缩水位），避免永久 blocked。
    const recordCompactFailure = (reason: string): void => {
      breaker.streak += 1
      if (breaker.since === 0) breaker.since = Date.now()
      const elapsed = Date.now() - breaker.since
      console.warn(
        `[gateway] compact failure streak=${breaker.streak}/${COMPACT_BLOCKED_BREAKER_COUNT} elapsed=${elapsed}ms reason=${reason} — session=${state.sessionId}`,
      )
      if (breaker.streak >= COMPACT_BLOCKED_BREAKER_COUNT || elapsed >= COMPACT_BLOCKED_BREAKER_MS) {
        // 安全降级：重置水位（下一轮按现有阈值/硬上限重新触发有界压缩）并清 pending，
        // 不允许「blocked → 永远不压」。消息本身不动。
        state.compact = undefined
        state.pendingCompact = false
        breaker.streak = 0
        breaker.since = 0
        markDirty(state)
        console.warn(
          `[gateway] compact degraded: breaker open, watermark reset, next turn retries bounded compaction — session=${state.sessionId}`,
        )
      }
    }
    const recordCompactSuccess = (): void => {
      breaker.streak = 0
      breaker.since = 0
    }
    compactionJobs.set(
      state.sessionId,
      (async () => {
        // 有界重试：仅紧急压缩多给一次短窗口；普通压缩仍单次，避免拖长 idle 占位。
        let r: Awaited<ReturnType<typeof opencodeFetch>> | null = null
        let lastError = ""
        const attempts = emergencyCompact ? 2 : 1
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            r = await opencodeFetch(`/session/${state.opencodeSessionId}/summarize`, {
              method: "POST",
              body: JSON.stringify({ providerID, modelID }),
              timeoutMs: attempt === 0 ? SESSION_COMPACT_TIMEOUT_MS : SESSION_COMPACT_RETRY_TIMEOUT_MS,
            })
            if (r.ok) break
            lastError = `status ${r.status}`
          } catch (e) {
            lastError = `fetch error: ${e}`
            r = null
          }
        }
        if (!r || !r.ok) {
          console.warn(`[gateway] session compact failed: ${state.sessionId} ${lastError || "no response"}`)
          recordCompactFailure(lastError || "no response")
          return
        }
        // 0831 假成功诚实化：/summarize 回 HTTP 200 不等于摘要成功。opencode binary 对
        // 摘要讯息硬挡 tool call，摘要模型若吐 image_get_result → 整条摘要带 error、
        // session 无声 idle，但 HTTP 仍 200。旧码据 200 就推进水位 = 假成功。
        // 故 200 后再取一次讯息列表，若 summary/compaction 讯息自带 error 即判失败、不推进水位。
        let verifyMsgs: Array<{
          info?: { summary?: boolean; mode?: string; error?: unknown }
          parts?: Array<{ type?: string; text?: string }>
        }>
        try {
          // 2026-10-18：验证同样要能扛超大会话（生产 UNVERIFIED AbortError 病灶）。
          let vr: Awaited<ReturnType<typeof opencodeFetch>> | null = null
          let verifyError = ""
          for (const timeoutMs of [10_000, 45_000]) {
            try {
              const x = await opencodeFetch(`/session/${state.opencodeSessionId}/message`, { timeoutMs })
              if (x.ok) {
                vr = x
                break
              }
              verifyError = `status ${x.status}`
            } catch (e) {
              verifyError = `fetch error: ${e}`
            }
          }
          if (!vr) {
            console.warn(`[gateway] session compact UNVERIFIED (${verifyError}), 水位不推进: ${state.sessionId}`)
            recordCompactFailure(`verify ${verifyError}`)
            return
          }
          const vj = (await vr.json()) as Array<{
            info?: { summary?: boolean; mode?: string; error?: unknown }
            parts?: Array<{ type?: string; text?: string }>
          }>
          if (!Array.isArray(vj)) {
            console.warn(`[gateway] session compact UNVERIFIED (bad payload), 水位不推进: ${state.sessionId}`)
            recordCompactFailure("verify bad payload")
            return
          }
          verifyMsgs = vj
        } catch (e) {
          console.warn(`[gateway] session compact UNVERIFIED (fetch error: ${e}), 水位不推进: ${state.sessionId}`)
          recordCompactFailure(`verify fetch error: ${e}`)
          return
        }
        // 0918 修复：只验「本次 summarize 新增」的讯息（.slice(count)，count =
        // 呼叫 summarize 前的讯息数，见上方 `const count = msgs.length`）。
        // 原本对整份历史从头 find，会捞出会话历史上任意一条带 error 的旧
        // summary/compaction 讯息——该会话只要失败过一次，那条陈年讯息就永久
        // 毒化验证：水位永不推进 → 每轮重压缩 → 日志永远重印同一条旧错误。
        //（09-18 实锤：7 条 FAILED 的 cf-ray 全同 a3c9f9d55f8b06fc，其中 5 条
        // 时间戳与真实成功的压缩逐秒吻合 = 假失败，毒化会话 f4abcc5d。）
        const badSummary = verifyMsgs
          .slice(count)
          .find((m) => (m?.info?.summary === true || m?.info?.mode === "compaction") && m?.info?.error)
        if (badSummary) {
          console.warn(
            `[gateway] session compact FAILED (summary errored, 水位不推进): ${state.sessionId} err=${JSON.stringify(badSummary.info?.error)}`,
          )
          recordCompactFailure("summary errored")
          return
        }
        // P3-A4：本次新增 summary 若吸入收件箱/verify/账本探针，水位不推进、不 PostCompact。
        const poisonSummary = extractCompactedSummary(verifyMsgs, count)
        if (isCompactSummaryPoisoned(poisonSummary)) {
          console.warn(
            `[gateway] session compact REJECTED (probe/ledger poison in summary, 水位不推进): ${state.sessionId}`,
          )
          recordCompactFailure("probe/ledger poison in summary")
          return
        }
        state.compact = { lastCount: count, at: Date.now() }
        compactTurnsSince.set(state, 0)
        recordCompactSuccess()
        // 压缩成功后更新用量缓存：历史已被摘要替换，下一轮投递前硬闸不应再读到
        // 压缩前的 2.4M 估值（否则会误挡正常会话）。
        {
          const postTokens = estimateActiveContextTokens(verifyMsgs)
          rememberSessionUsedTokens(state, postTokens)
        }
        // CC 2.1.302 压缩续接：只有验证通过、水位推进后才登记边界；
        // 下一回合 takeCompactionContinuation 注入一次重建说明。
        markCompactionBoundary(state, { preTokens: estimateActiveContextTokens(msgs) })
        // 0918：压缩改写历史（摘要不见得保留尾端注入的 payload 正文）→ 作废尾端
        // 去重指纹，下一轮必重贴一次 payload，避免野兽帧在压缩后从上下文消失。
        state.lastTailPayloadHash = undefined
        // 静态段黏著 latch 解冻：压缩是 session 级边界，下次组装重新冻结于新的起点
        // （设计取自 Claude Code：/compact 清 systemPromptSection 快取）。
        unfreezeSystemStaticSections(state)
        markDirty(state)
        console.log(
          `[gateway] session compacted: ${state.sessionId} (${count} messages -> summary, now ${verifyMsgs.length} msgs)`,
        )
        // 需求1（2026-10-02）：压缩是系统级边界——发一则使用者可见的 context.compacted
        // 事件（系统级、永不进 assistant 正文流、预设耐久可 replay 重放）。放在验证
        // 通过、水位推进之后＝只有真压缩成功才告知用户；失败（假成功已挡）不发。
        emitContextCompacted(state, { trigger: "auto", preTokens: estimateActiveContextTokens(msgs) })
        // CC 2.1.302 PostCompact：压缩验证通过后触发。additional_context 存成下一轮
        // 压缩续接（与 markCompactionBoundary 同生命周期，只注入一次）。hook 失败不
        // 影响已完成的压缩：runHooksWithBudget 不 throw，5s 预算后 fail-open。
        {
          const summaryText = extractCompactedSummary(verifyMsgs, count)
          const post = await runHooksWithBudget(
            "PostCompact",
            { ...buildPostCompactHookInput({
              trigger: "auto",
              summary: summaryText,
              sessionId: state.sessionId,
              cwd: process.cwd(),
            }) },
            // 不传 timeoutMs：压缩事件由 hooks-http 默认 5s（HOOKS_HTTP_COMPACTION_TIMEOUT_MS）。
          )
          if (post.errors.length > 0) {
            console.warn(`[gateway] hooks PostCompact errors session=${state.sessionId}: ${post.errors.join(" | ")}`)
          }
          const appliedPost = applyPostCompactResult({
            additionalContext: post.additionalContext,
            results: post.results,
          })
          if (appliedPost.userDisplayMessage) {
            console.log(`[gateway] PostCompact: ${appliedPost.userDisplayMessage.slice(0, 500)}`)
          }
          if (post.additionalContext?.trim()) {
            setHookCompactionContinuation(state, post.additionalContext)
          }
          // 压缩是会话级边界：允许下一次用户消息重新触发 SessionStart（source=compact）。
          hookSessionStarted.delete(state)
          hookSessionSource.set(state, "compact")
        }
      })(),
    )
    try {
      await compactionJobs.get(state.sessionId)
    } finally {
      compactionJobs.delete(state.sessionId)
    }
  } catch (e) {
    console.warn(`[gateway] session compact error for ${state.sessionId}: ${e}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// context.compacted 边界事件（2026-10-02，需求 1 中唯一有真 call site 的部分）。
//
// 原本此处的「送上游组装」纯函式（压缩摘要独立角色＋旗标、工具结果 50k 落盘
// 预算＋前后预览、prepareUpstreamMessages 组合入口）已移除：前提不成立 ——
// gateway 每轮只送单条 promptBody，会话历史由 opencode 拥有，gateway 从不自组
// 送上游讯息阵列，故那批函式无任何生产 call site。同功能的正确落点是 opencode
// 的 `experimental.chat.messages.transform` plugin hook（另一进程），不可能从
// 本模组 import。勿在此重造。
// ═══════════════════════════════════════════════════════════════════════════

/** 使用者可见的系统级压缩边界事件名。非 message.delta/reasoning.delta，
 *  故 emitToSession 默认 strippable=false＝耐久、可经 replay 重放，且永不进
 *  assistant 正文流（前端/网关的正文判别只认 assistant 讯息）。 */
export const CONTEXT_COMPACTED_EVENT = "context.compacted"

export interface CompactedPayload {
  trigger: "auto" | "manual"
  preTokens?: number
}

/** opencode 讯息的最小可辨识形状（info.role/summary/mode/auto/tokens ＋ parts）。 */
export interface MessageLike {
  info?: { id?: string; role?: string; summary?: boolean; mode?: string; auto?: boolean; tokens?: { input?: number } }
  parts?: Array<{ type?: string; text?: string; state?: Record<string, unknown> }>
  role?: string
  [k: string]: unknown
}

/** 字元→token 粗估（4 字元/token，与业界常用估法一致；只用于告知用量，非计费）。 */
export function estimateTokensFromMessages(msgs: unknown[]): number | undefined {
  if (!Array.isArray(msgs) || msgs.length === 0) return undefined
  let chars = 0
  for (const m of msgs) {
    const parts = (m as MessageLike | null | undefined)?.parts
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p?.text === "string") chars += p.text.length
        // 2026-10-18：工具结果在 state.output（不在 text），旧估法漏掉全部工具输出，
        // 会让「工具密集的超大会话」被严重低估。只对 tool part 计入，避免重复。
        const out = (p as { type?: string; state?: { output?: unknown } } | null | undefined)?.state?.output
        if ((p as { type?: string } | null | undefined)?.type === "tool" && typeof out === "string") {
          chars += out.length
        }
      }
      continue
    }
    // 取不到 parts 时退回整条序列化长度，避免漏估成 0。
    try {
      chars += JSON.stringify(m).length
    } catch {
      /* 不可序列化即略过 */
    }
  }
  return chars > 0 ? Math.ceil(chars / 4) : undefined
}

/**
 * 发出一则使用者可见的 context.compacted 系统边界事件。
 * 默认走 emitToSession（耐久、可 replay、永不进 assistant 正文流）。
 * 回传是否已送出。此函数不依赖任何正文流判定——它与模型输出无共用路径。
 */
export function emitContextCompacted(
  state: SessionState,
  payload: CompactedPayload,
  emit?: (name: string, data: unknown) => void,
): boolean {
  const sender = emit ?? ((name: string, data: unknown) => emitToSession(state, name, data))
  sender(CONTEXT_COMPACTED_EVENT, {
    trigger: payload.trigger,
    ...(typeof payload.preTokens === "number" ? { preTokens: payload.preTokens } : {}),
  })
  return true
}
