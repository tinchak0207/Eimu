/**
 * memory-batch.ts — VPS gateway 側批次器（契約 §3.1/§6/§8；PRD §5.2）。
 *
 * 依賴注入、可單測：index.ts 接線（opencode 一次性 session、/internal 路由、
 * 定時器、sk-biz hashKey 適配）由後續片執行，本檔只匯出 `createMemoryBatch(deps)`。
 *
 * 【本地決定 — 契約 §2 路徑表之外的唯一例外（2026-09-15 本片簽字）】
 * 契約 §2 把 cursor/pending/batches 都列在 blob 路徑（`agent-memory/cursor.json`
 * 等），但契約 §0 實測「VPS .env 沒有 IMAGE_DATA_*，gateway 不能直讀寫 blob」。
 * 故批次狀態一律落 gateway 進程本地檔（stateDir 旁，無憑證、可審計）：
 *   - 游標      `memory-cursor.json`
 *   - 待重試    `memory-pending/{batch_id}.json`
 *   - 死信      `memory-failed/{batch_id}.json`（attempts≥5，記日誌不含正文）
 *   - 批次報告  `memory-batches/{batch_id}.json`（鏡像 §2 batches 路徑語義）
 * 真正的存儲權威寫入仍只經 HMAC 端點（§3），本檔不碰 blob。
 */
import { createHmac } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import {
  applyMemoryGates,
  stripJsonFence,
  type AgentMemoryDocInput,
  type CuratorCandidate,
  type GateContext,
} from "./memory-gate.ts"

// ─────────────────────────── HMAC 簽名工具（逐字比照 src/lib/memory-hmac.ts，契約 §3）
// 為什麼按 raw body bytes 驗簽：gateway 簽的是它送出的那串位元組；repo 端一律
// `await req.arrayBuffer()` 取原始位元組再算。GET（export）沒有 body → 對「空 bytes」驗簽。
// 憑據紀律：密鑰與簽名值永不寫進 log／回應／記憶檔。

export const MEMORY_SIGNATURE_HEADER = "x-memory-signature"

const SIGNATURE_PREFIX = "sha256="

/** 產生 `sha256=<hex>` 簽名（核心演算法逐字等同 repo 版 signMemoryBody）。 */
export function signMemoryBody(rawBody: ArrayBuffer, secret: string): string {
  const digest = createHmac("sha256", secret).update(new Uint8Array(rawBody)).digest("hex")
  return `${SIGNATURE_PREFIX}${digest}`
}

/** gateway 包裝：string/Uint8Array → 將送出的 raw bytes → 簽名頭值。 */
export function signMemoryBytes(raw: string | Uint8Array, secret: string): string {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return signMemoryBody(buffer, secret)
}

/** 簽名 GET 用的空 bytes 簽名（§3.3/3.4 召回語料拉取同此演算法）。 */
export function signEmptyMemoryBody(secret: string): string {
  return signMemoryBytes(new Uint8Array(0), secret)
}

// ─────────────────────────── 契約 §6 prompt（唯一真源，逐字，promptVersion="v1"）

export const MEMORY_PROMPT_VERSION = "v1"

export const CURATOR_PROMPT_V1 = `You are the memory curator for an AI image/video generation assistant.
Input: one conversation transcript. Output: a single JSON object. Nothing else.

You may propose memories of two scopes:
- "private": facts about THIS user that help future sessions serve them (preferences, specs, recurring corrections, working habits). Only these may be private.
- "shared": transferable DOMAIN KNOWLEDGE that any user of this product could benefit from - narrative structures, visual styles, cultural context, prompt techniques, industry conventions, domain facts learned from tool results. It MUST NOT contain anything identifying this user or this conversation.

HARD RULES - a proposal violating any of these is discarded downstream by the system:
- Every proposal MUST cite external evidence: a tool result, an explicit user confirmation, or a verbatim quote. Your own reasoning, inference, or pre-existing general knowledge is NOT evidence. If a statement is supported only by what you already knew, do not propose it.
- "shared" proposals MUST NOT contain: user names, account ids, session ids, emails, URLs, file paths, prices, API keys, tokens, or any detail traceable to one user or one purchase.
- Skip greetings, one-off requests, small talk, and anything derivable from the product itself (pricing tables, model lists, UI text).
- Do not propose anything you cannot state in one sentence.

Output schema (JSON only, no markdown fence):
{"session_id":"<id>","candidates":[{"scope":"private|shared","domain":"<one-level domain>","slug":"<kebab-case>","description":"<one line, <=120 chars>","type":"user|feedback|project|domain","body":"<=2000 chars; for feedback/project include **Why:** and **How to apply:**","links":["<other-slug>"],"evidence":"<verbatim quote of the tool result or the user's words, <=200 chars>","evidence_kind":"tool_result|user_confirmed|verbatim","self_score":1-5,"self_score_reason":"<one line>"}],"rejected":[{"note":"<what you skipped>","reason":"one_off|greeting|derivable|no_evidence|sensitive"}]}`

