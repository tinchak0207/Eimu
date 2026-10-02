// index.ts 行區 6871–7413 機械抽取（Wave3，2026-09-19）：全局記憶接線（PRD P0-4）——
// 預算常量、注入塊組裝、trace 三件、召回 prefetch、批次 deps 與 ticker、三個內部端點。
// 逐行搬運自 /home/lenovo/Desktop/image-app/deploy-staging/gateway/index.ts，僅加 export 前綴＋本檔頭＋單行 import。
// 注意：memoryBatch 單例與 ticker setInterval 是模組級副作用，原樣搬運（載入即生效）。
import { CorpusCache, recallTop, buildRecallQuery, renderRecallPrefix, clampRecallK, clipToUtf8Bytes, utf8ByteLength, RECALL_K_DEFAULT, RECALL_K_MAX, type RecallableDoc } from "./memory-recall"
import { MEMORY_SIGNATURE_HEADER, signMemoryBytes, signEmptyMemoryBody, createMemoryBatch, type MemorySessionRecord } from "./memory-batch"
import { MEMORY_INGEST_SECRET, MEMORY_INGEST_BASE_URL, MEMORY_BATCH_ENABLED, MEMORY_BATCH_HOUR_UTC, MEMORY_SHARED_ENABLED, MEMORY_RECALL_MIN_SCORE, MEMORY_RECALL_ENABLED, MEMORY_VERIFIER_MODEL, MEMORY_ORACLE_MODEL } from "./constants-gateway"
import { bindingRef } from "./model-registry"
import { getOwnedSession } from "./sessions-core"
import { loadSessionByOpencodeId } from "./persistence"
import { opencodeFetch } from "./opencode-client"
import { jsonError } from "./gw-lib"
import { hashKey } from "./auth-gw"
import type { SessionState } from "./types-gateway"

// ─────────────────────────── 全局記憶接線（PRD P0-4，2026-09-15）───────────────────────────
// 契約 = MEMORY-INTERFACES.md §3.5/§3.6/§4/§7/§8 + PRD §6。memory-gate/memory-batch/
// memory-recall 三模組已落位且邏輯凍結（單測 50 綠），本檔只接線不動其邏輯。
// 本區內容：注入塊組裝純函式（§4）、批次 deps 與定時器（§3.5/§8）、每回合召回
// prefetch（§7）、三個端點（batch-run / memory-trace / memory-recall）。
// 憑據紀律：MEMORY_INGEST_SECRET 與簽名值永不寫進 log／回應。

// §6.1 預算表：L0 2400、L1 800（system，首回合）；召回前綴 1800 由 renderRecallPrefix
// 自行封頂；合計硬上限 5000（R1 尺可斷言）。
export const MEMORY_L0_BUDGET = 2400
export const MEMORY_L1_BUDGET = 800
export const MEMORY_INJECTION_TOTAL_BUDGET = 5000
export const MEMORY_PRIVATE_DOCS_MAX = 8 // 契約 §4：私有 active docs 注入 ≤8
export const MEMORY_TRUNC_MARK = "（已截斷）" // 契約 §4 截斷標記
export const MEMORY_RECALL_PREFETCH_TTL_MS = 5 * 60 * 1000 // 預取候選保鮮期（§7 prefetch）
export const MEMORY_ASSISTANT_HEAD_CHARS = 200 // §7 query 的 assistant 頭部長度

/**
 * §4 注入文案（用途邊界）：私有記憶只作「方法與偏好」參考，不是本輪創作底稿。
 * 病根：既往作品方案（角色/世界觀/劇情/分鏡）原樣入 prompt，模型對「全新的世界觀、
 * 全新的片」也照樣沿用，創意被舊方案污染。故在私有記憶塊前明寫邊界。
 */
export const MEMORY_PRIVATE_SCOPE_NOTE = [
  "以下过往记忆只作「方法与偏好」参考，不是本轮创作的底稿：",
  "- 用户要全新原创（新世界观、新片、新创意）时，禁止沿用其中任何既有作品的具体内容（角色、设定、剧情、片名、分镜、方案、文案），一律从零创作。",
  "- 只有用户明确点名「沿用 / 延续 / 基于 X」时，才可复用 X 的具体内容。",
  "- 可借用的只有方法：流程、风格配方、参数经验、失败教训。",
].join("\n")

export function clampMemoryChars(text: string, cap: number): string {
  if (text.length <= cap) return text
  return text.slice(0, Math.max(0, cap - MEMORY_TRUNC_MARK.length)) + MEMORY_TRUNC_MARK
}

