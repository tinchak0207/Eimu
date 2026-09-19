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
  /** 畫布持久快照（canvas.node.* 事件套用後的節點/連線），重啟後回灌 canvasStates。 */
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  /** 工作流持久快照（與 canvasSnapshot 同構）：ActiveWorkflow 的可恢復子集
   *  （模板 id、節點流、節點狀態/結果/成本），重啟後回灌 workflows Map。 */
  workflowSnapshot?: Record<string, unknown>
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  profileOnboardingPending?: boolean
  memoryInjected: boolean
  compact?: { lastCount: number; at: number }
  /** N1（2026-08-27）：in-flight turn 打點——turn 開始時寫入、正常結束清零；
   *  gateway 重啟後恢復會話時據此判斷是否要自動重投 lastPromptBody。 */
  lastTurnActiveAt?: number
  /** 會話摘要標題（2026-09-12）：opencode 首條用戶消息後異步生成，gateway
   *  在 session.idle 鉤子抓取後鏡像進 state 並隨防抖落盤；null/undef=尚未生成。 */
  sessionTitle?: string | null
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
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  workflowSnapshot?: Record<string, unknown>
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  profileOnboardingPending?: boolean
  memoryInjected: boolean
  compact?: { lastCount: number; at: number }
  lastTurnActiveAt?: number
  /** 會話摘要標題鏡像（2026-09-12）：null=尚未生成（佔位標題已在抓取側歸一化掉）。 */
  title?: string | null
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
    // 用戶級 settings（2026-08-29）：key 維度，owner_key 與 sessions.owner_key
    // 同一個 key（歸一化方式一致——都是 gateway 收到的原樣 Bearer key）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        owner_key  TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 刀 F（2026-09-15）：in-flight rework run 持久化（重啟存活）。復用同一 bun:sqlite
    // 實例（同一 DB 層、非自造第二套持久層）——重啟時啟動掃描據此判斷孤兒，
    // finishRun 終態即刪。child_oc 為探針目標，run_id 主鍵保冪等。
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_reworks (
        run_id     TEXT PRIMARY KEY,
        parent_gw  TEXT NOT NULL,
        parent_oc  TEXT NOT NULL,
        child_oc   TEXT NOT NULL,
        agent      TEXT NOT NULL,
        label      TEXT NOT NULL,
        beast      INTEGER NOT NULL,
        async_mode INTEGER NOT NULL,
        rework_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    // 刀 2（2026-09-15）：機器 critic pass 的每會話一次性旗標。同 subagent_reworks 慣例：
    // 復用同一 bun:sqlite 實例（非自造第二套持久層），session_id 主鍵保冪等；寫入即
    // 「本會話已用掉唯一一次 machine critic pass」，重啟後仍成立（防重啟繞過 ≤1 上限）。
    db.exec(`
      CREATE TABLE IF NOT EXISTS critic_passes (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `)
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
    canvasSnapshot: state.canvasSnapshot,
    workflowSnapshot: state.workflowSnapshot,
    vettingInjected: state.vettingInjected,
    userMemory: state.userMemory,
    profileOnboardingPending: state.profileOnboardingPending,
    memoryInjected: state.memoryInjected,
    compact: state.compact,
    lastTurnActiveAt: state.lastTurnActiveAt,
    title: state.sessionTitle ?? null,
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
    // S2b：出站剝離器狀態——回合級 ephemeral，不持久化（重啟後新回合重建）。
    partStripState: new Map(),
    announcedUrls: new Set(d.announcedUrls ?? []),
    toolStatusSeen: new Set(d.toolStatusSeen ?? []),
    toolInvokeSeen: new Set(d.toolInvokeSeen ?? []),
    stepCostLogged: new Set(d.stepCostLogged ?? []),
    messageRole: new Map(d.messageRole ?? []),
    suppressedParts: new Set(d.suppressedParts ?? []),
    canvasSummary: d.canvasSummary,
    canvasSummaryAt: d.canvasSummaryAt,
    canvasSnapshot: d.canvasSnapshot,
    workflowSnapshot: d.workflowSnapshot,
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    vettingInjected: d.vettingInjected === true,
    userMemory: d.userMemory,
    profileOnboardingPending: d.profileOnboardingPending === true,
    memoryInjected: d.memoryInjected === true,
    compact: d.compact,
    lastTurnActiveAt: typeof d.lastTurnActiveAt === "number" ? d.lastTurnActiveAt : 0,
    sessionTitle: typeof d.title === "string" && d.title ? d.title : null,
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


// 會話目錄：當前 key 的全部會話 row（按 updated_at 降序）。給
// GET /agent/v1/sessions 列表端點用；data 只解 lastActivityAt 一個字段，
// 不做完整 hydrate（目錄不需要整包狀態）。
export function listSessionRows(apiKey: string): PersistedRow[] {
  if (!db) return []
  try {
    const stmt = db.prepare(
      "SELECT id, owner_key, opencode_session_id, created_at, updated_at, data FROM sessions WHERE owner_key = ? ORDER BY updated_at DESC",
    )
    const rows = stmt.all(apiKey) as Array<{
      id: string
      owner_key: string
      opencode_session_id: string
      created_at: number
      updated_at: number
      data: string
    }>
    return rows.map((r) => ({
      sessionId: r.id,
      apiKey: r.owner_key,
      opencodeSessionId: r.opencode_session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      data: JSON.parse(r.data) as PersistedData,
    }))
  } catch (e) {
    degrade(e, "listSessionRows")
    return []
  }
}


/**
 * 目錄回填用：只改 data JSON 的 title 欄（讀-改-寫同 parseRow/listSessionRows
 * 的 JS 序列化鏈，不動 updated_at 以免打亂列表排序）。fail-open 同全局策略。
 */
export function setRowTitle(id: string, title: string): void {
  if (!db) return
  try {
    const row = db.query("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null
    if (!row) return
    let data: PersistedData
    try {
      data = JSON.parse(row.data) as PersistedData
    } catch {
      return // data 壞損的行不強寫，交由降級路徑
    }
    data.title = title
    db.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(data), id)
  } catch (e) {
    degrade(e, "setRowTitle")
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

// ---- 用戶級 Settings（2026-08-29，key 維度）----
// 存儲模式與 canvasSummary/userMemory 同構（JSON data 欄位），但歸屬維度是
// owner_key（用戶級，跨會話共享），重啟不丟。shape 校驗在 index.ts，這裡只存取。

export interface UserSettings {
  interrupt_mode: string
  persona: string
  cost_mode: string
}

/** 讀取 key 維度 settings；無記錄回 null（呼叫端套默認值）。fail-open 同全局策略。 */
export function loadUserSettings(ownerKey: string): UserSettings | null {
  if (!db || !ownerKey) return null
  try {
    const row = db.query("SELECT data FROM user_settings WHERE owner_key = ?").get(ownerKey) as { data: string } | null
    if (!row) return null
    return JSON.parse(row.data) as UserSettings
  } catch (e) {
    degrade(e, "loadUserSettings")
    return null
  }
}

/** 寫入 key 維度 settings（UPSERT）。 */
export function saveUserSettings(ownerKey: string, s: UserSettings): void {
  if (!db || !ownerKey) return
  try {
    db.query(
      `INSERT INTO user_settings (owner_key, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(ownerKey, JSON.stringify(s), Date.now())
  } catch (e) {
    degrade(e, "saveUserSettings")
  }
}

// ---- 刀 F（2026-09-15）：in-flight rework run 持久化 ----
export interface ReworkRecord {
  runId: string
  parentGw: string
  parentOc: string
  childOc: string
  agent: string
  label: string
  beast: boolean
  asyncMode: boolean
  reworkCount: number
  updatedAt: number
}

/** 寫入/更新一條 rework run 記錄（run_id 主鍵 UPSERT）。fail-open 同全局策略。 */
export function saveReworkRecord(r: {
  runId: string; parentGw: string; parentOc: string; childOc: string
  agent: string; label: string; beast: boolean; asyncMode: boolean; reworkCount: number
}): void {
  if (!db) return
  try {
    const now = Date.now()
    db.query(
      `INSERT INTO subagent_reworks
        (run_id, parent_gw, parent_oc, child_oc, agent, label, beast, async_mode, rework_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         parent_gw = excluded.parent_gw,
         parent_oc = excluded.parent_oc,
         child_oc = excluded.child_oc,
         agent = excluded.agent,
         label = excluded.label,
         beast = excluded.beast,
         async_mode = excluded.async_mode,
         rework_count = excluded.rework_count,
         updated_at = excluded.updated_at`,
    ).run(
      r.runId, r.parentGw, r.parentOc, r.childOc, r.agent, r.label,
      r.beast ? 1 : 0, r.asyncMode ? 1 : 0, r.reworkCount, now,
    )
  } catch (e) {
    degrade(e, "saveReworkRecord")
  }
}

/** 讀取全部 in-flight rework 記錄（啟動掃描用）。fail-open 回空陣列。 */
export function loadReworkRecords(): ReworkRecord[] {
  if (!db) return []
  try {
    const rows = db.query(
      "SELECT run_id, parent_gw, parent_oc, child_oc, agent, label, beast, async_mode, rework_count, updated_at FROM subagent_reworks",
    ).all() as Array<{
      run_id: string; parent_gw: string; parent_oc: string; child_oc: string
      agent: string; label: string; beast: number; async_mode: number; rework_count: number; updated_at: number
    }>
    return rows.map((x) => ({
      runId: x.run_id, parentGw: x.parent_gw, parentOc: x.parent_oc, childOc: x.child_oc,
      agent: x.agent, label: x.label, beast: x.beast === 1, asyncMode: x.async_mode === 1,
      reworkCount: x.rework_count, updatedAt: x.updated_at,
    }))
  } catch (e) {
    degrade(e, "loadReworkRecords")
    return []
  }
}

/** 刪除一條 rework 記錄（終態即清；冪等，run 不存在也成功）。fail-open。 */
export function deleteReworkRecord(runId: string): void {
  if (!db || !runId) return
  try {
    db.query("DELETE FROM subagent_reworks WHERE run_id = ?").run(runId)
  } catch (e) {
    degrade(e, "deleteReworkRecord")
  }
}

// ---- 刀 2（2026-09-15）：機器 critic pass 每會話一次性旗標 ----

/** 標記該會話已用掉 machine critic pass（session_id 主鍵，重複呼叫冪等）。fail-open。 */
export function markCriticPass(sessionId: string): void {
  if (!db || !sessionId) return
  try {
    db.query(
      `INSERT INTO critic_passes (session_id, created_at) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at`,
    ).run(sessionId, Date.now())
  } catch (e) {
    degrade(e, "markCriticPass")
  }
}

/** 該會話是否已用過 machine critic pass。fail-open 回 false（呼叫端另有內存旗標兜底）。 */
export function hasCriticPass(sessionId: string): boolean {
  if (!db || !sessionId) return false
  try {
    const row = db.query("SELECT session_id FROM critic_passes WHERE session_id = ?").get(sessionId) as { session_id: string } | null
    return row != null
  } catch (e) {
    degrade(e, "hasCriticPass")
    return false
  }
}

/** 清一條 pass 旗標（會話拆除時用；冪等）。fail-open。 */
export function deleteCriticPass(sessionId: string): void {
  if (!db || !sessionId) return
  try {
    db.query("DELETE FROM critic_passes WHERE session_id = ?").run(sessionId)
  } catch (e) {
    degrade(e, "deleteCriticPass")
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
