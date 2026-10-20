// index.ts 行区 6871–7413 机械抽取（Wave3，2026-09-19）：全局记忆接线（PRD P0-4）——
// 预算常量、注入块组装、trace 三件、召回 prefetch、批次 deps 与 ticker、三个内部端点。
// 逐行搬运自 /home/lenovo/Desktop/image-app/deploy-staging/gateway/index.ts，仅加 export 前缀＋本档头＋单行 import。
// 注意：memoryBatch 单例与 ticker setInterval 是模组级副作用，原样搬运（载入即生效）。
import { recallTop, expandRecallQuery, clampRecallK, RECALL_K_DEFAULT, RECALL_K_MAX, type RecallableDoc } from "./memory-recall"
// 单向依赖：wiring → memory-http 注册钩子；memory-http 不反向 import wiring（无新循环）。
import { createMemoryBatch } from "./memory-batch"
import { setMemoryNoteIngestHook } from "./memory-http"
import { MEMORY_INGEST_SECRET, MEMORY_BATCH_ENABLED, MEMORY_BATCH_HOUR_UTC, MEMORY_SHARED_ENABLED, MEMORY_VERIFIER_MODEL, MEMORY_ORACLE_MODEL } from "./constants-gateway"
import { getOwnedSession } from "./sessions-core"
import { jsonError } from "./gw-lib"
import { MEMORY_PLATFORM_STATUS_BUDGET, MEMORY_L0_BUDGET, MEMORY_L1_BUDGET, MEMORY_INJECTION_TOTAL_BUDGET, MEMORY_WARM_RECALL_BUDGET, MEMORY_PRIVATE_DOCS_MAX, MEMORY_TRUNC_MARK, MEMORY_RECALL_PREFETCH_TTL_MS, MEMORY_ASSISTANT_HEAD_CHARS, MEMORY_PRIVATE_SCOPE_NOTE, clampMemoryChars, isFreshCreativeRequest, isPreferenceMemoryDoc, PROJECT_REUSE_RULE, FRESH_CREATIVE_TURN_DIRECTIVE, memoryWarmRecallRoom, buildMemoryInjectionBlocks, MEMORY_CONTINUITY_BUDGET, RECENT_ASSET_WINDOW_MS, RECENT_ASSET_MAX_ITEMS, REPEAT_TOPIC_WINDOW_MS, REPEAT_TOPIC_MIN_ROUNDS, REPEAT_TOPIC_MIN_SIMILARITY, topicSimilarity, detectRepeatTopic, extractSnapshotAssets, buildRecentAssetIndex, buildFirstTurnContinuityLines, type ContinuityRow } from "./memory-wiring-inject"
import { ensureMemoryTrace, appendMemoryRecallTrace, noteAssistantHeadForRecall, memoryDocIds, memoryFetchExport, memorySharedCorpus, MEMORY_PLATFORM_STATUS_TTL_MS, getPlatformStatusLines, memoryRecallPrefetch, memoryRecallInflight, MEMORY_RECALL_SESSION_BYTE_BUDGET, MEMORY_RECALL_SESSION_USAGE_MAX, memoryRecallSessionBytes, memoryRecallSessionUsed, resetMemoryRecallSessionUsage, MEMORY_RECALL_TURN_MAP_MAX, memoryRecallActive, memoryRecallScoringOptions, takeMemoryRecallPrefix, recallDedupeKey, memoryRecallDedupeHit, takeWarmCorpusRecallPrefix, scheduleMemoryRecallPrefetch, type MemoryRecallPrefetchEntry } from "./memory-wiring-recall"
import { KNOWLEDGE_TOOL_NAMES, memoryTranscriptOf, memorySessionCounts, memoryListSessions, memoryCallLlm, memoryPostIngest, memoryCallLlmWithModel } from "./memory-wiring-batch"