// ── 新創作閘門（2026-10-01 翻舊賬事故）────────────────────────────────────
// 病根：私有 memory_docs（舊專案 brief/世界觀/分鏡/曲目）每會話無條件注入，召回又按
// 字面把「百合 OP」直配舊專案；模型把「可參考」當成「默認沿用」，用戶要新創意卻拿到舊方案。
// 處置：①偏好類記憶（跨專案通用）照常注入；專案檔案前置複用紀律；②本輪用戶明確要新創意
// → 專案檔案與召回前綴整段不注入，並在本輪 parts 前綴強制「從零構思」指令。
const FRESH_CREATIVE_RE =
  /新(创意|創意|点子|點子|构思|構思|故事|题材|題材|世界观|世界觀|作品|企划|企劃)|全新|原创|原創|从零|從零|另起(炉灶|爐灶)?|重新(设计|設計|构思|構思|想|做一个|做一個)|不要(沿用|参考|參考|照搬|复用|複用|套用)|别(用|抄|套)(之前|以前|旧|舊)|別(用|抄|套)(之前|以前|旧|舊)|from scratch|brand[- ]new|fresh (idea|concept|take)|new (idea|concept|world)/i

export function isFreshCreativeRequest(text: string): boolean {
  return typeof text === "string" && FRESH_CREATIVE_RE.test(text)
}

/** 偏好類記憶（pref-*／preference/user/feedback domain）跨專案通用；其餘視為過往專案/作品檔案。 */
export function isPreferenceMemoryDoc(d: { domain?: unknown; slug?: unknown }): boolean {
  const slug = typeof d.slug === "string" ? d.slug : ""
  const domain = typeof d.domain === "string" ? d.domain : ""
  return /^pref(erence)?[-_]/i.test(slug) || /^(pref|preference|preferences|user|profile|feedback)$/i.test(domain)
}

export const PROJECT_REUSE_RULE =
  "【历史项目档案·复用纪律】下列是过往项目/作品档案，只有用户明确点名续作（提到该片名、角色名，或说『接着做/继续上次』）时才可复用；其余任何新的创作请求都必须从零构思世界观、角色、分镜与曲目，禁止借用或改写其中设定，派发给 expert 的简报也不得夹带这些档案。"

export const FRESH_CREATIVE_TURN_DIRECTIVE =
  "【本轮为全新创作】用户要的是新创意：忽略一切历史项目档案（片名、角色、世界观、分镜、曲目、时长版本），从零构思；只保留账户偏好与通用领域知识。派发给 expert 的简报同样不得引用旧项目。"

/**
 * 契約 §4 注入塊組裝（純函式；PRD §9 R1 注入形狀尺的可測面）：
 * L0 私有塊 = 既有 user_profile/lessons（D2 文案）+ memory_docs（≤8，§4 索引行格式），
 * 2400 字元硬上限，超限截斷尾標「（已截斷）」；
 * L1 共享目錄塊 = memory_index_md，800 字元，末尾帶 memory_recall 使用指引
 * （MEMORY_SHARED_ENABLED=false → 零注入，§8）。
 * 合計 5000 字元為代碼級 assert：單塊封頂後理論不可達（2400+800≤3200），
 * 觸發即不變量被破壞——誠實記 error 並強制截尾，用戶回合不燒。
 */
