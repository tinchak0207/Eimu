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
 *      - 一次性注入標記（vettingInjected / userMemory）
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
import { MergedReplayFrame } from "./replay-frame.ts"
import type { SteerCommand, SteerLedgerStore } from "./steer-identity.ts"

// ---- 型別 ----

/** 可持久化的 SessionState 子集（結構化 duck-type，避免與 index.ts 循環 import）。 */
export interface PersistableState {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  eventCounter: number
  replayBuffer: { id: number; frame: Uint8Array; strippable?: boolean }[]
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
  compact?: { lastCount: number; at: number }
  /** N1（2026-08-27）：in-flight turn 打點——turn 開始時寫入、正常結束清零；
   *  gateway 重啟後恢復會話時據此判斷是否要自動重投 lastPromptBody。 */
  lastTurnActiveAt?: number
  /** 會話摘要標題（2026-09-12）：opencode 首條用戶消息後異步生成，gateway
   *  在 session.idle 鉤子抓取後鏡像進 state 並隨防抖落盤；null/undef=尚未生成。 */
  sessionTitle?: string | null
  /** 2026-10-02：模板偏離 token（網關簽發、單次核銷、TTL 15 分）。落持久層＝跨
   *  agent-gateway 重啟存活（否則用戶批准過的偏離出口會被重啟關上）。 */
  tplDeviateToken?: { token: string; at: number } | null
}

/** DB row 的 data 欄位 JSON 形狀（Map/Set 均序列化為陣列）。 */
interface PersistedData {
  eventCounter: number
  replayBuffer: { id: number; frame: string; merge?: { name: string; ids: number[]; lens: number[] }; strippable?: boolean }[]
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
  compact?: { lastCount: number; at: number }
  lastTurnActiveAt?: number
  /** 會話摘要標題鏡像（2026-09-12）：null=尚未生成（佔位標題已在抓取側歸一化掉）。 */
  title?: string | null
  /** 2026-10-02：模板偏離 token 鏡像（shape 防護在 hydrateRow，壞形狀一律還原為 null）。 */
  tplDeviateToken?: { token: string; at: number } | null
}

export interface PersistedRow {
  sessionId: string
  apiKey: string
  opencodeSessionId: string
  createdAt: number
  updatedAt: number
  data: PersistedData
}

// 注意：DB 路徑在模組載入時固定。bun test 會並行跑多個測試檔且共用本模組單例；
// 若在 initPersistence() 重新讀 env，各檔會互相把 db 連線指向不同檔案（隔離競態，
// 實測會打斷 steer-ledger-db 的持久層斷言）。故維持單一路徑、全進程共享。
const DB_PATH = process.env.SESSIONS_DB_PATH || "/opt/agent-harness/gateway/sessions.db"