/** Verifier prompt（G8，僅 shared、換模型）——契約 §6 逐字；P1-1 本片接線進 runBatch。 */
export const VERIFIER_PROMPT_V1 = `You are an independent fact-checker for a shared knowledge base used by an AI image/video generation assistant.
Input: one candidate knowledge item. Answer three questions about it.

1. TRANSFERABLE: Is this knowledge useful to a different user with a different project, or is it specific to one user's situation?
2. EVIDENCED: Is this knowledge actually supported by the quoted evidence, or is it the model's own inference or general knowledge?
3. CLEAN: Is it free of any user-identifying trace (names, account ids, session ids, emails, URLs, file paths, prices, keys)?

Output JSON only: {"transferable":true|false,"evidenced":true|false,"clean":true|false,"reason":"<one line>"}
A candidate is admitted only if all three are true.`

/**
 * Oracle prompt（PRD §5.6 抽檢、換模型）——【契約外新增常量】（§6 只有 curator/verifier），
 * 依 PRD 判據逐字面「準確？可遷移？無用戶痕跡？」，每條 0/1/2 分。
 */
export const ORACLE_PROMPT_V1 = `You are an independent quality oracle auditing one item admitted into a shared knowledge base used by an AI image/video generation assistant.
Judge the item on three questions: is it accurate, is it transferable to a different user's project, and is it free of any user-identifying trace (names, account ids, session ids, emails, URLs, file paths, prices, keys)?
Score the item 0, 1, or 2: 2 = passes all three; 1 = minor doubt on one aspect; 0 = fails any aspect decisively.
Output JSON only: {"score":0|1|2,"reason":"<one line>"}`

// ─────────────────────────── 形狀

/** 入庫 doc：promptVersion 由批次蓋章補上。 */
export interface IngestDocInput extends AgentMemoryDocInput {}

/** 篩選用會話元資料（wiring 適配：opencode 目錄行 parentID/time.updated、gateway hashKey(apiKey)、訊息/工具計數）。 */
export interface MemorySessionRecord {
  id: string
  /** 非空即 subagent 子會話 → 剔除（PRD §5.2 條件⑤）。 */
  parentId?: string | null
  /** ISO 字串或 epoch ms（opencode time.*）；「當日 updated」判定用。 */
  updatedAt?: string | number
  /** SHA-256(apiKey) 前 12 bytes hex（契約 §1，與 gateway hashKey 同算法）。 */
  ownerKey?: string
  userMessages?: number
  successfulToolCalls?: number
  /** 知識型工具呼叫數：篩選加權排序用（PRD §5.2 條件③）。 */
  knowledgeToolCalls?: number
}

export interface MemoryBatchEnv {
  [key: string]: string | undefined
  MEMORY_INGEST_SECRET?: string
  MEMORY_BATCH_ENABLED?: string
  MEMORY_BATCH_MAX_SESSIONS?: string
  MEMORY_BATCH_MAX_LLM?: string
  MEMORY_SHARED_ENABLED?: string
  /** G8 verifier 模型（`provider/model`）；未配置 → G8 跳過並誠實記 g8_skipped（不放過不誤殺）。 */
  MEMORY_VERIFIER_MODEL?: string
  /** §5.6 oracle 抽檢模型；未配置 → 抽檢跳過並誠實記 sampling.skipped。 */
  MEMORY_ORACLE_MODEL?: string
  /** 批次狀態檔目錄（默認 "."，即 gateway 進程 cwd 旁）。 */
  MEMORY_STATE_DIR?: string
}