export function buildMemoryInjectionBlocks(
  userMemory: SessionState["userMemory"],
  sharedEnabled: boolean,
  opts: { freshCreative?: boolean; continuityLines?: string[] } = {},
): { lines: string[]; trace: { private_docs: string[]; shared_index_chars: number } } {
  const l0Parts: string[] = []
  const privateDocs: string[] = []
  if (userMemory) {
    const up = userMemory.user_profile ?? {}
    if (Object.keys(up).length > 0) {
      const fields = Object.entries(up)
        .map(([k, v]) => {
          const val = Array.isArray(v) ? v.join("、") : String(v ?? "")
          return `- ${k}: ${val}`
        })
        .join("\n")
      l0Parts.push(`以下是这个账户已确认的画像（来自之前的会话）：\n${fields}`)
    }
    const lessons = userMemory.lessons ?? []
    if (lessons.length > 0) {
      // D2（PRD §2.2）：舊文案「（已被確認）」屬虛假陳述（生產 0 筆 confirmed），契約 §4 欽定中性文案。
      l0Parts.push(`以下是这个账户从过往合作中提炼的教训（仅供参考，可能已过期，冲突以现场为准）：\n${lessons.map((l) => `- ${l}`).join("\n")}`)
    }
    const docs = Array.isArray(userMemory.memory_docs) ? userMemory.memory_docs.slice(0, MEMORY_PRIVATE_DOCS_MAX) : []
    if (docs.length > 0) l0Parts.push(MEMORY_PRIVATE_SCOPE_NOTE)
    // 偏好在前、專案檔案在後且前置複用紀律：2400 截斷只會吃掉檔案正文尾，不會吃掉紀律。
    const prefDocs = docs.filter((d) => isPreferenceMemoryDoc(d))
    const projectDocs = opts.freshCreative ? [] : docs.filter((d) => !isPreferenceMemoryDoc(d))
    const pushDoc = (d: (typeof docs)[number]) => {
      const domain = typeof d.domain === "string" && d.domain ? d.domain : "general"
      const slug = typeof d.slug === "string" && d.slug ? d.slug : "doc"
      // §4 索引行格式：`- [domain] slug — description` + 正文縮排。
      l0Parts.push(`- [${domain}] ${slug} — ${String(d.description ?? "")}\n   ${String(d.body ?? "")}`)
      privateDocs.push(typeof d.id === "string" && d.id ? d.id : slug)
    }
    prefDocs.forEach(pushDoc)
    if (projectDocs.length > 0) {
      l0Parts.push(PROJECT_REUSE_RULE)
      projectDocs.forEach(pushDoc)
    }
  }
  const lines: string[] = []
  let sharedIndexChars = 0
  if (l0Parts.length > 0) lines.push(clampMemoryChars(l0Parts.join("\n"), MEMORY_L0_BUDGET))
  const indexMd = typeof userMemory?.memory_index_md === "string" ? userMemory.memory_index_md.trim() : ""
  if (sharedEnabled && indexMd) {
    const l1 = clampMemoryChars(
      `以下是本平台积累的领域知识目录（仅供参考，可能已过期，冲突以现场为准）：\n${indexMd}\n（目录只作方法与领域知识参考：用户要全新原创时，不得把其中任一既有作品的具体内容当作可沿用的底稿；用户明确点名沿用某个 slug 时才可读取它的正文。）\n（模型可调用 memory_recall 工具读取全部正文）`,
      MEMORY_L1_BUDGET,
    )
    lines.push(l1)
    sharedIndexChars = l1.length // trace 口徑＝實際注入 L1 塊字元數（預算消耗面）
  }
  // H17：首回合連續性塊（工作區資產索引／同題重下提示）。獨立預算 MEMORY_CONTINUITY_BUDGET，
  // 2400+800+900<5000，不擠壓上面兩塊。呼叫端只在首回合（!state.vettingInjected）傳入。
  if (opts.continuityLines && opts.continuityLines.length > 0) {
    lines.push(clampMemoryChars(opts.continuityLines.join("\n"), MEMORY_CONTINUITY_BUDGET))
  }
  const total = lines.reduce((n, s) => n + s.length, 0)
  if (total > MEMORY_INJECTION_TOTAL_BUDGET) {
    console.error(`[memory-inject] BUDGET ASSERT: total=${total} > ${MEMORY_INJECTION_TOTAL_BUDGET} — force clamp`)
    const kept: string[] = []
    let used = 0
    for (const line of lines) {
      if (used + line.length > MEMORY_INJECTION_TOTAL_BUDGET) break
      kept.push(line)
      used += line.length
    }
    return { lines: kept, trace: { private_docs: privateDocs, shared_index_chars: sharedIndexChars } }
  }
  return { lines, trace: { private_docs: privateDocs, shared_index_chars: sharedIndexChars } }
}


// ── H17 跨會話連續性（機制層；2026-10-02）──────────────────────────────────
// 事故：同題 7 輪/7 小時/165 萬 input token，每輪從零開始、首回合對上一輪產物毫無所知。
// 邊界：不改「新創作禁沿用舊專案」規則——這裡只做兩件事：
//   (a) 首回合列「近期工作區資產索引」（只列清單供參考，明寫新創作不得沿用，除非用戶明說）；
//   (b) 同題重下偵測 → 提示 agent「此題已做過 N 輪，先向用戶說明並確認新方向」。
// 兩者都不自動沿用任何內容。純函式，輸入為 listSessionRows 的行（本檔不碰 DB，易測）。
export const MEMORY_CONTINUITY_BUDGET = 900
export const RECENT_ASSET_WINDOW_MS = 72 * 3600_000
export const RECENT_ASSET_MAX_ITEMS = 10
export const REPEAT_TOPIC_WINDOW_MS = 12 * 3600_000
export const REPEAT_TOPIC_MIN_ROUNDS = 2
export const REPEAT_TOPIC_MIN_SIMILARITY = 0.3

export interface ContinuityRow {
  sessionId: string
  createdAt: number
  updatedAt: number
  data: { title?: string | null; workflowSnapshot?: Record<string, unknown> | undefined }
}