/** 目前使用的 DB 檔路徑（診斷／測試讀回用；唯讀）。 */
export function currentDbPath(): string {
  return DB_PATH
}

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
    // REQ-D2b（2026-09-23）：steer 命令身份（tombstone）持久化。**復用同一 bun:sqlite 實例**
    // （同一 DB 檔、同一連線，非自造第二套持久層，與 subagent_reworks / critic_passes 同慣例）。
    //
    // 為什麼要它：F-D2 的去重住在記憶體 pendingSteers（上限 3），重啟即失——同一條指引
    // 可以被投遞第二次。這裡在**投遞之前**凍結 steer_id + payload_hash（含 content 與
    // turn/session 標識），終態即 tombstone。
    //
    // tombstone 生命週期（刻意設計，勿「順手清理」）：
    //   * 本表**不提供 delete**：沒有 deleteSteerCommand、也不進 sweepStaleRows。
    //   * deleteSessionRow（clear/刪會話）只動 sessions 表 → tombstone 逐條存活。
    //   * 終態 row 永不刪除：刪掉它就等於把「這條已經投遞過」的記憶抹去，重啟後又能重放。
    //     代價是表單調成長（每會話 ≤ 用戶實際發過的指引條數），由 idx_steer_commands_session 支撐查詢。
    db.exec(`
      CREATE TABLE IF NOT EXISTS steer_commands (
        steer_id     TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        owner_key    TEXT NOT NULL,
        alias_ids    TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload      TEXT NOT NULL,
        state        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        dispatched_at INTEGER,
        settled_at   INTEGER,
        reason       TEXT,
        updated_at   INTEGER NOT NULL
      )
    `)
    db.exec("CREATE INDEX IF NOT EXISTS idx_steer_commands_session ON steer_commands(session_id)")
    // D7（2026-10-02）：品質量測基座。此前 critic_passes 只存 session_id/created_at、無 verdict，
    // subagent_reworks 終局刪除無終身計數、無重問率——「品質」在系統裡完全不可觀測
    // （ARCH-V4-DESIGN D7；LESSONS L8）。三張表皆復用同一 bun:sqlite 實例（不造第二套持久層）。
    //   * critic_verdicts：每次審核的判決（pass/reject/unknown、判詞、judge 模型）。score 暫 null
    //     （rubric 尚未存在；不偽造數字），留欄位給後續 rubric 上線。
    //   * expert_lessons：失敗模式永久留存（交付閘門缺欄、審核退回等），供按 agent 累積。
    //   * deliveries：交付事件（成功落盤的產物），重問率＝同 (session, agent, label) 再次出現的比例。
    db.exec(`
      CREATE TABLE IF NOT EXISTS critic_verdicts (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        run_id       TEXT,
        agent        TEXT,
        label        TEXT,
        verdict      TEXT NOT NULL,
        score        REAL,
        judge_model  TEXT,
        verdict_text TEXT,
        created_at   INTEGER NOT NULL
      )
    `)
    db.exec("CREATE INDEX IF NOT EXISTS idx_critic_verdicts_session ON critic_verdicts(session_id)")
    db.exec("CREATE INDEX IF NOT EXISTS idx_critic_verdicts_agent ON critic_verdicts(agent)")
    db.exec(`
      CREATE TABLE IF NOT EXISTS expert_lessons (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        agent        TEXT NOT NULL,
        run_id       TEXT,
        source       TEXT NOT NULL,
        failure_mode TEXT NOT NULL,
        detail       TEXT,
        created_at   INTEGER NOT NULL
      )
    `)
    db.exec("CREATE INDEX IF NOT EXISTS idx_expert_lessons_agent ON expert_lessons(agent)")
    db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        run_id       TEXT,
        agent        TEXT,
        label        TEXT,
        rel_path     TEXT,
        contract_ok  INTEGER,
        created_at   INTEGER NOT NULL
      )
    `)
    db.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_session ON deliveries(session_id)")
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
    replayBuffer: state.replayBuffer.map((f) =>
      f instanceof MergedReplayFrame
        ? { id: f.id, frame: textDecoder.decode(f.frame), merge: f.toPersisted() }
        : { id: f.id, frame: textDecoder.decode(f.frame), ...(f.strippable === false ? { strippable: false } : {}) },
    ),
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
    compact: state.compact,
    lastTurnActiveAt: state.lastTurnActiveAt,
    title: state.sessionTitle ?? null,
    tplDeviateToken: state.tplDeviateToken ?? null,
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
    replayBuffer: (d.replayBuffer ?? []).map(
      (f) => (f.merge && MergedReplayFrame.fromPersisted(f.frame, f.merge)) ||
        { id: f.id, frame: textEncoder.encode(f.frame), ...(f.strippable === false ? { strippable: false } : {}) },
    ),
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
    compact: d.compact,
    lastTurnActiveAt: typeof d.lastTurnActiveAt === "number" ? d.lastTurnActiveAt : 0,
    sessionTitle: typeof d.title === "string" && d.title ? d.title : null,
    // 2026-10-02：模板偏離 token 形狀防護——非物件/缺 token 字串 → null；
    // at 非有限數 → 以當下時刻起算（保守：不因壞 at 讓 token 永不過期）。
    tplDeviateToken: (() => {
      const t = d.tplDeviateToken
      if (!t || typeof t !== "object") return null
      const token = (t as { token?: unknown }).token
      if (typeof token !== "string" || !token) return null
      const at = (t as { at?: unknown }).at
      return { token, at: typeof at === "number" && Number.isFinite(at) ? at : Date.now() }
    })(),
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
  /** 野獸模式（MOE 改革，2026-09-08）：settings 布林，dispatch 時快照進 subagent run。 */
  beast_mode?: boolean
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

// ---- D7（2026-10-02）：品質量測基座存取。全部 fail-open（量測不得影響交付主流程）----

let d7Seq = 0
function d7Id(prefix: string): string {
  d7Seq = (d7Seq + 1) % 1_000_000
  return `${prefix}-${Date.now().toString(36)}-${d7Seq.toString(36)}`
}

/** 記一筆審核判決（critic_verdicts）。score 未量測時傳 null，不得填 0 假值。 */
export function saveCriticVerdict(v: {
  sessionId: string
  runId?: string
  agent?: string
  label?: string
  verdict: "pass" | "reject" | "unknown"
  score?: number | null
  judgeModel?: string
  verdictText?: string
}): void {
  if (!db || !v.sessionId) return
  try {
    db.query(
      `INSERT OR REPLACE INTO critic_verdicts (id, session_id, run_id, agent, label, verdict, score, judge_model, verdict_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      v.runId ? `cv-${v.runId}` : d7Id("cv"),
      v.sessionId,
      v.runId ?? null,
      v.agent ?? null,
      v.label ?? null,
      v.verdict,
      typeof v.score === "number" ? v.score : null,
      v.judgeModel ?? null,
      (v.verdictText ?? "").slice(0, 4000),
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveCriticVerdict")
  }
}

