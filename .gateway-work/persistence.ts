/**
 * persistence.ts — 服務端會話持久化（bun:sqlite，零新依賴）
 *
 * 架構決策（2026-08-21）：
 * 1. 訊息歷史的權威擁有者是 opencode serve（它自己的存儲在 gateway 重啟後仍完整存在）。
 *    gateway 不複製 messages 進自己的 DB —— 那會製造第二份會漂移的歷史副本。
 *    gateway 需要持久化的只有自己擁有的那部分狀態：
 *      - 身分映射：gateway sessionId ↔ opencode session id ↔ owner key
 *      - SSE replayBuffer（最近 REPLAY_BUFFER_SIZE 幀，斷線/重啟後前端 Last-Event-ID 續傳用）
 *      - 事件翻譯去重狀態（messageRole / suppressedParts 等有界集合）
 *      - 一次性注入標記（vettingInjected / memoryInjected / userMemory）
 *      - 畫布摘要（canvasSummary）
 *      - 摘要壓縮水位（compact.lastCount）
 * 2. 存儲選 bun:sqlite（bun 內建）：單文件 /opt/agent-harness/gateway/sessions.db、
 *    WAL 模式、同步 API（getOwnedSession 是同步函數，lazy reload 不用改異步簽名）。
 * 3. 寫入時機：dirty 標記 + 3s 防抖 flush（index.ts 持有 flush 循環），關鍵轉換點
 *    （建立/刪除）同步寫；SIGTERM 時補一次 flush。重啟最多丟 3s 內的 replay 幀，
 *    訊息本身永遠安全在 opencode。
 * 4. 失敗語義 fail-open：DB 不可用時只記日誌、退回純內存行為（與舊版一致），
 *    絕不讓持久化故障殺死 gateway。
 */

import { Database } from "bun:sqlite"

// ---- 型別 ----

/** 可持久化的 SessionState 子集（結構化 duck-type，避免與 index.ts 循環 import）。 */
export interface PersistableState {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  eventCounter: number
  replayBuffer: { id: number; frame: Uint8Array }[]
  lastActivityAt: number
  partTextEmitted: Map<string, { emittedLen: number }>
  announcedUrls: Set<string>
  toolStatusSeen: Set<string>
  toolInvokeSeen: Set<string>
  stepCostLogged: Set<string>
  messageRole: Map<string, string>
  suppressedParts: Set<string>
  canvasSummary?: unknown
  canvasSummaryAt?: number
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  memoryInjected: boolean
  compact?: { lastCount: number; at: number }
}

/** DB row 的 data 欄位 JSON 形狀（Map/Set 均序列化為陣列）。 */
interface PersistedData {
  eventCounter: number
  replayBuffer: { id: number; frame: string }[]
  lastActivityAt: number
  partTextEmitted: [string, { emittedLen: number }][]
  announcedUrls: string[]
  toolStatusSeen: string[]
  toolInvokeSeen: string[]
  stepCostLogged: string[]
  messageRole: [string, string][]
  suppressedParts: string[]
  canvasSummary?: unknown
  canvasSummaryAt?: number
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  memoryInjected: boolean
  compact?: { lastCount: number; at: number }
}

export interface PersistedRow {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  createdAt: number
  updatedAt: number
  data: PersistedData
}

const DB_PATH = process.env.SESSIONS_DB_PATH || "/opt/agent-harness/gateway/sessions.db"

let db: Database | null = null
let warned = false

function degrade(e: unknown, where: string): void {
  if (!warned) {
    console.error(`[gateway] persistence degraded (${where}): ${e}`)
    warned = true
  }
}

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

// ---- 初始化 ----