export interface MemoryBatchDeps {
  listSessions(): Promise<MemorySessionRecord[]>
  transcriptOf(sessionId: string): Promise<string>
  /** 一次性 LLM 呼叫（wiring 用 handleExtractLessons 迴環：建 session→POST→取 text→finally DELETE，120s 超時）。 */
  callLlm(prompt: string): Promise<string>
  /** G8 verifier（換模型，契約 §5/PRD §5.4）：prompt + `provider/model`；未配置時本檔不呼叫。 */
  callVerifierLlm(prompt: string, model: string): Promise<string>
  /** §5.6 oracle 抽檢（換模型）：同 verifier 通道形態；未配置時本檔不呼叫。 */
  callOracleLlm(prompt: string, model: string): Promise<string>
  /** 送 ingest：rawBody 是即將送出的精確位元組（本檔已按其簽名，不得在實作端重新序列化）。 */
  postIngest(
    path: string,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: unknown }>
  env: MemoryBatchEnv
  now(): Date
}

export interface MemoryBatchOptions {
  dryRun?: boolean
  sessionIds?: string[]
  /** YYYY-MM-DD（UTC）；默認取 deps.now() 當日。 */
  date?: string
}

/**
 * §5.6 抽檢報告段（**零正文**）。shared 堆為判據主體；private 同機制只記 badge。
 * avg 為有效分數均值；全錯時 null（不灌水 0）。
 */
export interface MemorySamplingReport {
  /** shared 抽檢樣本數（實際拿到 oracle 判分的條數）。 */
  sampled: number
  avg: number | null
  /** true = 平均 <1.5 或任一 0 分 → 該批 shared 已全部轉 pending_review。 */
  triggered: boolean
  /** oracle 呼叫失敗數（基礎設施失敗≠候選有罪；不計入 avg，誠實計數）。 */
  errors: number
  /** oracle 未配置／LLM 預算耗盡時「本應抽檢而未抽」的條數（shared＋private）；誠實旗標。 */
  skipped: number
  /** private 抽檢中得分 <2 的條數（badge only，PRD §5.6 不自動轉 pending）。 */
  private_badged: number
}

/** 批次報告（契約 §3.5 形狀；**不含任何正文**）。 */
export interface MemoryBatchReport {
  batch_id: string
  date: string
  dry_run: boolean
  candidates: number
  passed: number
  stored: number
  rejected: Record<string, number>
  truncations: { sessions: number; llm_budget_hit: boolean }
  /** G8 誠實旗標：shared 候選因 `MEMORY_VERIFIER_MODEL` 未配置而跳過驗證的條數。 */
  g8_skipped: number
  /** G8 抽檢段（入庫後）；未送 ingest（dryRun／無候選）時各欄為 0／null。 */
  sampling: MemorySamplingReport
  report_path?: string
}

interface PendingEnvelope {
  batch_id: string
  created_at: string
  attempts: number
  next_retry_at: number
  /** 將送出的精確 raw JSON bytes（string），重試時原位元重發——簽名必須對同一串。 */
  raw_body: string
}

interface CursorState {
  processed: Record<string, { at: string; produced: boolean }>
}

// ─────────────────────────── 常量

const INGEST_PATH = "/api/agent/memory/ingest"
const REVIEW_PATH = "/api/agent/memory/review"
const CONCURRENCY = 3
const MAX_ATTEMPTS = 5 // 指數退避上限（含跨 run 重試），超過落 memory-failed/
const DEFAULT_MAX_SESSIONS = 50
const DEFAULT_MAX_LLM = 150
const CURSOR_FILE = "memory-cursor.json"
const PENDING_DIR = "memory-pending"
const FAILED_DIR = "memory-failed"
const REPORTS_DIR = "memory-batches"
// badcase 集（PRD §5.6）：【本地決定】比照 pending 目錄系（見檔頭），落 `memory-badcases/`。
const BADCASES_DIR = "memory-badcases"
/** §5.6 抽檢判據常量：30%、最少 3（不足全抽）、平均 <1.5 或任一 0 分觸發。 */
const SAMPLING_RATE = 0.3
const SAMPLING_MIN = 3
const SAMPLING_AVG_TRIGGER = 1.5