// 2026-10-19：note/批次 ingest 成功后立即失效语料快取——supersede/retract 后不再最多
// 滞后一个 TTL（5 分钟）仍可被召回。钩子只做内存清空，不发起网络、不抛。
setMemoryNoteIngestHook(() => memorySharedCorpus.invalidate())
export const memoryBatch = createMemoryBatch({
  listSessions: memoryListSessions,
  transcriptOf: memoryTranscriptOf,
  callLlm: memoryCallLlm,
  callVerifierLlm: (prompt, model) => memoryCallLlmWithModel(prompt, model, "verifier"),
  callOracleLlm: (prompt, model) => memoryCallLlmWithModel(prompt, model, "oracle"),
  postIngest: memoryPostIngest,
  // 批次 ingest（首送成功或 pending 重放成功）后同步失效召回语料，避免旧文档继续被召回。
  onIngestSuccess: () => memorySharedCorpus.invalidate(),
  env: {
    MEMORY_INGEST_SECRET,
    MEMORY_BATCH_ENABLED: process.env.MEMORY_BATCH_ENABLED,
    MEMORY_BATCH_MAX_SESSIONS: process.env.MEMORY_BATCH_MAX_SESSIONS,
    MEMORY_BATCH_MAX_LLM: process.env.MEMORY_BATCH_MAX_LLM,
    MEMORY_SHARED_ENABLED: process.env.MEMORY_SHARED_ENABLED,
    MEMORY_VERIFIER_MODEL,
    MEMORY_ORACLE_MODEL,
    MEMORY_STATE_DIR: process.env.MEMORY_STATE_DIR,
  },
  now: () => new Date(),
})
/** §3.5 手动批次触发（过 isLoopback 门后进入）。body {dry_run, session_ids, date} 透传 runBatch，回 §3.5 报告形状。 */
export async function handleMemoryBatchRunInternal(req: Request): Promise<Response> {
  let body: { dry_run?: boolean; session_ids?: string[]; date?: string }
  try {
    body = (await req.json()) as { dry_run?: boolean; session_ids?: string[]; date?: string }
  } catch {
    body = {}
  }
  try {
    const report = await memoryBatch.runBatch({
      dryRun: body.dry_run === true,
      sessionIds: Array.isArray(body.session_ids) ? body.session_ids.map((s) => String(s)) : undefined,
      date: typeof body.date === "string" ? body.date : undefined,
    })
    return Response.json(report)
  } catch (e) {
    // runBatch 的拒绝原因（总开关未开／参数非法）原样透传——诚实报错，不造假 200。
    const msg = e instanceof Error ? e.message : String(e)
    return jsonError(409, `memory batch failed: ${msg}`, "memory_batch_failed", "memory_batch_failed")
  }
}

/** §3.6 注入 trace（R2 尺观测点）。尚无 trace（未注入／重启丢失）→ 空形状、injected_at=null。 */
export async function handleMemoryTrace(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  return Response.json(
    state.memoryTrace ?? { private_docs: [], shared_recalled: [], shared_index_chars: 0, injected_at: null },
  )
}

/**
 * memory_recall 工具后端（PRD §6.2；【契约外新增路由】，已随本片回报）。
 * 从共享语料跑 §7 召回，回 {results:[{doc:{slug,domain,description,body},score}],count}。
 * limit 默认 3（§7）、上限 RECALL_K_MAX=5（2026-10-02 收紧，原 10；对齐工具层
 * memory_recall_impl 的「默认 3、帽值 5」与 Claude Code 每次查询最多 5 条的设计概念）；
 * minScore=MEMORY_RECALL_MIN_SCORE；共享关 → 空 results。
 */