/** 讀一筆審核判決（診斷／驗收用；唯讀）。查無回 null。 */
export function getCriticVerdictByRun(
  runId: string,
): { verdict: string; score: number | null; judge_model: string | null; verdict_text: string | null } | null {
  if (!db || !runId) return null
  try {
    return (
      (db
        .query("SELECT verdict, score, judge_model, verdict_text FROM critic_verdicts WHERE run_id = ?")
        .get(runId) as { verdict: string; score: number | null; judge_model: string | null; verdict_text: string | null } | null) ?? null
    )
  } catch (e) {
    degrade(e, "getCriticVerdictByRun")
    return null
  }
}

/** 永久留存一個失敗模式（expert_lessons）。 */
export function saveExpertLesson(l: {
  sessionId: string
  agent: string
  runId?: string
  source: string
  failureMode: string
  detail?: string
}): void {
  if (!db || !l.sessionId || !l.agent) return
  try {
    db.query(
      `INSERT INTO expert_lessons (id, session_id, agent, run_id, source, failure_mode, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d7Id("el"),
      l.sessionId,
      l.agent,
      l.runId ?? null,
      l.source,
      (l.failureMode || "").slice(0, 500),
      (l.detail ?? "").slice(0, 4000),
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveExpertLesson")
  }
}

/** 記一筆交付事件（deliveries）。重問率＝同 (session, agent, label) 重複出現的比例。 */
export function saveDelivery(d: {
  sessionId: string
  runId?: string
  agent?: string
  label?: string
  relPath?: string
  contractOk?: boolean
}): void {
  if (!db || !d.sessionId) return
  try {
    db.query(
      `INSERT OR REPLACE INTO deliveries (id, session_id, run_id, agent, label, rel_path, contract_ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.runId ? `dl-${d.runId}` : d7Id("dl"),
      d.sessionId,
      d.runId ?? null,
      d.agent ?? null,
      d.label ?? null,
      d.relPath ?? null,
      d.contractOk === undefined ? null : d.contractOk ? 1 : 0,
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveDelivery")
  }
}

/** D7 量測讀數：品質訊號數量與重問率（供 EVAL 直接用；唯讀）。 */
export function qualitySignalStats(): {
  criticVerdicts: number
  rejects: number
  expertLessons: number
  deliveries: number
  reaskRate: number
} {
  const empty = { criticVerdicts: 0, rejects: 0, expertLessons: 0, deliveries: 0, reaskRate: 0 }
  if (!db) return empty
  try {
    const cv = (db.query("SELECT COUNT(*) AS n FROM critic_verdicts").get() as { n: number } | null)?.n ?? 0
    const rj = (db.query("SELECT COUNT(*) AS n FROM critic_verdicts WHERE verdict = 'reject'").get() as { n: number } | null)?.n ?? 0
    const el = (db.query("SELECT COUNT(*) AS n FROM expert_lessons").get() as { n: number } | null)?.n ?? 0
    const dl = (db.query("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number } | null)?.n ?? 0
    const dup = (
      db
        .query(
          "SELECT COALESCE(SUM(c - 1), 0) AS n FROM (SELECT COUNT(*) AS c FROM deliveries GROUP BY session_id, agent, label HAVING c > 1)",
        )
        .get() as { n: number } | null
    )?.n ?? 0
    return { criticVerdicts: cv, rejects: rj, expertLessons: el, deliveries: dl, reaskRate: dl > 0 ? dup / dl : 0 }
  } catch (e) {
    degrade(e, "qualitySignalStats")
    return empty
  }
}

// ---- REQ-D2b（2026-09-23）：steer 命令身份（tombstone）存取 ----
// 純語義（狀態機／payload 凍結／受理判定）在 steer-identity.ts；本節只做 SQLite 存取，
// 實作 SteerLedgerStore 縫（見 steer-identity.createSteerLedger）。
// **刻意不提供刪除函數**：終態 row 就是 tombstone，刪掉它＝重啟後同一條指引又能被投遞
// （見 initPersistence 的建表註釋）。clear/刪會話（deleteSessionRow）與 sweepStaleRows
// 都不碰本表。

interface SteerCommandRow {
  steer_id: string
  session_id: string
  owner_key: string
  alias_ids: string
  payload_hash: string
  payload: string
  state: string
  created_at: number
  dispatched_at: number | null
  settled_at: number | null
  reason: string | null
}

function parseSteerRow(row: SteerCommandRow): SteerCommand {
  let aliases: string[] = []
  try {
    const parsed = JSON.parse(row.alias_ids) as unknown
    if (Array.isArray(parsed)) aliases = parsed.filter((x): x is string => typeof x === "string")
  } catch {
    aliases = [] // 壞損的別名欄不影響主鍵身份（寧可少認別名，不可拒真身）
  }
  return {
    steerId: row.steer_id,
    sessionId: row.session_id,
    ownerKey: row.owner_key,
    aliasIds: aliases,
    payloadHash: row.payload_hash,
    payload: row.payload,
    state: row.state as SteerCommand["state"],
    at: row.created_at,
    ...(typeof row.dispatched_at === "number" ? { dispatchedAt: row.dispatched_at } : {}),
    ...(typeof row.settled_at === "number" ? { settledAt: row.settled_at } : {}),
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
  }
}

const STEER_ROW_COLS =
  "steer_id, session_id, owner_key, alias_ids, payload_hash, payload, state, created_at, dispatched_at, settled_at, reason"

/**
 * 讀一條命令：先按主鍵，再按別名 id（同文去重時第二個 id 是同一個邏輯 steer，
 * 它的重放同樣必須命中 tombstone）。
 *
 * D-7b（2026-09-23）修掉的假命中：別名查詢原本是 `alias_ids LIKE '%"<id>"%'`，而 steer id
 * 的字元集（steer-core.STEER_ID_PATTERN）**含底線 `_`**——`_` 是 LIKE 的單字元通配符，
 * 於是查 `steer-p_q` 會命中別人的別名 `steer-pXq`：一顆與本請求無關的假 409（不會重複
 * 投遞，但把「不存在」說成了「已存在」）。改成 JSON 陣列的元素級**精確等值**比對
 * （json_each）：不靠轉義、也不靠「id 不含引號」這類外部假設，任何 id 都不會誤命中他人。
 */
export function loadSteerCommand(steerId: string): SteerCommand | null {
  if (!db || !steerId) return null
  try {
    const row = db.query(`SELECT ${STEER_ROW_COLS} FROM steer_commands WHERE steer_id = ?`).get(steerId) as SteerCommandRow | null
    if (row) return parseSteerRow(row)
    const byAlias = db
      .query(
        // CASE 保序：json_valid 為假時不求值 json_each——壞損的別名欄只讓「自己」不被認作別名
        // （與 parseSteerRow 同一個政策：寧可少認別名，不可讓一行壞資料炸掉整次查詢）。
        `SELECT ${STEER_ROW_COLS} FROM steer_commands
          WHERE CASE WHEN json_valid(steer_commands.alias_ids)
                     THEN EXISTS (SELECT 1 FROM json_each(steer_commands.alias_ids) WHERE json_each.value = ?)
                     ELSE 0 END`,
      )
      .get(steerId) as SteerCommandRow | null
    return byAlias ? parseSteerRow(byAlias) : null
  } catch (e) {
    degrade(e, "loadSteerCommand")
    return null
  }
}

/** 讀一個會話的命令全表（重啟恢復掃描用；按建立時間升序＝投遞順序）。 */
export function loadSteerCommandsForSession(sessionId: string): SteerCommand[] {
  if (!db || !sessionId) return []
  try {
    const rows = db
      .query(`SELECT ${STEER_ROW_COLS} FROM steer_commands WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as SteerCommandRow[]
    return rows.map(parseSteerRow)
  } catch (e) {
    degrade(e, "loadSteerCommandsForSession")
    return []
  }
}

/**
 * 寫入/更新一條命令（steer_id 主鍵 UPSERT）。fail-open 同全局策略。
 * 注意：寫入即「身份已凍結」，即使後續流程失敗也不回滾——寧可留下未終結的記錄
 * （重啟恢復會把它落 uncertain），不可留下「查不到＝可重放」的漏洞。
 */
export function saveSteerCommand(c: SteerCommand): void {
  if (!db || !c.steerId) return
  try {
    db.query(
      `INSERT INTO steer_commands
        (steer_id, session_id, owner_key, alias_ids, payload_hash, payload, state, created_at, dispatched_at, settled_at, reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(steer_id) DO UPDATE SET
         session_id = excluded.session_id,
         owner_key = excluded.owner_key,
         alias_ids = excluded.alias_ids,
         payload_hash = excluded.payload_hash,
         payload = excluded.payload,
         state = excluded.state,
         dispatched_at = excluded.dispatched_at,
         settled_at = excluded.settled_at,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    ).run(
      c.steerId,
      c.sessionId,
      c.ownerKey,
      JSON.stringify(c.aliasIds ?? []),
      c.payloadHash,
      c.payload,
      c.state,
      c.at,
      c.dispatchedAt ?? null,
      c.settledAt ?? null,
      c.reason ?? null,
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveSteerCommand")
  }
}

/** persistence.ts 對 steer-identity 的 SteerLedgerStore 縫實作（生產側唯一接線）。 */
export const steerCommandStore: SteerLedgerStore = {
  read: loadSteerCommand,
  readBySession: loadSteerCommandsForSession,
  write: saveSteerCommand,
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