const DEFAULTS = {
  maxSessions: DEFAULT_MAX_SESSIONS,
  maxLlm: DEFAULT_MAX_LLM,
} as const

// ─────────────────────────── 小工具（純函式）

function envInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return fallback
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

function isoDateOf(value: string | number | undefined): string {
  if (value === undefined || value === null) return ""
  const ms = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toISOString().slice(0, 10)
}

function epochOf(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0
  const ms = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 併發池（上限 limit；回呼自行 try/catch，永不拋出中斷池）。 */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers: Promise<void>[] = []
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor
          cursor += 1
          await fn(items[index])
        }
      })(),
    )
  }
  await Promise.all(workers)
}

/** 抽檢量（§5.6）：30%，最少 3；不足 3 條全抽。 */
function sampleSize(total: number): number {
  if (total <= 0) return 0
  if (total < SAMPLING_MIN) return total
  return Math.min(total, Math.max(SAMPLING_MIN, Math.ceil(total * SAMPLING_RATE)))
}

/** Fisher–Yates 洗牌取前 k（隨機抽樣，原地不改輸入）。 */
function shuffleSample<T>(items: T[], k: number): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  return pool.slice(0, k)
}

/** 檔名安全化（docId 理論上已是 `${batch}-${slug}`，防衛性剝分隔符）。 */
function safeFileSegment(value: string): string {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120)
}

/** 均值保留 4 位小數（報告可讀；比較用四捨五入後值，觸發邊界與原始判據一致）。 */
function roundAvg(sum: number, count: number): number {
  return Math.round((sum / count) * 1e4) / 1e4
}

// ─────────────────────────── 工廠

