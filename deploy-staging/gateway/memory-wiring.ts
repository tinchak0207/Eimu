// index.ts 行區 6871–7413 機械抽取（Wave3，2026-09-19）：全局記憶接線（PRD P0-4）——
// 預算常量、注入塊組裝、trace 三件、召回 prefetch、批次 deps 與 ticker、三個內部端點。
// 逐行搬運自 /home/lenovo/Desktop/image-app/deploy-staging/gateway/index.ts，僅加 export 前綴＋本檔頭＋單行 import。
// 注意：memoryBatch 單例與 ticker setInterval 是模組級副作用，原樣搬運（載入即生效）。
import { CorpusCache, recallTop, buildRecallQuery, renderRecallPrefix, type RecallableDoc } from "./memory-recall"
import { MEMORY_SIGNATURE_HEADER, signMemoryBytes, signEmptyMemoryBody, createMemoryBatch, type MemorySessionRecord } from "./memory-batch"
import { MEMORY_INGEST_SECRET, MEMORY_INGEST_BASE_URL, MEMORY_BATCH_ENABLED, MEMORY_BATCH_HOUR_UTC, MEMORY_SHARED_ENABLED, MEMORY_RECALL_MIN_SCORE, MEMORY_RECALL_ENABLED, MEMORY_VERIFIER_MODEL, MEMORY_ORACLE_MODEL } from "./constants-gateway"
import { bindingRef } from "./model-registry"
import { getOwnedSession } from "./sessions-core"
import { loadSessionByOpencodeId } from "./persistence"
import { opencodeHeaders } from "./opencode-client"
import { OPENCODE_URL } from "./constants-gateway"
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

export function clampMemoryChars(text: string, cap: number): string {
  if (text.length <= cap) return text
  return text.slice(0, Math.max(0, cap - MEMORY_TRUNC_MARK.length)) + MEMORY_TRUNC_MARK
}

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
    for (const d of docs) {
      const domain = typeof d.domain === "string" && d.domain ? d.domain : "general"
      const slug = typeof d.slug === "string" && d.slug ? d.slug : "doc"
      // §4 索引行格式：`- [domain] slug — description` + 正文縮排。
      l0Parts.push(`- [${domain}] ${slug} — ${String(d.description ?? "")}\n   ${String(d.body ?? "")}`)
      privateDocs.push(typeof d.id === "string" && d.id ? d.id : slug)
    }
  }
  const lines: string[] = []
  let sharedIndexChars = 0
  if (l0Parts.length > 0) lines.push(clampMemoryChars(l0Parts.join("\n"), MEMORY_L0_BUDGET))
  const indexMd = typeof userMemory?.memory_index_md === "string" ? userMemory.memory_index_md.trim() : ""
  if (sharedEnabled && indexMd) {
    const l1 = clampMemoryChars(
      `以下是本平台积累的领域知识目录（仅供参考，可能已过期，冲突以现场为准）：\n${indexMd}\n（模型可调用 memory_recall 工具读取全部正文）`,
      MEMORY_L1_BUDGET,
    )
    lines.push(l1)
    sharedIndexChars = l1.length // trace 口徑＝實際注入 L1 塊字元數（預算消耗面）
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

export function memoryRecallActive(): boolean {
  return MEMORY_RECALL_ENABLED && MEMORY_SHARED_ENABLED
}

/** 回合開始取預取候選（讀即棄：回合結束重算，防舊候選殭屍注入）。null=miss → 本回合不注入、異步補算。 */
export function takeMemoryRecallPrefix(sessionId: string): MemoryRecallPrefetchEntry | null {
  if (!memoryRecallActive()) return null
  const rec = memoryRecallPrefetch.get(sessionId)
  if (!rec) return null
  memoryRecallPrefetch.delete(sessionId)
  if (Date.now() - rec.at > MEMORY_RECALL_PREFETCH_TTL_MS) return null
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
    const hits = recallTop(query, docs, { minScore: MEMORY_RECALL_MIN_SCORE }) // top-3 = BM25_DEFAULT_K 默認（§7）
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
  const res = await fetch(`${OPENCODE_URL}/session/${encodeURIComponent(opencodeSessionId)}/message`, {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(10_000),
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
    const res = await fetch(`${OPENCODE_URL}/session/${encodeURIComponent(opencodeSessionId)}/message`, {
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10_000),
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
  const res = await fetch(`${OPENCODE_URL}/session`, {
    headers: opencodeHeaders(),
    signal: AbortSignal.timeout(10_000),
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
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      signal: AbortSignal.timeout(180000), // 白名單改動：curator 全文輸入，窗口放寬到 180s
    })
    if (!res.ok) throw new Error(`opencode curator call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
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
    const res = await fetch(`${OPENCODE_URL}/session`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}/message`, {
      method: "POST",
      headers: opencodeHeaders(),
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
        model: { providerID: ref.providerID, modelID: ref.modelID },
      }),
      signal: AbortSignal.timeout(180000), // 白名單改動：curator 全文輸入，窗口放寬到 180s
    })
    if (!res.ok) throw new Error(`opencode ${label} call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await fetch(`${OPENCODE_URL}/session/${opencodeSessionId}`, {
      method: "DELETE",
      headers: opencodeHeaders(),
      signal: AbortSignal.timeout(10000),
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
 * limit 默認 5、上限 10；minScore=MEMORY_RECALL_MIN_SCORE；共享關 → 空 results。
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
  const k = Math.min(Math.max(Number.parseInt(String(body.limit ?? ""), 10) || 5, 1), 10)
  const hits = recallTop(query, docs, { minScore: MEMORY_RECALL_MIN_SCORE, k })
  const results = hits.map((h) => ({
    doc: { slug: h.doc.slug, domain: h.doc.domain, description: h.doc.description, body: h.doc.body },
    score: h.score,
  }))
  // 工具端 memory_recall_impl 解析 body.results ?? body.docs（頂層陣列=直接拋 upstream_bad_response）
  return Response.json({ results, count: results.length })
}

// ── 批次 ticker（60s；輪子＝本檔既有 setInterval 寫法）─────────────────────
// 條件（§8）：MEMORY_BATCH_ENABLED && UTC 時 == MEMORY_BATCH_HOUR_UTC && 游標日期<今日。
// 「游標日期」以進程內 volatile 閘實裝＝最近一次批次嘗試日的 UTC 日期：memory-batch 的
// 游標檔只有會話維度去重、未暴露批次日期維度；嘗試即置位防同小時 60 連發，失敗當日由
// 運維經 POST /internal/memory/batch-run 手動重跑。每 tick 順帶 drainPending()
// （pending 重發指數退避；無 pending 檔時 noop，總開關 off 也照跑——殘留檔要有人收）。
export let memoryBatchLastRunDate = ""
setInterval(() => {
  void (async () => {
    try {
      await memoryBatch.drainPending()
    } catch (e) {
      console.error(`[memory-batch] drain tick failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!MEMORY_BATCH_ENABLED) return
    const now = new Date()
    if (now.getUTCHours() !== MEMORY_BATCH_HOUR_UTC) return
    const today = now.toISOString().slice(0, 10)
    if (memoryBatchLastRunDate >= today) return
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