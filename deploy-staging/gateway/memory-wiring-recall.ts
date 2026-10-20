import { CorpusCache, recallTop, buildRecallQuery, expandRecallQuery, renderRecallPrefix, clampRecallK, clipToUtf8Bytes, utf8ByteLength, RECALL_K_DEFAULT, type RecallableDoc, type RecallTopOptions } from "./memory-recall"
import { MEMORY_SIGNATURE_HEADER, signEmptyMemoryBody } from "./memory-batch"
import { MEMORY_INGEST_SECRET, MEMORY_INGEST_BASE_URL, MEMORY_SHARED_ENABLED, MEMORY_RECALL_MIN_SCORE, MEMORY_RECALL_ENABLED, MEMORY_RECALL_RECENCY_WEIGHT, MEMORY_RECALL_HALF_LIFE_DAYS, MEMORY_RECALL_LINK_EXPANSION, MEMORY_RECALL_LINK_DAMPING, MEMORY_RECALL_LINK_ITERATIONS, MEMORY_RECALL_LINK_MIN_MASS } from "./constants-gateway"
import type { SessionState } from "./types-gateway"
import { MEMORY_PLATFORM_STATUS_BUDGET, MEMORY_ASSISTANT_HEAD_CHARS, MEMORY_RECALL_PREFETCH_TTL_MS } from "./memory-wiring-inject"
/** §3.6 形状 trace：首个观测点（注入或召回命中）落地时建立。 */
export function ensureMemoryTrace(state: SessionState): NonNullable<SessionState["memoryTrace"]> {
  if (!state.memoryTrace) {
    state.memoryTrace = {
      private_docs: [],
      shared_recalled: [],
      shared_index_chars: 0,
      injected_at: new Date().toISOString(),
    }
  }
  return state.memoryTrace
}

/** 召回命中写入 trace.shared_recalled。id 取自 memoryDocIds 旁表（模组 toRecallableDocs 剥 id，不动其逻辑）；缺则以 slug 兜底（偏离点已回报）。 */
export function appendMemoryRecallTrace(state: SessionState, refs: Array<{ domain: string; slug: string }>): void {
  if (refs.length === 0) return
  const trace = ensureMemoryTrace(state)
  for (const r of refs) {
    const id = memoryDocIds.get(`${r.domain}/${r.slug}`) ?? r.slug
    if (!trace.shared_recalled.includes(id)) trace.shared_recalled.push(id)
  }
  const RECALL_TRACE_CAP = 32
  if (trace.shared_recalled.length > RECALL_TRACE_CAP) {
    trace.shared_recalled.splice(0, trace.shared_recalled.length - RECALL_TRACE_CAP)
  }
}

/** §7 召回辅助：累积本轮 assistant 正文头部（只需前 200 字元，填满即停，成本 O(1)）。 */
export function noteAssistantHeadForRecall(state: SessionState, text: string): void {
  if (!text) return
  const cur = state.turnAssistantHead ?? ""
  if (cur.length >= MEMORY_ASSISTANT_HEAD_CHARS) return
  state.turnAssistantHead = (cur + text).slice(0, MEMORY_ASSISTANT_HEAD_CHARS)
}

// ── 召回语料与 prefetch（契约 §3.3/§7）────────────────────────────────────

// export 端点的 id 旁表：CorpusCache 的 toRecallableDocs 只留四栏，trace 需要真 id；
// 在 fetchExport（本档所有）解析时顺手收录，key=`domain/slug`。有界：超 5000 整表重清
// （CorpusCache TTL 5 分钟自然全量重拉回填）。
export const memoryDocIds = new Map<string, string>()