/** 字元二元組 Jaccard（中英通吃、無分詞依賴）。 */
export function topicSimilarity(a: string, b: string): number {
  const grams = (t: string) => {
    const x = t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")
    const out = new Set<string>()
    for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/** 同題重下偵測：窗口內、非本會話、標題與本輪內容相似的會話數 = 已做輪數。 */
export function detectRepeatTopic(
  rows: ContinuityRow[],
  content: string,
  opts: { excludeSessionId?: string; nowMs?: number } = {},
): { rounds: number; titles: string[] } {
  const now = opts.nowMs ?? Date.now()
  const hits = rows.filter((r) => {
    if (r.sessionId === opts.excludeSessionId) return false
    if (now - r.updatedAt > REPEAT_TOPIC_WINDOW_MS) return false
    const title = typeof r.data?.title === "string" ? r.data.title : ""
    return title.length > 0 && topicSimilarity(title, content) >= REPEAT_TOPIC_MIN_SIMILARITY
  })
  return { rounds: hits.length, titles: hits.slice(0, 3).map((r) => String(r.data.title)) }
}

/** 從 workflowSnapshot 抽「已完成且有產物 URL 的節點」→ `標題 → url`。 */
export function extractSnapshotAssets(snap: Record<string, unknown> | undefined): Array<{ title: string; url: string }> {
  if (!snap || typeof snap !== "object") return []
  const status = (snap.nodeStatus ?? {}) as Record<string, unknown>
  const content = (snap.nodeContent ?? {}) as Record<string, unknown>
  const nodes = ((snap.graph as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<Record<string, unknown>>
  const titleOf = new Map<string, string>()
  for (const n of nodes) {
    const id = typeof n?.id === "string" ? n.id : ""
    const t = typeof n?.title === "string" ? n.title : typeof (n?.data as any)?.title === "string" ? (n.data as any).title : ""
    if (id) titleOf.set(id, t)
  }
  const out: Array<{ title: string; url: string }> = []
  for (const [id, v] of Object.entries(content)) {
    if (typeof v !== "string" || !/^https?:\/\//i.test(v.trim())) continue
    const st = status[id]
    if (typeof st === "string" && !/^(done|completed|success|succeeded)$/i.test(st)) continue
    out.push({ title: titleOf.get(id) || id, url: v.trim() })
  }
  return out
}

/** 近期工作區資產索引（72h、≤10 條；只列清單）。無資產 → null。 */
export function buildRecentAssetIndex(
  rows: ContinuityRow[],
  opts: { excludeSessionId?: string; nowMs?: number } = {},
): string | null {
  const now = opts.nowMs ?? Date.now()
  const items: string[] = []
  for (const r of rows) {
    if (r.sessionId === opts.excludeSessionId) continue
    if (now - r.updatedAt > RECENT_ASSET_WINDOW_MS) continue
    const label = typeof r.data?.title === "string" && r.data.title ? r.data.title : r.sessionId.slice(0, 8)
    for (const a of extractSnapshotAssets(r.data?.workflowSnapshot)) {
      if (items.length >= RECENT_ASSET_MAX_ITEMS) break
      items.push(`- [${label}] ${a.title} → ${a.url}`)
    }
    if (items.length >= RECENT_ASSET_MAX_ITEMS) break
  }
  if (items.length === 0) return null
  return [
    "【近期工作区资产索引（仅供参考的清单）】新创作不得沿用下列任何资产，除非用户明说「沿用/延续/基于某项」；这里只让你知道账户里已有什么，不是底稿。",
    ...items,
  ].join("\n")
}

/**
 * 首回合連續性行（buildMemoryInjectionBlocks 的 opts.continuityLines）。
 * 呼叫端（messages-gw.ts，首回合 !state.vettingInjected 時）：
 *   continuityLines = buildFirstTurnContinuityLines(listSessionRows(key), state.sessionId, content)
 */
export function buildFirstTurnContinuityLines(
  rows: ContinuityRow[],
  sessionId: string,
  content: string,
  nowMs?: number,
): string[] {
  const lines: string[] = []
  const rep = detectRepeatTopic(rows, content, { excludeSessionId: sessionId, nowMs })
  if (rep.rounds >= REPEAT_TOPIC_MIN_ROUNDS) {
    lines.push(
      `【同题重下提示】此题近 ${REPEAT_TOPIC_WINDOW_MS / 3600_000} 小时内已做过 ${rep.rounds} 轮（${rep.titles.join("、")}）：先用一两句话向用户说明这一点，并确认本次要的新方向（沿用哪一版、还是全新重做），确认前不要开始大规模生成。不要自行沿用旧轮产物。`,
    )
  }
  const idx = buildRecentAssetIndex(rows, { excludeSessionId: sessionId, nowMs })
  if (idx) lines.push(idx)
  return lines
}

/** §3.6 形狀 trace：首個觀測點（注入或召回命中）落地時建立。 */
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

/** 召回命中寫入 trace.shared_recalled。id 取自 memoryDocIds 旁表（模組 toRecallableDocs 剝 id，不動其邏輯）；缺則以 slug 兜底（偏離點已回報）。 */
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

/** §7 召回輔助：累積本輪 assistant 正文頭部（只需前 200 字元，填滿即停，成本 O(1)）。 */
export function noteAssistantHeadForRecall(state: SessionState, text: string): void {
  if (!text) return
  const cur = state.turnAssistantHead ?? ""
  if (cur.length >= MEMORY_ASSISTANT_HEAD_CHARS) return
  state.turnAssistantHead = (cur + text).slice(0, MEMORY_ASSISTANT_HEAD_CHARS)
}

// ── 召回語料與 prefetch（契約 §3.3/§7）────────────────────────────────────

// export 端點的 id 旁表：CorpusCache 的 toRecallableDocs 只留四欄，trace 需要真 id；
// 在 fetchExport（本檔所有）解析時順手收錄，key=`domain/slug`。有界：超 5000 整表重清
// （CorpusCache TTL 5 分鐘自然全量重拉回填）。
export const memoryDocIds = new Map<string, string>()

/** 簽名 GET export（§3：GET 無 body → 空 bytes 驗簽）。CorpusCache 傳入的 headers 已含同款簽名，這裡按本檔 env 快照重建以明確 fail-fast。 */
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

// 語料 TTL 5 分鐘（§3.3 默認）；secret provider 顯式指向本檔 env 快照。
export const memorySharedCorpus = new CorpusCache(memoryFetchExport, 5 * 60 * 1000, () => MEMORY_INGEST_SECRET)

export interface MemoryRecallPrefetchEntry {
  prefix: string
  docRefs: Array<{ domain: string; slug: string }>
  at: number
}
// prefetch 緩存 Map<sessionId,{prefix,at}>（§7）：5 分鐘 TTL，隨會話銷毀清理（teardownSession）。
export const memoryRecallPrefetch = new Map<string, MemoryRecallPrefetchEntry>()
export const memoryRecallInflight = new Set<string>()

// ── 單 session 召回注入位元組上限（2026-10-02）──────────────────────────────
// 設計取自 Claude Code attachments.ts 的 RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES（60KB）——
// 概念：單回合有上限，但長會話每回合持續注入不同記憶會累積灌爆上下文，故設 session 累計帽。
// 我方實作：模組級 Map<sessionId, 已注入 bytes>，在 takeMemoryRecallPrefix（每次真正注入點）
// 記帳；超限即「降級」——裁到剩餘額度或整段不注入，並以 warn 記 log，絕不拋錯。
// 清理缺口：sessions-core 的 teardownSession 未接此 Map（該檔非本輪所有權），故以
// 有界淘汰自我防漏（超上限條數丟最舊 session；session 重建後計數歸零，語義等同重置）。
export const MEMORY_RECALL_SESSION_BYTE_BUDGET = 60 * 1024 // 60KB（≈3 次滿額注入）
export const MEMORY_RECALL_SESSION_USAGE_MAX = 2000 // Map 條數上限（防跨 session 無界增長）
export const memoryRecallSessionBytes = new Map<string, number>()

/** 本 session 累計已注入的召回位元組。 */
export function memoryRecallSessionUsed(sessionId: string): number {
  return memoryRecallSessionBytes.get(sessionId) ?? 0
}

/** 記帳（有界：超條數丟最舊，Map 保留插入序）。 */
function noteMemoryRecallSessionBytes(sessionId: string, bytes: number): void {
  memoryRecallSessionBytes.set(sessionId, bytes)
  if (memoryRecallSessionBytes.size > MEMORY_RECALL_SESSION_USAGE_MAX) {
    const oldest = memoryRecallSessionBytes.keys().next().value
    if (oldest !== undefined) memoryRecallSessionBytes.delete(oldest)
  }
}

/** 歸零某 session 的累計（供 teardown 或壓縮後重置；目前未接呼叫端）。 */
export function resetMemoryRecallSessionUsage(sessionId: string): void {
  memoryRecallSessionBytes.delete(sessionId)
}

export function memoryRecallActive(): boolean {
  return MEMORY_RECALL_ENABLED && MEMORY_SHARED_ENABLED
}

/**
 * 回合開始取預取候選（讀即棄：回合結束重算，防舊候選殭屍注入）。null=miss → 本回合不注入、異步補算。
 * 2026-10-02：此處即真正注入點，落實 session 累計位元組帽（超限降級不報錯）。
 */
export function takeMemoryRecallPrefix(sessionId: string): MemoryRecallPrefetchEntry | null {
  if (!memoryRecallActive()) return null
  const rec = memoryRecallPrefetch.get(sessionId)
  if (!rec) return null
  memoryRecallPrefetch.delete(sessionId)
  if (Date.now() - rec.at > MEMORY_RECALL_PREFETCH_TTL_MS) return null
  if (!rec.prefix) return rec
  const used = memoryRecallSessionUsed(sessionId)
  const remaining = MEMORY_RECALL_SESSION_BYTE_BUDGET - used
  const bytes = utf8ByteLength(rec.prefix)
  if (remaining <= 0) {
    console.warn(
      `[memory-recall] session byte budget exhausted session=${sessionId} used=${used}/${MEMORY_RECALL_SESSION_BYTE_BUDGET} — skip injection`,
    )
    return { ...rec, prefix: "" }
  }
  if (bytes > remaining) {
    const clipped = clipToUtf8Bytes(rec.prefix, remaining)
    console.warn(
      `[memory-recall] session byte budget exceeded session=${sessionId} prefix=${bytes}B remaining=${remaining}B — degraded to ${utf8ByteLength(clipped)}B`,
    )
    noteMemoryRecallSessionBytes(sessionId, used + utf8ByteLength(clipped))
    return { ...rec, prefix: clipped }
  }
  noteMemoryRecallSessionBytes(sessionId, used + bytes)
  return rec
}

/** §7 prefetch：上一回合 session.idle 後台算好 top-3 候選（用戶路徑零新增延遲）。 */
export async function scheduleMemoryRecallPrefetch(state: SessionState): Promise<void> {
  if (!memoryRecallActive()) return
  if (memoryRecallInflight.has(state.sessionId)) return
  memoryRecallInflight.add(state.sessionId)
  try {
    const query = buildRecallQuery(state.lastUserMessage ?? "", state.turnAssistantHead ?? "")
    const docs = await memorySharedCorpus.get("shared")
    // 上限可設定（env MEMORY_RECALL_K）且一律夾 ≤ RECALL_K_MAX；預設維持 §7 產品決策 top-3。
    const k = clampRecallK(process.env.MEMORY_RECALL_K, RECALL_K_DEFAULT)
    const hits = recallTop(query, docs, { minScore: MEMORY_RECALL_MIN_SCORE, k })
    memoryRecallPrefetch.set(state.sessionId, {
      prefix: renderRecallPrefix(hits.map((h) => h.doc)),
      docRefs: hits.map((h) => ({ domain: h.doc.domain, slug: h.doc.slug })),
      at: Date.now(),
    })
  } catch (e) {
    // 失敗是常態（secret 未配／端點未上線），不刷 log；debug 級可查。
    console.debug(`[memory-recall] prefetch failed session=${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    memoryRecallInflight.delete(state.sessionId)
  }
}

// ── 批次接線（契約 §3.5/§8；輪子表 §10）──────────────────────────────────

// PRD §5.2 條件③：知識型（外部信息攝入）工具集，排序加權用。
export const KNOWLEDGE_TOOL_NAMES = new Set(["search_web", "vision_analyze", "asset_search", "image_get_result"])

/** transcriptOf：複用 handleTranscript 的 fetch 形狀（opencode GET /session/:id/message），渲染成純文本。 */
export async function memoryTranscriptOf(opencodeSessionId: string): Promise<string> {
  const res = await opencodeFetch(`/session/${encodeURIComponent(opencodeSessionId)}/message`, {
    timeoutMs: 10_000,
  })
  if (!res.ok) throw new Error(`memory transcript fetch HTTP ${res.status}`)
  const msgs = (await res.json()) as Array<Record<string, any>>
  const lines: string[] = []
  for (const m of Array.isArray(msgs) ? msgs.slice(-200) : []) {
    const role = m?.info?.role === "user" ? "user" : "assistant"
    for (const p of Array.isArray(m?.parts) ? m.parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
        lines.push(`${role}: ${p.text.trim()}`)
      } else if (p?.type === "tool" && typeof p.tool === "string") {
        const status = typeof p?.state?.status === "string" ? p.state.status : "unknown"
        lines.push(`${role} [tool ${p.tool} ${status}]`)
      }
    }
  }
  const transcript = lines.join("\n")
  // 上限比照輪子 100k 量級再收斂（curator 輸入面）；超長取尾——最近回合最有價值。
  return transcript.length > 60_000 ? transcript.slice(-60_000) : transcript
}

/** 逐會話訊息計數（PRD §5.2 條件②③）。失敗＝計不出 → 全 0，篩選自然放棄。 */
export async function memorySessionCounts(
  opencodeSessionId: string,
): Promise<{ userMessages: number; successfulToolCalls: number; knowledgeToolCalls: number }> {
  let userMessages = 0
  let successfulToolCalls = 0
  let knowledgeToolCalls = 0
  try {
    const res = await opencodeFetch(`/session/${encodeURIComponent(opencodeSessionId)}/message`, {
      timeoutMs: 10_000,
    })
    if (!res.ok) return { userMessages: 0, successfulToolCalls: 0, knowledgeToolCalls: 0 }
    const msgs = (await res.json()) as Array<Record<string, any>>
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (m?.info?.role === "user") userMessages += 1
      for (const p of Array.isArray(m?.parts) ? m.parts : []) {
        if (p?.type === "tool" && p?.state?.status === "completed") {
          successfulToolCalls += 1
          if (KNOWLEDGE_TOOL_NAMES.has(String(p.tool ?? ""))) knowledgeToolCalls += 1
        }
      }
    }
  } catch {
    return { userMessages: 0, successfulToolCalls: 0, knowledgeToolCalls: 0 }
  }
  return { userMessages, successfulToolCalls, knowledgeToolCalls }
}

/** listSessions：loopback GET /session（opencode 目錄）＋ sessions.db 反查 ownerKey（hashKey 同算法）。 */
export async function memoryListSessions(): Promise<MemorySessionRecord[]> {
  const res = await opencodeFetch(`/session`, {
    timeoutMs: 10_000,
  })
  if (!res.ok) throw new Error(`memory listSessions HTTP ${res.status}`)
  const dir = (await res.json()) as Array<Record<string, any>>
  const nowMs = Date.now()
  const out: MemorySessionRecord[] = []
  const needCounts: MemorySessionRecord[] = []
  for (const s of Array.isArray(dir) ? dir : []) {
    const id = typeof s?.id === "string" ? s.id : ""
    if (!id) continue
    const parentId = typeof s?.parentID === "string" && s.parentID ? s.parentID : null
    const time = s?.time as { created?: number; updated?: number } | undefined
    const updatedAt =
      typeof time?.updated === "number" ? time.updated : typeof time?.created === "number" ? time.created : undefined
    const rec: MemorySessionRecord = { id, parentId, updatedAt }
    try {
      const row = loadSessionByOpencodeId(id) // 只讀 DB row，不走 findSessionByOpenCodeId（那會把會話殭屍復活進內存）
      if (row?.apiKey) rec.ownerKey = await hashKey(row.apiKey)
    } catch {
      /* ownerKey 缺失 → private 無處安放（批次按 g4_no_owner 記帳） */
    }
    // 計數只補非 subagent 且 48 小時內（UTC）有動的會話：批次條件②的門檻篩選需要計數，
    // 更舊的計數缺也過不了門檻——避免全目錄逐會話 message GET（R5 尺：批次窗口不擠壓主對話）。
    // 手動指定 session_ids 重跑不依賴計數（批次在該路徑不看門檻）。
    if (!parentId && typeof updatedAt === "number" && nowMs - updatedAt <= 48 * 3600_000) {
      needCounts.push(rec)
    }
    out.push(rec)
  }
  // 併發上限 4：背景計算，讓主鏈路先走。
  for (let i = 0; i < needCounts.length; i += 4) {
    const chunk = needCounts.slice(i, i + 4)
    const counts = await Promise.all(chunk.map((r) => memorySessionCounts(r.id)))
    chunk.forEach((r, j) => {
      r.userMessages = counts[j].userMessages
      r.successfulToolCalls = counts[j].successfulToolCalls
      r.knowledgeToolCalls = counts[j].knowledgeToolCalls
    })
  }
  return out
}

/** callLlm = handleExtractLessons 三段骨架逐行複製（契約 §10 輪子表）。白名單：prompt 直傳、超時 120s→180s、函式名／回傳純文本；模型與通道同輪子常量（不帶 model 欄，opencode 默認路由）。 */
export async function memoryCallLlm(prompt: string): Promise<string> {
  // 一次性 opencode session（與對話 pool 無關），同步取結果後即刪。
  let session: { id?: string }
  try {
    const res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await opencodeFetch(`/session/${opencodeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      timeoutMs: 180000, // 白名單改動：curator 全文輸入，窗口放寬到 180s
    })
    if (!res.ok) throw new Error(`opencode curator call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await opencodeFetch(`/session/${opencodeSessionId}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => {})
  }
}

/** ingest/review 送出（§3.1/§3.2＋P1-1 review 端點，同一 HMAC 簽名通道）。headers 由 memory-batch 按「將送出的精確 raw bytes」算好簽名傳入，這裡防衛性重簽同一串（同算法同值）；非 2xx throw（批次落 pending 指數退避）。 */
export async function memoryPostIngest(
  pathOnly: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  if (!MEMORY_INGEST_SECRET) throw new Error("MEMORY_INGEST_SECRET 未配置")
  const res = await fetch(`${MEMORY_INGEST_BASE_URL}${pathOnly}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
      [MEMORY_SIGNATURE_HEADER]: signMemoryBytes(rawBody, MEMORY_INGEST_SECRET),
    },
    body: rawBody, // 原樣位元組串，嚴禁重新序列化（簽名即失效）
    signal: AbortSignal.timeout(30_000),
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 回應 → null；成敗以 status 為準 */
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`memory ingest HTTP ${res.status}`)
  return { status: res.status, json }
}

/**
 * verifier/oracle 一次性 LLM 呼叫＝memoryCallLlm 三段骨架逐行複製（契約 §10 輪子表）。
 * 白名單改動：① 簽名加 model 參數（G8/抽檢「換模型」）；② message body 附
 * `model: {providerID, modelID}`（既有輪走 opencode 默認路由，此輪必須指定另一模型），
 * 字串以 bindingRef 解析 `provider/model`，解析不了即 throw（fail-fast 誠實報錯）；
 * ③ 錯誤訊息以 label 區分。通道與超時同輪子（建/刪 10s、呼叫 180s）。
 */
export async function memoryCallLlmWithModel(prompt: string, model: string, label: string): Promise<string> {
  const ref = bindingRef(model)
  if (!ref) throw new Error(`memory ${label}: invalid model ref (expect provider/model)`)
  // 一次性 opencode session（與對話 pool 無關），同步取結果後即刪。
  let session: { id?: string }
  try {
    const res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await opencodeFetch(`/session/${opencodeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
        model: { providerID: ref.providerID, modelID: ref.modelID },
      }),
      timeoutMs: 180000, // 白名單改動：curator 全文輸入，窗口放寬到 180s
    })
    if (!res.ok) throw new Error(`opencode ${label} call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await opencodeFetch(`/session/${opencodeSessionId}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => {})
  }
}

export const memoryBatch = createMemoryBatch({
  listSessions: memoryListSessions,
  transcriptOf: memoryTranscriptOf,
  callLlm: memoryCallLlm,
  callVerifierLlm: (prompt, model) => memoryCallLlmWithModel(prompt, model, "verifier"),
  callOracleLlm: (prompt, model) => memoryCallLlmWithModel(prompt, model, "oracle"),
  postIngest: memoryPostIngest,
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

/** §3.5 手動批次觸發（過 isLoopback 門後進入）。body {dry_run, session_ids, date} 透傳 runBatch，回 §3.5 報告形狀。 */
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
    // runBatch 的拒絕原因（總開關未開／參數非法）原樣透傳——誠實報錯，不造假 200。
    const msg = e instanceof Error ? e.message : String(e)
    return jsonError(409, `memory batch failed: ${msg}`, "memory_batch_failed", "memory_batch_failed")
  }
}

/** §3.6 注入 trace（R2 尺觀測點）。尚無 trace（未注入／重啟丟失）→ 空形狀、injected_at=null。 */
export async function handleMemoryTrace(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  return Response.json(
    state.memoryTrace ?? { private_docs: [], shared_recalled: [], shared_index_chars: 0, injected_at: null },
  )
}

/**
 * memory_recall 工具後端（PRD §6.2；【契約外新增路由】，已隨本片回報）。
 * 從共享語料跑 §7 召回，回 {results:[{doc:{slug,domain,description,body},score}],count}。
 * limit 默認 3（§7）、上限 RECALL_K_MAX=5（2026-10-02 收緊，原 10；對齊工具層
 * memory_recall_impl 的「默認 3、帽值 5」與 Claude Code 每次查詢最多 5 條的設計概念）；
 * minScore=MEMORY_RECALL_MIN_SCORE；共享關 → 空 results。
 */
export async function handleMemoryRecallSearch(key: string, req: Request): Promise<Response> {
  void key // 同族鑑權口徑：Bearer 閘門已在上游驗過，此端點無 session 維度，不需 key 數據面
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
  const k = clampRecallK(body.limit, RECALL_K_DEFAULT)
  const hits = recallTop(query, docs, { minScore: MEMORY_RECALL_MIN_SCORE, k })
  const results = hits.slice(0, RECALL_K_MAX).map((h) => ({
    doc: { slug: h.doc.slug, domain: h.doc.domain, description: h.doc.description, body: h.doc.body },
    score: h.score,
  }))
  // 工具端 memory_recall_impl 解析 body.results ?? body.docs（頂層陣列=直接拋 upstream_bad_response）
  // 不變量：results.length ≤ RECALL_K_MAX（recallTop 已夾帽，此處再 slice 兜底防未來改動漏接）。
  return Response.json({ results, count: results.length })
}

// ── 批次 ticker（60s；輪子＝本檔既有 setInterval 寫法）─────────────────────
// 條件（§8）：MEMORY_BATCH_ENABLED && UTC 時 == MEMORY_BATCH_HOUR_UTC && 游標日期<今日。
// 「游標日期」以進程內 volatile 閘實裝＝最近一次批次嘗試日的 UTC 日期：memory-batch 的
// 游標檔只有會話維度去重、未暴露批次日期維度；嘗試即置位防同小時 60 連發，失敗當日由
// 運維經 POST /internal/memory/batch-run 手動重跑。每 tick 順帶 drainPending()
// （pending 重發指數退避；無 pending 檔時 noop，總開關 off 也照跑——殘留檔要有人收）。
export let memoryBatchLastRunDate = ""
// H17 批次時機最小修法：原先「每日單一 UTC 時（預設 20h＝台北 04:00）」→ 當日產物結構上不可能可用。
// 改為可配多個 UTC 時窗（env MEMORY_BATCH_EXTRA_HOURS_UTC，如 "2,8,14"；預設空＝行為不變），
// 閘門由「日期」改為「日期+小時」key，同小時仍只跑一次。純函式便於單測。
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
        `[memory-batch] scheduled batch done: batch=${report.batch_id} candidates=${report.candidates} passed=${report.passed} stored=${report.stored}`,
      )
    } catch (e) {
      console.error(`[memory-batch] scheduled batch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })()
}, 60_000)