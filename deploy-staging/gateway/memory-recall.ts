/**
 * memory-recall.ts — 契約 §7 召回算法（P0 零依賴，不建向量庫）＋ §3.3/§3.4 語料快取。
 *
 * 鐵律：token 化函式與 repo 側 `src/lib/agent-memory-store.ts` 的 `memoryTokens`
 * 逐行同構（演算法兩側必須一致，否則 Jaccard/BM25 漂移），改一側必改另一側。
 * 禁止 import 倉庫 src/（gateway 獨立 bundle）。
 *
 * 簽名演算法真源在 `./memory-batch.ts`（逐字比照 src/lib/memory-hmac.ts），
 * 本檔只組「對空 bytes 驗簽」的 GET 頭（§3：export 沒有 body）。
 */
import { MEMORY_SIGNATURE_HEADER, signEmptyMemoryBody } from "./memory-batch.ts"

export interface RecallableDoc {
  domain: string
  slug: string
  description: string
  body: string
}

// ─────────────────────────── token 化
// 逐行複製自 src/lib/agent-memory-store.ts `memoryTokens`（同名同體，白名單改動＝無）。
/** token 化：ASCII 词按空白+标点切；CJK 按 bigram。 */
export function memoryTokens(text: string): string[] {
  const source = String(text ?? "");
  const tokens: string[] = [];
  tokens.push(...(source.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  const runs =
    source.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(`${chars[i]}${chars[i + 1]}`);
  }
  return tokens;
}

// ─────────────────────────── BM25 變體（契約 §7：k1=1.2, b=0.75；description ×2.0、body ×1.0、domain ×1.5）

export const BM25_K1 = 1.2
export const BM25_B = 0.75
export const BM25_DEFAULT_MIN_SCORE = 1.0 // MEMORY_RECALL_MIN_SCORE 默認（§7/§8）
export const BM25_DEFAULT_K = 3 // top-3（§4/§7）

const RECALL_FIELDS: ReadonlyArray<{ key: keyof RecallableDoc; weight: number }> = [
  { key: "description", weight: 2.0 },
  { key: "body", weight: 1.0 },
  { key: "domain", weight: 1.5 },
]

interface FieldCorpus {
  tokens: string[][]
  df: Map<string, number>
  avgdl: number
}

function buildFieldCorpus(docs: RecallableDoc[], key: keyof RecallableDoc): FieldCorpus {
  const tokens = docs.map((d) => memoryTokens(String(d[key] ?? "")))
  const df = new Map<string, number>()
  let total = 0
  for (const list of tokens) {
    total += list.length
    for (const uniq of new Set(list)) df.set(uniq, (df.get(uniq) ?? 0) + 1)
  }
  return { tokens, df, avgdl: docs.length > 0 ? total / docs.length : 0 }
}

/**
 * 對每份文件算 BM25 變體分（多欄位加權求和），回傳與 docs 等長、同序的分數陣列。
 * idf = ln(1 + (N - n + 0.5) / (n + 0.5))；tf 歸一 k1=1.2, b=0.75。
 */
export function bm25Score(query: string, docs: RecallableDoc[]): number[] {
  const scores = new Array<number>(docs.length).fill(0)
  if (docs.length === 0) return scores
  const queryTokens = [...new Set(memoryTokens(query))]
  if (queryTokens.length === 0) return scores
  for (const field of RECALL_FIELDS) {
    const corpus = buildFieldCorpus(docs, field.key)
    const avgdl = corpus.avgdl > 0 ? corpus.avgdl : 1
    for (const token of queryTokens) {
      const n = corpus.df.get(token) ?? 0
      if (n === 0) continue
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      for (let i = 0; i < docs.length; i += 1) {
        const docTokens = corpus.tokens[i]
        if (docTokens.length === 0) continue
        let tf = 0
        for (const t of docTokens) if (t === token) tf += 1
        if (tf === 0) continue
        const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docTokens.length / avgdl))
        scores[i] += field.weight * idf * ((tf * (BM25_K1 + 1)) / norm)
      }
    }
  }
  return scores
}

export interface RecallHit {
  doc: RecallableDoc
  score: number
}