export function initPersistence(): void {
  try {
    db = new Database(DB_PATH, { create: true })
    db.exec("PRAGMA journal_mode=WAL")
    db.exec("PRAGMA synchronous=NORMAL")
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                 TEXT PRIMARY KEY,
        owner_key          TEXT NOT NULL,
        opencode_session_id TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        data               TEXT NOT NULL
      )
    `)
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_opencode ON sessions(opencode_session_id)")
    console.log(`[gateway] session persistence ready: ${DB_PATH}`)
  } catch (e) {
    degrade(e, "init")
    db = null
  }
}

// ---- 序列化 / 反序列化 ----

function serialize(state: PersistableState): PersistedData {
  return {
    eventCounter: state.eventCounter,
    replayBuffer: state.replayBuffer.map((f) => ({ id: f.id, frame: textDecoder.decode(f.frame) })),
    lastActivityAt: state.lastActivityAt,
    partTextEmitted: [...state.partTextEmitted.entries()],
    announcedUrls: [...state.announcedUrls],
    toolStatusSeen: [...state.toolStatusSeen],
    toolInvokeSeen: [...state.toolInvokeSeen],
    stepCostLogged: [...state.stepCostLogged],
    messageRole: [...state.messageRole.entries()],
    suppressedParts: [...state.suppressedParts],
    canvasSummary: state.canvasSummary,
    canvasSummaryAt: state.canvasSummaryAt,
    vettingInjected: state.vettingInjected,
    userMemory: state.userMemory,
    memoryInjected: state.memoryInjected,
    compact: state.compact,
  }
}

/**
 * 從 DB row 重建完整 SessionState（含所有活躍結構的空容器）。
 * 回傳物件形狀與 index.ts 的 SessionState 完全一致（clients/pending* 為空）。
 */
export function hydrateRow(row: PersistedRow): Record<string, unknown> {
  const d = row.data ?? ({} as PersistedData)
  return {
    sessionId: row.sessionId,
    apiKey: row.apiKey,
    opencodeSessionId: row.opencodeSessionId,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: typeof d.eventCounter === "number" ? d.eventCounter : 0,
    replayBuffer: (d.replayBuffer ?? []).map((f) => ({ id: f.id, frame: textEncoder.encode(f.frame) })),
    lastActivityAt: typeof d.lastActivityAt === "number" ? d.lastActivityAt : row.updatedAt,
    partTextEmitted: new Map(d.partTextEmitted ?? []),
    announcedUrls: new Set(d.announcedUrls ?? []),
    toolStatusSeen: new Set(d.toolStatusSeen ?? []),
    toolInvokeSeen: new Set(d.toolInvokeSeen ?? []),
    stepCostLogged: new Set(d.stepCostLogged ?? []),
    messageRole: new Map(d.messageRole ?? []),
    suppressedParts: new Set(d.suppressedParts ?? []),
    canvasSummary: d.canvasSummary,
    canvasSummaryAt: d.canvasSummaryAt,
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    vettingInjected: d.vettingInjected === true,
    userMemory: d.userMemory,
    memoryInjected: d.memoryInjected === true,
    compact: d.compact,
  }
}

function parseRow(row: { id: string; owner_key: string; opencode_session_id: string; created_at: number; updated_at: number; data: string } | null): PersistedRow | null {
  if (!row) return null
  let data: PersistedData
  try {
    data = JSON.parse(row.data) as PersistedData
  } catch {
    return null
  }
  return {
    sessionId: row.id,
    apiKey: row.owner_key,
    opencodeSessionId: row.opencode_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data,
  }
}

// ---- CRUD ----

export function saveSession(state: PersistableState): void {
  if (!db) return
  try {
    const now = Date.now()
    db.query(
      `INSERT INTO sessions (id, owner_key, opencode_session_id, created_at, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_key = excluded.owner_key,
         opencode_session_id = excluded.opencode_session_id,
         updated_at = excluded.updated_at,
         data = excluded.data`,
    ).run(state.sessionId, state.apiKey, state.opencodeSessionId, now, now, JSON.stringify(serialize(state)))
  } catch (e) {
    // UNIQUE(opencode_session_id) 衝突 = 舊 row 殘留同 opencode id（如重啟競態），
    // 先刪舊 row 再重試一次；再失敗就降級放棄本幀寫入。
    try {
      db.query("DELETE FROM sessions WHERE opencode_session_id = ? AND id != ?").run(state.opencodeSessionId, state.sessionId)
      const now = Date.now()
      db.query(
        `INSERT INTO sessions (id, owner_key, opencode_session_id, created_at, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_key = excluded.owner_key,
           opencode_session_id = excluded.opencode_session_id,
           updated_at = excluded.updated_at,
           data = excluded.data`,
      ).run(state.sessionId, state.apiKey, state.opencodeSessionId, now, now, JSON.stringify(serialize(state)))
    } catch (e2) {
      degrade(e2, "save")
    }
  }
}

export function loadSessionById(id: string): PersistedRow | null {
  if (!db) return null
  try {
    return parseRow(db.query("SELECT id, owner_key, opencode_session_id, created_at, updated_at, data FROM sessions WHERE id = ?").get(id) as never)
  } catch (e) {
    degrade(e, "loadById")
    return null
  }
}

export function loadSessionByOpencodeId(opencodeSessionId: string): PersistedRow | null {
  if (!db) return null
  try {
    return parseRow(db.query("SELECT id, owner_key, opencode_session_id, created_at, updated_at, data FROM sessions WHERE opencode_session_id = ?").get(opencodeSessionId) as never)
  } catch (e) {
    degrade(e, "loadByOpencodeId")
    return null
  }
}

export function deleteSessionRow(id: string): void {
  if (!db) return
  try {
    db.query("DELETE FROM sessions WHERE id = ?").run(id)
  } catch (e) {
    degrade(e, "delete")
  }
}

/**
 * 清掉長期無活動的 DB rows（gateway 不在內存、updated_at 超過 maxIdleMs）。
 * 回傳被刪的 { sessionId, opencodeSessionId }，呼叫端負責 best-effort 清理
 * upstream opencode session 與 uploads 目錄。
 */
export function sweepStaleRows(maxIdleMs: number): { sessionId: string; opencodeSessionId: string }[] {
  if (!db) return []
  try {
    const cutoff = Date.now() - maxIdleMs
    const rows = db.query("SELECT id, opencode_session_id FROM sessions WHERE updated_at < ?").all(cutoff) as { id: string; opencode_session_id: string }[]
    for (const r of rows) {
      db.query("DELETE FROM sessions WHERE id = ?").run(r.id)
    }
    return rows.map((r) => ({ sessionId: r.id, opencodeSessionId: r.opencode_session_id }))
  } catch (e) {
    degrade(e, "sweep")
    return []
  }
}