export function createMemoryBatch(deps: MemoryBatchDeps) {
  const stateDir = String(deps.env.MEMORY_STATE_DIR ?? "").trim() || "."
  const cursorPath = join(stateDir, CURSOR_FILE)
  const pendingDir = join(stateDir, PENDING_DIR)
  const failedDir = join(stateDir, FAILED_DIR)
  const reportsDir = join(stateDir, REPORTS_DIR)
  const badcasesDir = join(stateDir, BADCASES_DIR)

  // ---- 本地狀態檔 IO（無憑證；見檔頭「本地決定」） ----

  function readJsonFile<T>(path: string): T | null {
    try {
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, "utf8")) as T
    } catch {
      return null
    }
  }

  function writeJsonFile(path: string, value: unknown): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(value, null, 2), "utf8")
    } catch (err) {
      // 只記檔名層級，不記內容。
      console.error(`[memory-batch] state write failed: ${dirname(path)}`, (err as Error)?.name ?? "Error")
    }
  }

  function loadCursor(): CursorState {
    const loaded = readJsonFile<CursorState>(cursorPath)
    if (loaded && typeof loaded === "object" && loaded.processed && typeof loaded.processed === "object") {
      return { processed: loaded.processed }
    }
    return { processed: {} }
  }

  // ---- 端點送出與重試 ----

  /**
   * HMAC 端點通用送出（ingest 與 review 同一簽名通道，契約 §3 頭部紀律）：
   * 對「將送出的精確 raw bytes」簽名；非 2xx／網路失敗 → ok:false，不落 log 正文。
   */
  async function postSigned(path: string, rawBody: string): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
    const secret = String(deps.env.MEMORY_INGEST_SECRET ?? "").trim()
    if (!secret) {
      // 憑證紀律：只報缺配置事實，不印任何密鑰派生物。
      console.error("[memory-batch] MEMORY_INGEST_SECRET 未配置，HMAC 端點拒絕送出。")
      return { ok: false, json: null }
    }
    try {
      const res = await deps.postIngest(path, rawBody, {
        "Content-Type": "application/json",
        [MEMORY_SIGNATURE_HEADER]: signMemoryBytes(rawBody, secret),
      })
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, json: (res.json ?? null) as Record<string, unknown> | null }
      }
      return { ok: false, json: null }
    } catch {
      return { ok: false, json: null }
    }
  }

  async function attemptPost(rawBody: string): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
    return postSigned(INGEST_PATH, rawBody)
  }

  function writePending(env: PendingEnvelope): void {
    writeJsonFile(join(pendingDir, `${env.batch_id}.json`), env)
  }

  function listPendingFiles(): string[] {
    try {
      if (!existsSync(pendingDir)) return []
      return readdirSync(pendingDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(pendingDir, f))
    } catch {
      return []
    }
  }

  /**
   * 跨 run 重試 pending 檔：指数退避（next_retry_at 由 attempts 推），
   * attempts ≥ MAX_ATTEMPTS → 移入 memory-failed/ 並記日誌（只記 batch_id，不含正文）。
   */
  async function drainPending(): Promise<void> {
    const nowMs = deps.now().getTime()
    for (const file of listPendingFiles()) {
      const env = readJsonFile<PendingEnvelope>(file)
      if (!env || typeof env.raw_body !== "string" || !env.batch_id) continue
      if (nowMs < Number(env.next_retry_at ?? 0)) continue
      if (Number(env.attempts ?? 0) >= MAX_ATTEMPTS) {
        try {
          mkdirSync(failedDir, { recursive: true })
          renameSync(file, join(failedDir, `${env.batch_id}.json`))
        } catch {
          /* 搬移失敗留待下輪 */
        }
        console.error(`[memory-batch] pending exhausted after ${MAX_ATTEMPTS} attempts → failed/: batch=${env.batch_id}`)
        continue
      }
      const { ok } = await attemptPost(env.raw_body)
      if (ok) {
        try {
          unlinkSync(file)
        } catch {
          /* 刪除失敗：下輪再試，冪等由端點 G5 兜 */
        }
        console.log(`[memory-batch] pending replayed: batch=${env.batch_id}`)
        continue
      }
      const attempts = Number(env.attempts ?? 0) + 1
      writePending({
        ...env,
        attempts,
        // 指數退避：2^attempts 分鐘（32→64→128→256 分鐘級），跨 run/排程自然生效。
        next_retry_at: nowMs + Math.min(2 ** attempts, 240) * 60_000,
      })
      try {
        if (join(pendingDir, `${env.batch_id}.json`) !== file) unlinkSync(file)
      } catch {
        /* noop */
      }
    }
  }

  // ---- 主批次 ----

  async function runBatch(options: MemoryBatchOptions = {}): Promise<MemoryBatchReport> {
    const dryRun = options.dryRun === true
    const nowDate = deps.now()

    if (!dryRun && !envBool(deps.env.MEMORY_BATCH_ENABLED, false)) {
      // 總開關（§8 默認 false）：未明確開啟時手動跑要 dryRun 或設 true，避免誤寫生產。
      throw new Error("MEMORY_BATCH_ENABLED=false（總開關未開啟；先用 dryRun，或設 MEMORY_BATCH_ENABLED=true）")
    }

    const date =
      typeof options.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.date)
        ? options.date
        : nowDate.toISOString().slice(0, 10)
    const batchId = date // §3.1 例：batch_id 用日期（穩定可追溯；id=${batchId}-${slug} 由服務端拼）
    const maxSessions = envInt(deps.env.MEMORY_BATCH_MAX_SESSIONS, DEFAULTS.maxSessions)
    const maxLlm = envInt(deps.env.MEMORY_BATCH_MAX_LLM, DEFAULTS.maxLlm)
    const sharedEnabled = envBool(deps.env.MEMORY_SHARED_ENABLED, true)
    // G8/抽檢模型（§8 新增 env）：未配置＝該閘跳過，誠實記數（不放過不誤殺）。
    const verifierModel = String(deps.env.MEMORY_VERIFIER_MODEL ?? "").trim()
    const oracleModel = String(deps.env.MEMORY_ORACLE_MODEL ?? "").trim()

    const report: MemoryBatchReport = {
      batch_id: batchId,
      date,
      dry_run: dryRun,
      candidates: 0,
      passed: 0,
      stored: 0,
      rejected: {},
      truncations: { sessions: 0, llm_budget_hit: false },
      g8_skipped: 0,
      sampling: { sampled: 0, avg: null, triggered: false, errors: 0, skipped: 0, private_badged: 0 },
    }
    const bump = (key: string, n = 1) => {
      report.rejected[key] = (report.rejected[key] ?? 0) + n
    }

    if (!dryRun) {
      await drainPending()
    }

    const cursor = loadCursor()
    const all = await deps.listSessions()

    // 條件⑤：剔除 subagent 子會話（parent_id 非空即剔）——含手動指定 sessionIds 的場合。
    const eligible = all.filter((s) => s && typeof s.id === "string" && !s.parentId)

    let candidates: MemorySessionRecord[]
    if (Array.isArray(options.sessionIds) && options.sessionIds.length > 0) {
      const wanted = new Set(options.sessionIds.map(String))
      candidates = eligible.filter((s) => wanted.has(s.id))
    } else {
      candidates = eligible.filter(
        // 條件①當日 updated；條件②用戶消息≥3 或有成功工具呼叫；條件④游標去重（含已處理無產出）。
        (s) =>
          isoDateOf(s.updatedAt) === date &&
          ((s.userMessages ?? 0) >= 3 || (s.successfulToolCalls ?? 0) >= 1) &&
          !cursor.processed[s.id],
      )
      // 條件③：知識型工具加權排序（降序；同權取較新）。
      candidates.sort(
        (a, b) =>
          (b.knowledgeToolCalls ?? 0) - (a.knowledgeToolCalls ?? 0) ||
          epochOf(b.updatedAt) - epochOf(a.updatedAt),
      )
      // 預算：會話數截斷入報告。
      if (candidates.length > maxSessions) {
        report.truncations.sessions = candidates.length - maxSessions
        candidates = candidates.slice(0, maxSessions)
      }
    }
    report.candidates = candidates.length

    const docs: IngestDocInput[] = []
    let llmUsed = 0
    const gateCtxBase: Omit<GateContext, "ownerKeyHint"> = { sharedEnabled }

    /**
     * G8 雙模型一致閘（契約 §5、PRD §5.4，僅 shared、postIngest 前逐條）：
     * 三布爾全 true 才過；收到非 JSON／欄位非 true → 丟棄（g8_rejected）。
     * 模型未配置／LLM 預算耗盡／verifier 呼叫失敗 → skip（g8_skipped 誠實旗標：
     * 不靜默放過——報告留痕；不誤殺——基礎設施失敗不判候選有罪）。
     * dryRun 不啟動閘 LLM（curator 是預覽主體照跑，但抽檢／驗證屬「會等的錢」不花）。
     */
    async function g8Check(doc: IngestDocInput): Promise<"pass" | "reject" | "skip"> {
      if (!verifierModel) return "skip"
      if (llmUsed >= maxLlm) return "skip"
      llmUsed += 1
      let text = ""
      try {
        text = await deps.callVerifierLlm(
          `${VERIFIER_PROMPT_V1}\n\n${JSON.stringify(doc)}`,
          verifierModel,
        )
      } catch {
        return "skip"
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stripJsonFence(text))
      } catch {
        return "reject" // 有回應但不可信 → 丟棄（spec：非 JSON→丟棄）。
      }
      const v = parsed as { transferable?: unknown; evidenced?: unknown; clean?: unknown }
      return v && v.transferable === true && v.evidenced === true && v.clean === true
        ? "pass"
        : "reject"
    }

    type OracleOutcome =
      | { kind: "score"; score: number; reason: string }
      | { kind: "error" }
      | { kind: "budget" }

    /**
     * §5.6 oracle 逐條判分（0/1/2）。呼叫失敗＝error（不計入 avg）；預算耗盡＝budget
     * （sampling.skipped）；收到畸形輸出（非 JSON／score 非 0/1/2）→ fail-closed 記 0
     * （抽檢的終態是人工可 activate 放行，誤傷可逆，寧可送複核）。
     */
    async function oracleOf(doc: IngestDocInput): Promise<OracleOutcome> {
      if (llmUsed >= maxLlm) return { kind: "budget" }
      llmUsed += 1
      let text = ""
      try {
        text = await deps.callOracleLlm(`${ORACLE_PROMPT_V1}\n\n${JSON.stringify(doc)}`, oracleModel)
      } catch {
        return { kind: "error" }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stripJsonFence(text))
      } catch {
        return { kind: "score", score: 0, reason: "oracle_unparseable" }
      }
      const record = parsed as { score?: unknown; reason?: unknown }
      if (record?.score !== 0 && record?.score !== 1 && record?.score !== 2) {
        return { kind: "score", score: 0, reason: "oracle_unparseable" }
      }
      return {
        kind: "score",
        score: record.score,
        reason: typeof record.reason === "string" ? record.reason.slice(0, 200) : "",
      }
    }

    /** 抽檢樣本逐條落 badcase 集（【本地決定】比照 pending 目錄系 → `memory-badcases/`）。 */
    function writeBadcase(docId: string, doc: IngestDocInput, score: number, reason: string): void {
      writeJsonFile(join(badcasesDir, `${safeFileSegment(docId)}.json`), {
        doc_id: docId,
        batch_id: batchId,
        date,
        sampled_at: deps.now().toISOString(),
        scope: doc.scope,
        domain: doc.domain,
        slug: doc.slug,
        description: doc.description,
        type: doc.type,
        body: doc.body,
        evidence: doc.evidence ?? "",
        evidence_kind: doc.evidenceKind,
        self_score: doc.selfScore,
        oracle_score: score,
        oracle_reason: reason,
      })
    }

    /**
     * 入庫後抽檢（只認端點回執 accepted＝「真寫入」權威）：
     * shared 隨機 30%（最少 3、不足全抽）→ oracle；平均 <1.5 或任一 0 分 →
     * POST `/api/agent/memory/review` {batch_id, action:"pending_review"}（同一 HMAC
     * 簽名通道；repo 端預設只翻 shared，見 store reviewMemoryDocs）。
     * private 同機制判分但只記 badge 不翻轉（PRD §5.6）。
     */
    async function runSampling(acceptedIds: string[]): Promise<void> {
      const sampling = report.sampling
      const acceptedSet = new Set(acceptedIds)
      const pairs: Array<{ id: string; doc: IngestDocInput }> = []
      for (const doc of docs) {
        // 服務端 id = `${batchId}-${slug}`；G5 更新保留舊 id（批次前綴可能不同）→ 後綴比對兜底。
        const expected = `${batchId}-${doc.slug}`
        const id = acceptedSet.has(expected)
          ? expected
          : acceptedIds.find((candidate) => candidate.endsWith(`-${doc.slug}`))
        if (id) pairs.push({ id, doc })
      }
      const sharedPairs = pairs.filter((pair) => pair.doc.scope === "shared")
      const privatePairs = pairs.filter((pair) => pair.doc.scope === "private")
      if (!oracleModel) {
        sampling.skipped = sharedPairs.length + privatePairs.length
        return
      }
      const scores: number[] = []
      for (const pair of shuffleSample(sharedPairs, sampleSize(sharedPairs.length))) {
        const outcome = await oracleOf(pair.doc)
        if (outcome.kind === "error") {
          sampling.errors += 1
          continue
        }
        if (outcome.kind === "budget") {
          sampling.skipped += 1
          continue
        }
        scores.push(outcome.score)
        writeBadcase(pair.id, pair.doc, outcome.score, outcome.reason)
      }
      sampling.sampled = scores.length
      const avg = scores.length > 0 ? roundAvg(scores.reduce((a, b) => a + b, 0), scores.length) : null
      sampling.avg = avg
      sampling.triggered =
        avg !== null && (scores.some((s) => s === 0) || avg < SAMPLING_AVG_TRIGGER)
      if (sampling.triggered) {
        const reviewRaw = JSON.stringify({ batch_id: batchId, action: "pending_review" })
        const { ok } = await postSigned(REVIEW_PATH, reviewRaw)
        if (!ok) bump("review_post_failed") // 翻轉請求送出失敗：留痕，不假裝已轉。
      }
      for (const pair of shuffleSample(privatePairs, sampleSize(privatePairs.length))) {
        const outcome = await oracleOf(pair.doc)
        if (outcome.kind === "error") {
          sampling.errors += 1
          continue
        }
        if (outcome.kind === "budget") {
          sampling.skipped += 1
          continue
        }
        writeBadcase(pair.id, pair.doc, outcome.score, outcome.reason)
        if (outcome.score < 2) sampling.private_badged += 1
      }
    }

    await mapPool(candidates, CONCURRENCY, async (session) => {
      if (llmUsed >= maxLlm) {
        report.truncations.llm_budget_hit = true
        return // 預算截斷：不標已處理，留給下批。
      }
      const mark = (produced: boolean) => {
        cursor.processed[session.id] = { at: nowDate.toISOString(), produced }
      }
      let transcript = ""
      try {
        transcript = await deps.transcriptOf(session.id)
      } catch {
        bump("transcript_error")
        mark(false)
        return
      }
      if (!transcript || transcript.trim().length === 0) {
        bump("empty_transcript")
        mark(false)
        return
      }
      llmUsed += 1
      // 迴環形狀比照輪子 handleExtractLessons：prompt + \n\n<transcript>\n…\n</transcript>。
      const prompt = `${CURATOR_PROMPT_V1}\n\n<transcript>\n${transcript}\n</transcript>`
      let text = ""
      try {
        text = await deps.callLlm(prompt)
      } catch {
        bump("llm_error")
        mark(false)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(stripJsonFence(text))
      } catch {
        bump("g1_structure")
        mark(false)
        return
      }
      const rawList = (parsed as { candidates?: unknown })?.candidates
      if (!Array.isArray(rawList)) {
        bump("g1_structure")
        mark(false)
        return
      }
      const ctx: GateContext = { ...gateCtxBase, ownerKeyHint: session.ownerKey }
      let produced = false
      for (const raw of rawList) {
        const gated = applyMemoryGates(raw as CuratorCandidate, ctx)
        if (gated.action === "drop" || !gated.doc) {
          bump(gated.reason)
          continue
        }
        const doc: IngestDocInput = { ...gated.doc, promptVersion: MEMORY_PROMPT_VERSION }
        if (doc.scope === "private") {
          if (!doc.ownerKey && session.ownerKey) doc.ownerKey = session.ownerKey
          // 無 ownerKey 的 private 無處安放（§2 私有正文路徑需要它）→ 丟棄計數。
          if (!doc.ownerKey) {
            bump("g4_no_owner")
            continue
          }
        }
        // G8（契約 §5，僅 shared、postIngest 前逐條）；dryRun 不啟動閘 LLM。
        if (doc.scope === "shared" && !dryRun) {
          const verdict = await g8Check(doc)
          if (verdict === "reject") {
            bump("g8_rejected")
            continue
          }
          if (verdict === "skip") report.g8_skipped += 1
        }
        report.passed += 1
        docs.push(doc)
        produced = true
      }
      mark(produced)
    })

    // 寫入：只認端點回執 accepted（§3.1「真寫入」）；非 dryRun 才發。
    if (!dryRun && docs.length > 0) {
      const body = {
        batch_id: batchId,
        prompt_version: MEMORY_PROMPT_VERSION,
        docs,
      }
      const rawBody = JSON.stringify(body) // 簽名與送出共用同一串 raw bytes。
      const { ok, json } = await attemptPost(rawBody)
      if (ok) {
        const accepted = Array.isArray(json?.accepted) ? (json?.accepted as unknown[]) : []
        report.stored = accepted.length
        const rejected = Array.isArray(json?.rejected) ? (json?.rejected as Array<{ reason?: unknown }>) : []
        for (const r of rejected) {
          bump(`server_${typeof r?.reason === "string" ? r.reason : "unknown"}`)
        }
        if (accepted.length < docs.length && rejected.length === 0) {
          bump("server_silent_loss") // 回執不齊：端點沒給逐條原因（G7 截斷除外），記帳不吞。
        }
        // §5.6：端點回執 accepted 之後才抽檢（未寫入的沒有品質可審）。
        await runSampling(accepted.map((id) => String(id)))
      } else {
        // 非 2xx／網路失敗 → 寫 pending 檔（指數退避重試由 drainPending 接手）。
        writePending({
          batch_id: batchId,
          created_at: nowDate.toISOString(),
          attempts: 1,
          next_retry_at: deps.now().getTime() + 2 * 60_000,
          raw_body: rawBody,
        })
        bump("ingest_pending")
      }
    }

    writeJsonFile(cursorPath, cursor)
    report.report_path = join(REPORTS_DIR, `${batchId}.json`)
    writeJsonFile(join(reportsDir, `${batchId}.json`), report)
    return report
  }

  return { runBatch, drainPending }
}