/** 取 top-k（默認 3），分數 < minScore（默認 1.0）不注入（§7）。 */
export function recallTop(
  query: string,
  docs: RecallableDoc[],
  options: { minScore?: number; k?: number } = {},
): RecallHit[] {
  const minScore = Number.isFinite(options.minScore) ? (options.minScore as number) : BM25_DEFAULT_MIN_SCORE
  const k = Number.isFinite(options.k) && (options.k as number) > 0 ? (options.k as number) : BM25_DEFAULT_K
  if (docs.length === 0) return []
  const scores = bm25Score(query, docs)
  return docs
    .map((doc, i) => ({ doc, score: scores[i] }))
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/** §7 query 形狀：本回合用戶消息前 200 字元 + 上一輪 assistant 文本前 200 字元。 */
export function buildRecallQuery(userText: string, lastAssistantText?: string | null): string {
  const head = String(userText ?? "").slice(0, 200)
  const tail = String(lastAssistantText ?? "").slice(0, 200)
  return tail ? `${head}\n${tail}` : head
}

// ─────────────────────────── 注入前綴（契約 §4「每回合召回」塊）

export const RECALL_PREFIX_CAP = 1800
const RECALL_HEADER = "[相關領域知識（供參考，衝突以現場為準）]"

/**
 * 渲染召回前綴：
 * ```
 * [相關領域知識（供參考，衝突以現場為準）]
 * - [domain] slug
 *   body
 * ```
 * 總長 ≤1800 字元，超出即截斷（整段裝不下就按剩餘額度截本段後停止）。空語料回空字串（呼叫端不注入）。
 */
export function renderRecallPrefix(docs: RecallableDoc[]): string {
  if (!Array.isArray(docs) || docs.length === 0) return ""
  let out = `${RECALL_HEADER}\n`
  for (const d of docs) {
    if (!d || out.length >= RECALL_PREFIX_CAP) break
    const segment = `- [${d.domain}] ${d.slug}\n  ${d.body}\n`
    const budget = RECALL_PREFIX_CAP - out.length
    if (segment.length <= budget) {
      out += segment
    } else {
      out += segment.slice(0, budget)
      break
    }
  }
  return out.length <= RECALL_PREFIX_CAP ? out : out.slice(0, RECALL_PREFIX_CAP)
}

// ─────────────────────────── 語料快取（TTL 5 分鐘默認，§3.3/§3.4）

export type ExportFetcher = (pathWithQuery: string, headers: Record<string, string>) => Promise<unknown>

/** export 端點路徑（GET 沒有 body → 空 bytes 驗簽）。 */
export function buildExportPath(scope: "shared" | "private", ownerKey?: string): string {
  if (scope === "private") {
    return `/api/agent/memory/export?scope=private&owner_key=${encodeURIComponent(String(ownerKey ?? ""))}`
  }
  return "/api/agent/memory/export?scope=shared"
}

interface CacheSlot {
  expiresAt: number
  docs: RecallableDoc[]
  inflight?: Promise<RecallableDoc[]>
}

function toRecallableDocs(payload: unknown): RecallableDoc[] {
  const list = (payload as { docs?: unknown })?.docs
  if (!Array.isArray(list)) return []
  const out: RecallableDoc[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue
    const d = raw as Record<string, unknown>
    // 只取召回需要欄位；非字串一律丟棄該條（防髒數據炸渲染）。
    if (
      typeof d.domain === "string" &&
      typeof d.slug === "string" &&
      typeof d.description === "string" &&
      typeof d.body === "string"
    ) {
      out.push({ domain: d.domain, slug: d.slug, description: d.description, body: d.body })
    }
  }
  return out
}

/**
 * 經簽名 GET 拉 export 的 TTL 快取（召回語料 + 共享索引）。
 * fetchExport 由 wiring 注入（對 BASE_URL 發 GET 並回傳解析後 JSON），
 * headers 參數即本檔按 §3 演算法算好的簽名頭（空 bytes 簽名）。
 */
export class CorpusCache {
  private readonly slots = new Map<string, CacheSlot>()

  constructor(
    private readonly fetchExport: ExportFetcher,
    private readonly ttlMs: number = 300_000,
    /** HMAC 密鑰提供者；默認即時讀 env（wiring 場景）。測試注入固定值。 */
    private readonly secret: () => string = () => process.env.MEMORY_INGEST_SECRET?.trim() ?? "",
  ) {}

  async get(scope: "shared" | "private", ownerKey?: string): Promise<RecallableDoc[]> {
    if (scope === "private" && !ownerKey) return []
    const path = buildExportPath(scope, ownerKey)
    const key = `${scope}:${scope === "private" ? ownerKey : ""}`
    const nowMs = Date.now()
    const slot = this.slots.get(key)
    if (slot && slot.expiresAt > nowMs) return slot.docs
    if (slot?.inflight) return slot.inflight

    const inflight = (async (): Promise<RecallableDoc[]> => {
      const signature = signEmptyMemoryBody(this.secret())
      const payload = await this.fetchExport(path, { [MEMORY_SIGNATURE_HEADER]: signature })
      const docs = toRecallableDocs(payload)
      this.slots.set(key, { expiresAt: Date.now() + this.ttlMs, docs })
      return docs
    })()
    this.slots.set(key, {
      expiresAt: slot && slot.expiresAt > nowMs ? slot.expiresAt : 0, // 舊值過期或無：0；inflight 完成後覆寫
      docs: slot?.docs ?? [],
      inflight,
    })
    try {
      return await inflight
    } catch (err) {
      this.slots.delete(key) // 失敗不種髒快取：下個呼叫重拉。
      throw err
    }
  }

  invalidate(): void {
    this.slots.clear()
  }
}