export async function handleMemoryRecallSearch(key: string, req: Request): Promise<Response> {
  void key // 同族鉴权口径：Bearer 闸门已在上游验过，此端点无 session 维度，不需 key 数据面
  let body: { query?: string; domain?: string; limit?: number }
  try {
    body = (await req.json()) as { query?: string; domain?: string; limit?: number }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const query = typeof body.query === "string" ? body.query.slice(0, 500) : ""
  if (!query.trim()) return jsonError(400, "query is required", "bad_request", "bad_request")
  if (!MEMORY_SHARED_ENABLED) return Response.json({ results: [], count: 0 })
  let docs: RecallableDoc[]
  try {
    docs = await memorySharedCorpus.get("shared")
  } catch (e) {
    console.error(`[memory-recall] corpus fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    return jsonError(502, "memory corpus unavailable", "backend_error", "backend_error")
  }
  if (typeof body.domain === "string" && body.domain.trim()) {
    const dm = body.domain.trim()
    docs = docs.filter((d) => d.domain === dm)
  }
  // 工具路径直接扩展 query；k 仍按请求 limit（其余评分参数与注入路径同一来源）。
  const hits = recallTop(expandRecallQuery(query), docs, {
    ...memoryRecallScoringOptions(),
    k: clampRecallK(body.limit, RECALL_K_DEFAULT),
  })
  const results = hits.slice(0, RECALL_K_MAX).map((h) => ({
    doc: { slug: h.doc.slug, domain: h.doc.domain, description: h.doc.description, body: h.doc.body },
    score: h.score,
  }))
  // 工具端 memory_recall_impl 解析 body.results ?? body.docs（顶层阵列=直接抛 upstream_bad_response）
  // 不变量：results.length ≤ RECALL_K_MAX（recallTop 已夹帽，此处再 slice 兜底防未来改动漏接）。
  return Response.json({ results, count: results.length })
}
// ── 批次 ticker（60s；轮子＝本档既有 setInterval 写法）─────────────────────
// 条件（§8）：MEMORY_BATCH_ENABLED && UTC 时 == MEMORY_BATCH_HOUR_UTC && 游标日期<今日。
// 「游标日期」以进程内 volatile 闸实装＝最近一次批次尝试日的 UTC 日期：memory-batch 的
// 游标档只有会话维度去重、未暴露批次日期维度；尝试即置位防同小时 60 连发，失败当日由
// 运维经 POST /internal/memory/batch-run 手动重跑。每 tick 顺带 drainPending()
// （pending 重发指数退避；无 pending 档时 noop，总开关 off 也照跑——残留档要有人收）。
export let memoryBatchLastRunDate = ""
// H17 批次时机最小修法：原先「每日单一 UTC 时（预设 20h＝台北 04:00）」→ 当日产物结构上不可能可用。
// 改为可配多个 UTC 时窗（env MEMORY_BATCH_EXTRA_HOURS_UTC，如 "2,8,14"；预设空＝行为不变），
// 闸门由「日期」改为「日期+小时」key，同小时仍只跑一次。纯函式便于单测。
export function memoryBatchHours(primary: number, extraEnv: string | undefined): number[] {
  const extra = (extraEnv ?? "")
    .split(",")
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23)
  return Array.from(new Set([primary, ...extra]))
}
export function memoryBatchSlotKey(now: Date, hours: number[]): string | null {
  if (!hours.includes(now.getUTCHours())) return null
  return `${now.toISOString().slice(0, 10)}T${String(now.getUTCHours()).padStart(2, "0")}`
}
let memoryBatchLastSlotKey = ""
setInterval(() => {
  void (async () => {
    try {
      await memoryBatch.drainPending()
    } catch (e) {
      console.error(`[memory-batch] drain tick failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!MEMORY_BATCH_ENABLED) return
    const now = new Date()
    const slot = memoryBatchSlotKey(now, memoryBatchHours(MEMORY_BATCH_HOUR_UTC, process.env.MEMORY_BATCH_EXTRA_HOURS_UTC))
    if (!slot || memoryBatchLastSlotKey === slot) return
    memoryBatchLastSlotKey = slot
    const today = slot.slice(0, 10)
    memoryBatchLastRunDate = today
    console.log(`[memory-batch] scheduled batch starting (UTC ${MEMORY_BATCH_HOUR_UTC}h ${today})`)
    try {
      const report = await memoryBatch.runBatch({})
      console.log(
        `[memory-batch] scheduled batch done: batch=${report.batch_id} candidates=${report.candidates} passed=${report.passed} stored=${report.stored} queue.pending=${report.queue.pending} queue.consumed=${report.queue.consumed} queue.no_docs=${report.queue.no_docs} queue.failed=${report.queue.failed} ledger.sessions=${report.ledger.sessions_processed}/${report.ledger.sessions_selected} ledger.llm=${report.ledger.llm_calls} ledger.errors=${report.ledger.errors.length}`,
      )
    } catch (e) {
      console.error(`[memory-batch] scheduled batch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })()
}, 60_000)
export { MEMORY_L0_BUDGET, MEMORY_L1_BUDGET, MEMORY_INJECTION_TOTAL_BUDGET, MEMORY_PLATFORM_STATUS_BUDGET, MEMORY_WARM_RECALL_BUDGET, MEMORY_PRIVATE_DOCS_MAX, MEMORY_TRUNC_MARK, MEMORY_RECALL_PREFETCH_TTL_MS, MEMORY_ASSISTANT_HEAD_CHARS, MEMORY_PRIVATE_SCOPE_NOTE, clampMemoryChars, isFreshCreativeRequest, isPreferenceMemoryDoc, PROJECT_REUSE_RULE, FRESH_CREATIVE_TURN_DIRECTIVE, memoryWarmRecallRoom, buildMemoryInjectionBlocks, MEMORY_CONTINUITY_BUDGET, RECENT_ASSET_WINDOW_MS, RECENT_ASSET_MAX_ITEMS, REPEAT_TOPIC_WINDOW_MS, REPEAT_TOPIC_MIN_ROUNDS, REPEAT_TOPIC_MIN_SIMILARITY, topicSimilarity, detectRepeatTopic, extractSnapshotAssets, buildRecentAssetIndex, buildFirstTurnContinuityLines } from "./memory-wiring-inject"
export type { ContinuityRow } from "./memory-wiring-inject"
export { ensureMemoryTrace, appendMemoryRecallTrace, noteAssistantHeadForRecall, memoryDocIds, memoryFetchExport, memorySharedCorpus, MEMORY_PLATFORM_STATUS_TTL_MS, getPlatformStatusLines, memoryRecallPrefetch, memoryRecallInflight, MEMORY_RECALL_SESSION_BYTE_BUDGET, MEMORY_RECALL_SESSION_USAGE_MAX, memoryRecallSessionBytes, memoryRecallSessionUsed, resetMemoryRecallSessionUsage, MEMORY_RECALL_TURN_MAP_MAX, memoryRecallActive, memoryRecallScoringOptions, takeMemoryRecallPrefix, recallDedupeKey, memoryRecallDedupeHit, takeWarmCorpusRecallPrefix, scheduleMemoryRecallPrefetch } from "./memory-wiring-recall"
export type { MemoryRecallPrefetchEntry } from "./memory-wiring-recall"
export { KNOWLEDGE_TOOL_NAMES, memoryTranscriptOf, memorySessionCounts, memoryListSessions, memoryCallLlm, memoryPostIngest, memoryCallLlmWithModel } from "./memory-wiring-batch"