/** 签名 GET export（§3：GET 无 body → 空 bytes 验签）。CorpusCache 传入的 headers 已含同款签名，这里按本档 env 快照重建以明确 fail-fast。 */
export async function memoryFetchExport(pathWithQuery: string, headers: Record<string, string>): Promise<unknown> {
  if (!MEMORY_INGEST_SECRET) throw new Error("MEMORY_INGEST_SECRET 未配置")
  const res = await fetch(`${MEMORY_INGEST_BASE_URL}${pathWithQuery}`, {
    headers: { ...headers, [MEMORY_SIGNATURE_HEADER]: signEmptyMemoryBody(MEMORY_INGEST_SECRET) },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`memory export HTTP ${res.status}`)
  const payload = (await res.json()) as unknown
  const list = (payload as { docs?: unknown })?.docs
  if (Array.isArray(list)) {
    if (memoryDocIds.size > 5000) memoryDocIds.clear()
    for (const raw of list) {
      const d = raw as Record<string, unknown>
      if (typeof d?.id === "string" && typeof d?.domain === "string" && typeof d?.slug === "string") {
        memoryDocIds.set(`${d.domain}/${d.slug}`, d.id)
      }
    }
  }
  return payload
}

// 语料 TTL 5 分钟（§3.3 默认）；secret provider 显式指向本档 env 快照。
export const memorySharedCorpus = new CorpusCache(memoryFetchExport, 5 * 60 * 1000, () => MEMORY_INGEST_SECRET)

// ── 服务端实时平台状态（2026-10-19）────────────────────────────────────────
// 目的：把「平台此刻哪些模型没有健康供应商/在冷却、近 1 小时谁成功率明显偏低」
// 作为服务端观测注入，替代用户把节点故障写成记忆、模型再读记忆当事实。
// 通道复用记忆导出同一套 HMAC（GET 无 body → 空 bytes 签名）；任何失败都回 []，
// 不抛、不挡回合。进程内缓存 5 分钟，超时 3 秒。
export const MEMORY_PLATFORM_STATUS_TTL_MS = 5 * 60 * 1000
const MEMORY_PLATFORM_STATUS_TIMEOUT_MS = 3_000
let platformStatusCache: { expiresAt: number; lines: string[] } | null = null

function platformStatusEnabled(): boolean {
  const raw = process.env.MEMORY_PLATFORM_STATUS_ENABLED
  if (raw === undefined) return true
  return !/^(0|false|off|no)$/i.test(raw.trim())
}

/**
 * 防御性收口：只收非空字串、总长 ≤ MEMORY_PLATFORM_STATUS_BUDGET。
 * 2026-10-19 P2-3：`degraded === true` 不再整块丢弃——有状态行时在末尾补一行
 * 「部分平台数据源暂不可用」提示（让模型知道这份观测不完整）；一行状态都没有时
 * 仍回 []（不注入空块／不伪造健康）。
 */
function sanitizePlatformStatusLines(payload: unknown): string[] {
  const degraded = (payload as { degraded?: unknown })?.degraded === true
  const raw = (payload as { lines?: unknown })?.lines
  if (!Array.isArray(raw)) return []
  // degraded 时为提示行预留一个位置，保持「最多 5 行」契约。
  const maxLines = degraded ? 4 : 5
  const out: string[] = []
  let used = 0
  for (const item of raw) {
    if (out.length >= maxLines) break
    if (typeof item !== "string") continue
    const line = item.trim()
    if (!line) continue
    const remaining = MEMORY_PLATFORM_STATUS_BUDGET - used
    if (remaining <= 0) break
    const clipped = line.length <= remaining ? line : `${line.slice(0, Math.max(0, remaining - 1))}…`
    out.push(clipped)
    used += clipped.length
  }
  if (!degraded) return out
  if (out.length === 0) return []
  const notice = "（部分平台数据源暂不可用，以下状态可能不完整）"
  const remaining = MEMORY_PLATFORM_STATUS_BUDGET - used
  if (remaining <= 0) return out
  out.push(notice.length <= remaining ? notice : `${notice.slice(0, Math.max(0, remaining - 1))}…`)
  return out
}

/**
 * 取服务端实时平台状态行（gateway 侧）。`MEMORY_PLATFORM_STATUS_ENABLED` 预设开启；
 * 未配置 secret → []。失败/降级一律 [] 并 debug log，绝不抛。
 */
export async function getPlatformStatusLines(): Promise<string[]> {
  if (!platformStatusEnabled()) return []
  const now = Date.now()
  if (platformStatusCache && platformStatusCache.expiresAt > now) return platformStatusCache.lines
  if (!MEMORY_INGEST_SECRET) return []
  const cache = (lines: string[]): string[] => {
    platformStatusCache = { expiresAt: Date.now() + MEMORY_PLATFORM_STATUS_TTL_MS, lines }
    return lines
  }
  try {
    const res = await fetch(`${MEMORY_INGEST_BASE_URL}/api/internal/platform-status`, {
      headers: { [MEMORY_SIGNATURE_HEADER]: signEmptyMemoryBody(MEMORY_INGEST_SECRET) },
      signal: AbortSignal.timeout(MEMORY_PLATFORM_STATUS_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.debug(`[memory-platform-status] HTTP ${res.status} — skip injection`)
      return cache([])
    }
    return cache(sanitizePlatformStatusLines((await res.json()) as unknown))
  } catch (e) {
    console.debug(
      `[memory-platform-status] fetch failed: ${e instanceof Error ? e.message : String(e)} — skip injection`,
    )
    return cache([])
  }
}

export interface MemoryRecallPrefetchEntry {
  prefix: string
  docRefs: Array<{ domain: string; slug: string }>
  at: number
}
// prefetch 缓存 Map<sessionId,{prefix,at}>（§7）：5 分钟 TTL，随会话销毁清理（teardownSession）。
export const memoryRecallPrefetch = new Map<string, MemoryRecallPrefetchEntry>()
export const memoryRecallInflight = new Set<string>()

// ── 单 session 召回注入位元组上限（2026-10-02）──────────────────────────────
// 设计取自 Claude Code attachments.ts 的 RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES（60KB）——
// 概念：单回合有上限，但长会话每回合持续注入不同记忆会累积灌爆上下文，故设 session 累计帽。
// 我方实作：模组级 Map<sessionId, 已注入 bytes>，在 takeMemoryRecallPrefix（每次真正注入点）
// 记帐；超限即「降级」——裁到剩余额度或整段不注入，并以 warn 记 log，绝不抛错。
// 清理缺口：sessions-core 的 teardownSession 未接此 Map（该档非本轮所有权），故以
// 有界淘汰自我防漏（超上限条数丢最旧 session；session 重建后计数归零，语义等同重置）。
export const MEMORY_RECALL_SESSION_BYTE_BUDGET = 60 * 1024 // 60KB（≈3 次满额注入）
export const MEMORY_RECALL_SESSION_USAGE_MAX = 2000 // Map 条数上限（防跨 session 无界增长）
export const memoryRecallSessionBytes = new Map<string, number>()

/** 本 session 累计已注入的召回位元组。 */
export function memoryRecallSessionUsed(sessionId: string): number {
  return memoryRecallSessionBytes.get(sessionId) ?? 0
}

/** 记帐（有界：超条数丢最旧，Map 保留插入序）。 */
function noteMemoryRecallSessionBytes(sessionId: string, bytes: number): void {
  memoryRecallSessionBytes.set(sessionId, bytes)
  if (memoryRecallSessionBytes.size > MEMORY_RECALL_SESSION_USAGE_MAX) {
    const oldest = memoryRecallSessionBytes.keys().next().value
    if (oldest !== undefined) memoryRecallSessionBytes.delete(oldest)
  }
}

/** 归零某 session 的累计（供 teardown 或压缩后重置；目前未接呼叫端）。 */
export function resetMemoryRecallSessionUsage(sessionId: string): void {
  memoryRecallSessionBytes.delete(sessionId)
}

// ── 同回合召回正文去重（2026-10-19 P2）─────────────────────────────────────
// 两条注入路径（messages-gw 的 prefetch 注入 + context-injection 的热语料展开）在同一
// 请求内前后脚执行。旧实现只按 query 指纹去重，prefetch 路径拿不到本轮文本、其 key 是
// 正文指纹；同一回合换一个 query 走热展开会再注入一份 1800 字召回正文（实测重复）。
// 语义：Map<sessionId, turnKey> —— **同一回合只保留一份召回正文**；不同回合即使 query
// 相同也允许（同 query 的 5 秒防抖仍由既有 query 指纹兜底）。
// 有界：超 2000 条丢最旧（Map 保留插入序）。
export const MEMORY_RECALL_TURN_MAP_MAX = 2000
const memoryRecallInjectedTurn = new Map<string, string>()

function recallInjectedThisTurn(sessionId: string, turnKey?: string): boolean {
  if (!turnKey) return false
  return memoryRecallInjectedTurn.get(sessionId) === turnKey
}

function noteMemoryRecallTurn(sessionId: string, turnKey?: string): void {
  if (!turnKey) return
  memoryRecallInjectedTurn.set(sessionId, turnKey)
  if (memoryRecallInjectedTurn.size > MEMORY_RECALL_TURN_MAP_MAX) {
    const oldest = memoryRecallInjectedTurn.keys().next().value
    if (oldest !== undefined) memoryRecallInjectedTurn.delete(oldest)
  }
}

export function memoryRecallActive(): boolean {
  return MEMORY_RECALL_ENABLED && MEMORY_SHARED_ENABLED
}

/**
 * 召回评分选项单一来源（2026-10-19）：prefetch／热语料展开／工具端三处共用，
 * 禁止把 recency/link 参数写死在各自呼叫点。k 默认取 env MEMORY_RECALL_K；
 * 工具路径若需按请求覆盖，spread 后覆写 k 即可。
 */
export function memoryRecallScoringOptions(): RecallTopOptions & { minScore: number; k: number } {
  return {
    minScore: MEMORY_RECALL_MIN_SCORE,
    k: clampRecallK(process.env.MEMORY_RECALL_K, RECALL_K_DEFAULT),
    recencyWeight: MEMORY_RECALL_RECENCY_WEIGHT,
    recencyHalfLifeDays: MEMORY_RECALL_HALF_LIFE_DAYS,
    linkExpansion: MEMORY_RECALL_LINK_EXPANSION,
    linkDamping: MEMORY_RECALL_LINK_DAMPING,
    linkIterations: MEMORY_RECALL_LINK_ITERATIONS,
    linkMinMass: MEMORY_RECALL_LINK_MIN_MASS,
  }
}

/**
 * 回合开始取预取候选（读即弃：回合结束重算，防旧候选僵尸注入）。null=miss → 本回合不注入、异步补算。
 * 2026-10-02：此处即真正注入点，落实 session 累计位元组帽（超限降级不报错）。
 * 2026-10-19：注入成功后记一个短时去重标记，避免 context-injection 的热语料展开
 * 在同一回合把同一批正文再注入一次（两条路径都在本回合走）。
 * 2026-10-19 P2：`turnKey` 为回合键（messages-gw 传 `String(state.turnGen)`）。
 * 同一 session 同一 turnKey 已注入过召回正文 → 直接 null；成功注入非空 prefix 时写入。
 */
export function takeMemoryRecallPrefix(sessionId: string, turnKey?: string): MemoryRecallPrefetchEntry | null {
  if (!memoryRecallActive()) return null
  if (recallInjectedThisTurn(sessionId, turnKey)) return null
  const rec = memoryRecallPrefetch.get(sessionId)
  if (!rec) return null
  memoryRecallPrefetch.delete(sessionId)
  if (Date.now() - rec.at > MEMORY_RECALL_PREFETCH_TTL_MS) return null
  if (!rec.prefix) return rec
  const prefix = clipAndAccountRecallPrefix(sessionId, rec.prefix)
  if (prefix) {
    // 5 秒正文指纹防抖保持原语义；回合级去重另记 memoryRecallInjectedTurn。
    noteMemoryRecallInjection(sessionId, recallPrefixDedupeKey(prefix))
    noteMemoryRecallTurn(sessionId, turnKey)
  }
  return { ...rec, prefix }
}

// 同一回合两条注入路径（messages-gw 的 prefetch 注入 + context-injection 的热语料展开）
// 的去重窗口：两者在同一请求内前后脚执行，毫秒级；5 秒足以覆盖且不挡紧邻的下一回合。
//
// 2026-10-19 P2-1：去重键从「session 级时间戳」改为 query 指纹。旧实现只要同 session
// 5 秒内出现过注入，就把紧邻的正常追问也一并抑制（不同 query 被误杀）。
//   - key = 用户文本的稳定指纹（FNV-1a 32 位 + 长度，无新依赖）；
//   - 只在「同一 key 且 5 秒内」抑制；不同 query 立即放行；
//   - prefetch 路径在注入时拿不到本轮用户文本，故以「注入正文的指纹」作为该路径的 key；
//     热展开路径同时比对 query 指纹与正文指纹。回合级去重（memoryRecallInjectedTurn）
//     另有一层：同一回合最多一份召回正文，不再依赖这两条 5 秒窗口是否巧合命中。
const MEMORY_RECALL_TURN_DEDUPE_MS = 5_000
interface MemoryRecallDedupeEntry {
  at: number
  key: string
}
const memoryRecallInjectedAt = new Map<string, MemoryRecallDedupeEntry>()

/** 用户文本的稳定指纹（FNV-1a 32 位；长度一并入 key，降低碰撞歧义）。纯函式。 */
export function recallDedupeKey(userText: string): string {
  const text = typeof userText === "string" ? userText : ""
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length}:${hash.toString(16)}`
}

/** 召回正文指纹（prefetch 路径没有 query 文本时使用）。 */
function recallPrefixDedupeKey(prefix: string): string {
  return `prefix:${recallDedupeKey(prefix)}`
}

function noteMemoryRecallInjection(sessionId: string, key: string): void {
  memoryRecallInjectedAt.set(sessionId, { at: Date.now(), key })
  if (memoryRecallInjectedAt.size > MEMORY_RECALL_SESSION_USAGE_MAX) {
    const oldest = memoryRecallInjectedAt.keys().next().value
    if (oldest !== undefined) memoryRecallInjectedAt.delete(oldest)
  }
}

/** 去重判定（只读，供热展开路径在真正注入前询问）：同一 key 且窗口内才命中。 */
export function memoryRecallDedupeHit(sessionId: string, keys: string[], nowMs: number = Date.now()): boolean {
  const hit = memoryRecallInjectedAt.get(sessionId)
  if (!hit) return false
  if (nowMs - hit.at > MEMORY_RECALL_TURN_DEDUPE_MS) return false
  return keys.some((k) => k !== "" && k === hit.key)
}

/**
 * 与 takeMemoryRecallPrefix 共用的 session 位元组记帐（2026-10-19 抽出，两处同语义）：
 * 超限裁到剩余额度，额度用完整段丢弃并 warn，绝不抛错。
 */
function clipAndAccountRecallPrefix(sessionId: string, prefix: string): string {
  if (!prefix) return ""
  const used = memoryRecallSessionUsed(sessionId)
  const remaining = MEMORY_RECALL_SESSION_BYTE_BUDGET - used
  const bytes = utf8ByteLength(prefix)
  if (remaining <= 0) {
    console.warn(
      `[memory-recall] session byte budget exhausted session=${sessionId} used=${used}/${MEMORY_RECALL_SESSION_BYTE_BUDGET} — skip injection`,
    )
    return ""
  }
  if (bytes > remaining) {
    const clipped = clipToUtf8Bytes(prefix, remaining)
    console.warn(
      `[memory-recall] session byte budget exceeded session=${sessionId} prefix=${bytes}B remaining=${remaining}B — degraded to ${utf8ByteLength(clipped)}B`,
    )
    noteMemoryRecallSessionBytes(sessionId, used + utf8ByteLength(clipped))
    return clipped
  }
  noteMemoryRecallSessionBytes(sessionId, used + bytes)
  return prefix
}

/**
 * 热语料自动展开（2026-10-19）：语料已在内存缓存时，首回合（无 prefetch）也能同步
 * 拿到与本轮任务相关的记忆正文。
 *
 * 顺序：先吃既有 prefetch → 非 null 直接返回；否则（同回合未注入过）同步 peek
 * `memorySharedCorpus`，用与 scheduleMemoryRecallPrefetch 完全相同的
 * query/score/k 逻辑算 hits 并渲染，再走同一 session 位元组记帐。
 *
 * **本函式必须保持同步**：peek 只读内存快照，绝不 await 网络；任何异常返回 null，不抛。
 * 2026-10-19 P2：`turnKey` 存在且本回合已注入过召回正文 → 直接 null（同一回合最多一份
 * 召回块，prefetch 已注入后不再重复展开）；不同回合的不同 query 正常放行。
 */
export function takeWarmCorpusRecallPrefix(
  sessionId: string,
  userText: string,
  turnKey?: string,
): MemoryRecallPrefetchEntry | null {
  try {
    if (!memoryRecallActive()) return null
    if (!sessionId || !String(userText ?? "").trim()) return null
    if (recallInjectedThisTurn(sessionId, turnKey)) return null
    const prefetched = takeMemoryRecallPrefix(sessionId, turnKey)
    if (prefetched !== null) return prefetched
    const docs = memorySharedCorpus.peek("shared")
    if (!docs) return null
    const baseQuery = buildRecallQuery(userText)
    if (!baseQuery.trim()) return null
    // 2026-10-19：只在原文后追加时间 token（不替换），评分选项与 prefetch/工具端统一。
    const query = expandRecallQuery(baseQuery)
    const hits = recallTop(query, docs, memoryRecallScoringOptions())
    const rendered = renderRecallPrefix(hits.map((h) => h.doc))
    if (!rendered) return null
    // P2-1：同一 query 指纹或同一正文指纹的 5 秒防抖（抖动重试）仍然保留。
    const queryKey = recallDedupeKey(userText)
    if (memoryRecallDedupeHit(sessionId, [queryKey, recallPrefixDedupeKey(rendered)])) return null
    const prefix = clipAndAccountRecallPrefix(sessionId, rendered)
    if (!prefix) return null
    noteMemoryRecallInjection(sessionId, queryKey)
    noteMemoryRecallTurn(sessionId, turnKey)
    return {
      prefix,
      docRefs: hits.map((h) => ({ domain: h.doc.domain, slug: h.doc.slug })),
      at: Date.now(),
    }
  } catch (e) {
    console.debug(
      `[memory-recall] warm corpus expand failed session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

/** §7 prefetch：上一回合 session.idle 后台算好 top-3 候选（用户路径零新增延迟）。 */
export async function scheduleMemoryRecallPrefetch(state: SessionState): Promise<void> {
  if (!memoryRecallActive()) return
  if (memoryRecallInflight.has(state.sessionId)) return
  memoryRecallInflight.add(state.sessionId)
  try {
    // 2026-10-04 修 D7（召回 query 污染）：**只以用户本句组查询，不拼上一轮 assistant 头段**。
    // 实锤（eval-music-beast-1004）：音乐追问那轮召回 3 条有 2 条无关（multi-agent-production
    // 子代理批次、workflow-templates 大片模板），更切题的 leitmotif-reveal-mapping（纯音乐
    // query 打分 10.19）反落榜。根因＝beast 派遣回合的 assistant 开头是「派工／工具叙述」，
    // 拼进 BM25 把 top-3 拉向工作流语料。故本轮不传 turnAssistantHead（函式签名保留、
    // 既有测试不受影响）。turnAssistantHead 累积逻辑暂留（无害），未一并移除以缩小改动面。
    const baseQuery = buildRecallQuery(state.lastUserMessage ?? "")
    // 2026-10-04 T2 修 Hack-H2 §四（召回 query 退化边界）：query 为空/纯空白时
    //（首则消息、或内部触发轮 lastUserMessage 尚未写入），不落一笔空 prefix 条目
    // ——否则下一轮 takeMemoryRecallPrefix 会消费到空条目且不再补算，该轮召回静默失效。
    // 退化时直接跳过本次 prefetch（如实：不假装 0 命中），下一轮以真实 query 补算。
    if (!baseQuery.trim()) return
    const query = expandRecallQuery(baseQuery)
    const docs = await memorySharedCorpus.get("shared")
    // 上限／衰减／链接参数统一来自 memoryRecallScoringOptions（env 可调，k 夹 ≤ RECALL_K_MAX）。
    const hits = recallTop(query, docs, memoryRecallScoringOptions())
    memoryRecallPrefetch.set(state.sessionId, {
      prefix: renderRecallPrefix(hits.map((h) => h.doc)),
      docRefs: hits.map((h) => ({ domain: h.doc.domain, slug: h.doc.slug })),
      at: Date.now(),
    })
  } catch (e) {
    // 失败是常态（secret 未配／端点未上线），不刷 log；debug 级可查。
    console.debug(`[memory-recall] prefetch failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    memoryRecallInflight.delete(state.sessionId)
  }
}
