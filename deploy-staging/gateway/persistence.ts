/**
 * persistence.ts — 服务端会话持久化（bun:sqlite，零新依赖）
 *
 * 架构决策（2026-08-21）：
 * 1. 讯息历史的权威拥有者是 opencode serve（它自己的存储在 gateway 重启后仍完整存在）。
 *    gateway 不复制 messages 进自己的 DB —— 那会制造第二份会漂移的历史副本。
 *    gateway 需要持久化的只有自己拥有的那部分状态：
 *      - 身分映射：gateway sessionId ↔ opencode session id ↔ owner key
 *      - SSE replayBuffer（最近 REPLAY_BUFFER_SIZE 帧，断线/重启后前端 Last-Event-ID 续传用）
 *      - 事件翻译去重状态（messageRole / suppressedParts 等有界集合）
 *      - 一次性注入标记（vettingInjected / userMemory）
 *      - 画布摘要（canvasSummary）
 *      - 摘要压缩水位（compact.lastCount）
 * 2. 存储选 bun:sqlite（bun 内建）：单文件 /opt/eimu-harness/state/sessions.db、
 *    WAL 模式、同步 API（getOwnedSession 是同步函数，lazy reload 不用改异步签名）。
 *    ⚠ db 必须放在 release 目录**之外**（2026-10-13「会话丢失」事故）：放在 release
 *    目录内时，每次发版换 symlink 会连库一起被换掉，新会话随旧 release 一起消失。
 * 3. 写入时机：dirty 标记 + 3s 防抖 flush（index.ts 持有 flush 循环），关键转换点
 *    （建立/删除）同步写；SIGTERM 时补一次 flush。重启最多丢 3s 内的 replay 帧，
 *    讯息本身永远安全在 opencode。
 * 4. 失败语义 fail-open：DB 不可用时只记日志、退回纯内存行为（与旧版一致），
 *    绝不让持久化故障杀死 gateway。
 */

import { Database } from "bun:sqlite"
import { MergedReplayFrame } from "./replay-frame.ts"
import type { SteerCommand, SteerLedgerStore } from "./steer-identity.ts"
import { redactForLog } from "./analytics-meta.ts"

// ---- 型别 ----

/** 可持久化的 SessionState 子集（结构化 duck-type，避免与 index.ts 循环 import）。 */
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
  /** 画布持久快照（canvas.node.* 事件套用后的节点/连线），重启后回灌 canvasStates。 */
  canvasSnapshot?: { nodes?: unknown[]; connections?: unknown[]; [k: string]: unknown }
  /** 工作流持久快照（与 canvasSnapshot 同构）：ActiveWorkflow 的可恢复子集
   *  （模板 id、节点流、节点状态/结果/成本），重启后回灌 workflows Map。 */
  workflowSnapshot?: Record<string, unknown>
  vettingInjected: boolean
  userMemory?: { user_profile: Record<string, unknown>; lessons: string[] }
  profileOnboardingPending?: boolean
  compact?: { lastCount: number; at: number }
  /** N1（2026-08-27）：in-flight turn 打点——turn 开始时写入、正常结束清零；
   *  gateway 重启后恢复会话时据此判断是否要自动重投 lastPromptBody。 */
  lastTurnActiveAt?: number
  /** 会话摘要标题（2026-09-12）：opencode 首条用户消息后异步生成，gateway
   *  在 session.idle 钩子抓取后镜像进 state 并随防抖落盘；null/undef=尚未生成。 */
  sessionTitle?: string | null
  /** 2026-10-02：模板偏离 token（网关签发、单次核销、TTL 15 分）。落持久层＝跨
   *  agent-gateway 重启存活（否则用户批准过的偏离出口会被重启关上）。 */
  tplDeviateToken?: { token: string; at: number } | null
}

/** DB row 的 data 栏位 JSON 形状（Map/Set 均序列化为阵列）。 */
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
  /** 会话摘要标题镜像（2026-09-12）：null=尚未生成（占位标题已在抓取侧归一化掉）。 */
  title?: string | null
  /** 2026-10-02：模板偏离 token 镜像（shape 防护在 hydrateRow，坏形状一律还原为 null）。 */
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

// 注意：DB 路径在模组载入时固定。bun test 会并行跑多个测试档且共用本模组单例；
// 若在 initPersistence() 重新读 env，各档会互相把 db 连线指向不同档案（隔离竞态，
// 实测会打断 steer-ledger-db 的持久层断言）。故维持单一路径、全进程共享。
const DB_PATH = process.env.SESSIONS_DB_PATH || "/opt/eimu-harness/state/sessions.db"

/** 目前使用的 DB 档路径（诊断／测试读回用；唯读）。 */
export function currentDbPath(): string {
  return DB_PATH
}

let db: Database | null = null

// 2026-10-13「会话丢失」事故：旧实作用 warned 旗标只在**首次**失败时记一条日志，
// 之后整个进程静音 —— 生产上连续 11 小时写失败却只有一行日志，没人发现。
// 静默退化本身是事故的一部分，改为节流上报（首条立刻，其后每 30s 至多一条）。
let lastPersistError: { where: string; message: string; at: number } | null = null
let lastDegradeLogAt = 0

function degrade(e: unknown, where: string): void {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  lastPersistError = { where, message, at: Date.now() }
  const now = Date.now()
  if (now - lastDegradeLogAt > 30_000) {
    lastDegradeLogAt = now
    console.error(redactForLog(`[gateway] persistence degraded (${where}): ${message}`))
  }
}

/** 保存失败/成功都必须经过这里记帐：失败 → 记下并节流上报；成功 → 若刚从失败中恢复就报一条恢复日志。 */
function noteSaveFailure(e: unknown, where: string): void {
  degrade(e, where)
}

function noteSaveSuccess(): void {
  if (lastPersistError) {
    console.log(redactForLog(`[gateway] persistence recovered (was failing: ${lastPersistError.where}: ${lastPersistError.message})`))
    lastPersistError = null
  }
}

/** 只读诊断视图（/healthz 用）：ready=false 表示「重启会丢新会话」。 */
export function persistenceStatus(): { ready: boolean; dbPath: string; lastError: string | null; lastErrorWhere: string | null } {
  return {
    ready: db !== null && lastPersistError === null,
    dbPath: DB_PATH,
    lastError: lastPersistError?.message ?? null,
    lastErrorWhere: lastPersistError?.where ?? null,
  }
}

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

// ---- 初始化 ----

// ---- schema 版本化迁移（2026-10-02）----
// 设计取自 Claude Code 的 `CURRENT_MIGRATION_VERSION` ＋ `runMigrations()`（main.tsx:326-352）
// 与各 migrateXxx 档「失败只记 event、不 throw」的容错（migrateEnableAllProjectMcpServersToSettings.ts:109-117）
// ——只取设计概念，未复制其程式码。
// 我方差异（理由写明）：
//   * 版本载体＝SQLite `PRAGMA user_version`（不另立 config 档；DB 自带版本，备份/复制时版本跟著走）。
//   * 版本只推进到**连续成功**处：SQL schema 有顺序依赖，跳过失败版会让后续版跑在未升级的 schema 上；
//     故失败时**不越过它**，但**不 throw**——记结构化事件（journal ＋ 回传 failures）后继续尝试后续
//     版本（各版自身幂等、互不依赖），最后把 user_version 写到连续成功的最后一版。fail-open 与本档
//     全局策略一致：迁移故障不得杀死 gateway。
//   * 每个 migration 内部一律 `IF NOT EXISTS`／先检查后动，故可安全重复执行（idempotent）。
//
// ⚠ 新增栏位的同步清单（现场清点，2026-10-02；漏一处即已踩过的雷）：
//   一个「持久化到 sessions.data JSON」的新栏位必须同步改：
//     A. PersistableState 介面（本档）——记忆体状态的持久化子集
//     B. PersistedData 介面（本档）——落盘 JSON 形状
//     C. serialize()（本档）——写盘白名单；漏加＝永远不落盘
//     D. hydrateRow()（本档）——读回还原；漏加＝重启后旗标丢失（2026-10-02 replay strippable 已踩）
//     E. PERSISTED_DATA_KEYS（本档）——集合式守门清单，与 C 的输出键集逐项相等
//     F. types-gateway.ts 的 SessionState（不在本档）——持久化栏位的上游宣告
//     G. 若是**顶层 DB 栏**（非 data JSON 内）→ 另需在 baselineSchema 加栏，并新增一笔
//        `ALTER TABLE ... ADD COLUMN` 的 migration（版本 +1）；旧库才不会缺栏
//     H. 命名别名：state 栏位与 JSON 栏位名不同处（如 sessionTitle ↔ title）两边必须各自对齐
//     I. 只改单栏的 helper（如 setRowTitle）需评估是否也要处理新栏位
//   守门测试：persistence-schema.test.ts 断言 serialize() 输出键集 == PERSISTED_DATA_KEYS，
//   且每个落盘键在 hydrateRow() 输出都能找到（含别名映射）——只改 A/C 忘改 D/E 即失败。

export const SCHEMA_VERSION = 4

export interface Migration {
  version: number
  name: string
  up(database: Database): void
}

export interface MigrationReport {
  from: number
  to: number
  applied: number[]
  failures: { version: number; name: string; error: string }[]
}

/** 读 `PRAGMA user_version`（SQLite 内建版本载体）；坏掉/缺栏一律视为 0。 */
export function readUserVersion(database: Database): number {
  try {
    const row = database.query("PRAGMA user_version").get() as { user_version?: number } | null
    return typeof row?.user_version === "number" ? row.user_version : 0
  } catch {
    return 0
  }
}

function writeUserVersion(database: Database, version: number): void {
  database.exec(`PRAGMA user_version = ${Math.max(0, Math.floor(version))}`)
}

/**
 * v1 baseline：完整初始 schema（全部 `IF NOT EXISTS`）。新库与旧库共用——旧库已有部分表时
 * 只补缺的，**不动既有资料**，故对 2026-10-02 前已上线的生产库（user_version=0 但表已存在）
 * 亦安全。此函数亦是把原本散在 initPersistence 的 DDL 收拢后的唯一建表处。
 */
function baselineSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      owner_key          TEXT NOT NULL,
      opencode_session_id TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      data               TEXT NOT NULL
    )
  `)
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_opencode ON sessions(opencode_session_id)")
  // 用户级 settings（2026-08-29）：key 维度，owner_key 与 sessions.owner_key
  // 同一个 key（归一化方式一致——都是 gateway 收到的原样 Bearer key）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      owner_key  TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // 刀 F（2026-09-15）：in-flight rework run 持久化（重启存活）。复用同一 bun:sqlite
  // 实例（同一 DB 层、非自造第二套持久层）——重启时启动扫描据此判断孤儿，
  // finishRun 终态即删。child_oc 为探针目标，run_id 主键保幂等。
  database.exec(`
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
  // 刀 2（2026-09-15）：机器 critic pass 的每会话一次性旗标。同 subagent_reworks 惯例：
  // 复用同一 bun:sqlite 实例（非自造第二套持久层），session_id 主键保幂等；写入即
  // 「本会话已用掉唯一一次 machine critic pass」，重启后仍成立（防重启绕过 ≤1 上限）。
  database.exec(`
    CREATE TABLE IF NOT EXISTS critic_passes (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `)
  // REQ-D2b（2026-09-23）：steer 命令身份（tombstone）持久化。**复用同一 bun:sqlite 实例**
  // （同一 DB 档、同一连线，非自造第二套持久层，与 subagent_reworks / critic_passes 同惯例）。
  //
  // 为什么要它：F-D2 的去重住在记忆体 pendingSteers（上限 3），重启即失——同一条指引
  // 可以被投递第二次。这里在**投递之前**冻结 steer_id + payload_hash（含 content 与
  // turn/session 标识），终态即 tombstone。
  //
  // tombstone 生命周期（刻意设计，勿「顺手清理」）：
  //   * 本表**不提供 delete**：没有 deleteSteerCommand、也不进 sweepStaleRows。
  //   * deleteSessionRow（clear/删会话）只动 sessions 表 → tombstone 逐条存活。
  //   * 终态 row 永不删除：删掉它就等于把「这条已经投递过」的记忆抹去，重启后又能重放。
  //     代价是表单调成长（每会话 ≤ 用户实际发过的指引条数），由 idx_steer_commands_session 支撑查询。
  database.exec(`
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
  database.exec("CREATE INDEX IF NOT EXISTS idx_steer_commands_session ON steer_commands(session_id)")
  // D7（2026-10-02）：品质量测基座。此前 critic_passes 只存 session_id/created_at、无 verdict，
  // subagent_reworks 终局删除无终身计数、无重问率——「品质」在系统里完全不可观测
  // （ARCH-V4-DESIGN D7；LESSONS L8）。三张表皆复用同一 bun:sqlite 实例（不造第二套持久层）。
  //   * critic_verdicts：每次审核的判决（pass/reject/unknown、判词、judge 模型）。score 暂 null
  //     （rubric 尚未存在；不伪造数字），留栏位给后续 rubric 上线。
  //   * expert_lessons：失败模式永久留存（交付闸门缺栏、审核退回等），供按 agent 累积。
  //   * deliveries：交付事件（成功落盘的产物），重问率＝同 (session, agent, label) 再次出现的比例。
  database.exec(`
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
  database.exec("CREATE INDEX IF NOT EXISTS idx_critic_verdicts_session ON critic_verdicts(session_id)")
  database.exec("CREATE INDEX IF NOT EXISTS idx_critic_verdicts_agent ON critic_verdicts(agent)")
  database.exec(`
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
  database.exec("CREATE INDEX IF NOT EXISTS idx_expert_lessons_agent ON expert_lessons(agent)")
  database.exec(`
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
  database.exec("CREATE INDEX IF NOT EXISTS idx_deliveries_session ON deliveries(session_id)")
}

/**
 * v2：会话目录查询索引。`listSessionRows` 用 `WHERE owner_key = ? ORDER BY updated_at DESC`，
 * 旧 schema 只有 opencode_session_id 的唯一索引，目录查询全表扫描。纯索引、不动任何资料。
 */
function sessionsOwnerUpdatedIndex(database: Database): void {
  database.exec("CREATE INDEX IF NOT EXISTS idx_sessions_owner_updated ON sessions(owner_key, updated_at DESC)")
}

/**
 * v3（2026-10-03）：「评审可计量」——把 critic 闸门从布林＋词表升级为可入库的数值＋代码强制阈值
 * ＋人工标签 join。基座（critic_verdicts 表 / delivery-gate.ts 词表）已存在，本版只补缺的两件事：
 *   * critic_verdicts 增 `score_source`（分数来源：measured｜model_self｜human；无分数时 null）。
 *     语义钉死：数值阈值**只对 measured 生效**，模型自评（model_self）／人工标签（human）永不构成
 *     验收 oracle（禁同源断言）。没有独立量测来源时 score 与 score_source 皆维持 null，不填 0 假值。
 *   * human_labels 新表：人工 accept/reject 标签，join 进 qualitySignalStats 的 acceptRate。
 * 为什么独立在 v3 而非改 v1 baseline：v1 已发布，旧库 user_version>=1 时 v1 不再重跑；
 * 新表/新栏必须靠新版本迁移补上（否则旧库永远缺栏）。全部 idempotent（PRAGMA 先检查、IF NOT EXISTS）。
 */
function qualityMeasurableSchema(database: Database): void {
  const cols = database.query("PRAGMA table_info(critic_verdicts)").all() as { name: string }[]
  if (!cols.some((c) => c.name === "score_source")) {
    database.exec("ALTER TABLE critic_verdicts ADD COLUMN score_source TEXT")
  }
  // 人工标签：一笔 = 一个交付被人工接受或拒绝。run_id 为主键后缀，同 run 重复标注＝覆写。
  database.exec(`
    CREATE TABLE IF NOT EXISTS human_labels (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id     TEXT,
      agent      TEXT,
      label      TEXT NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  database.exec("CREATE INDEX IF NOT EXISTS idx_human_labels_session ON human_labels(session_id)")
  database.exec("CREATE INDEX IF NOT EXISTS idx_human_labels_run ON human_labels(run_id)")
}

/** 有序迁移清单。新增版本一律 append（version 必须连续递增；已发布版本禁止改动其 up 内容）。 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "baseline-session-and-quality-schema", up: baselineSchema },
  { version: 2, name: "sessions-owner-updated-index", up: sessionsOwnerUpdatedIndex },
  { version: 3, name: "quality-measurable-score-and-human-labels", up: qualityMeasurableSchema },
  { version: 4, name: "durable-harness-security-state", up: (database) => {
    database.exec(`CREATE TABLE IF NOT EXISTS harness_security_state (
      namespace TEXT NOT NULL, state_key TEXT NOT NULL, data TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, state_key))`)
  } },
]

/** 安全状态不能沿用普通会话持久化的内存兜底：不可读写时拒绝操作。 */
function securityDatabase(): Database {
  if (!db) initPersistence()
  if (!db) throw new Error("harness_security_store_unavailable")
  return db
}

export function loadHarnessSecurityState(namespace: string, key: string): { data: unknown; revision: number } | null {
  const row = securityDatabase().query(
    "SELECT data, revision FROM harness_security_state WHERE namespace=? AND state_key=?",
  ).get(namespace, key) as { data: string; revision: number } | null
  if (!row) return null
  try {
    return { data: JSON.parse(row.data), revision: row.revision }
  } catch {
    throw new Error("harness_security_state_invalid")
  }
}

/** 乐观并发：旧进程/旧缓存不能覆盖另一进程刚保存的限制。 */
export function saveHarnessSecurityState(namespace: string, key: string, data: unknown, revision: number): number {
  const database = securityDatabase()
  const encoded = JSON.stringify(data)
  const result = revision === 0
    ? database.query(`INSERT OR IGNORE INTO harness_security_state
        (namespace,state_key,data,revision,updated_at) VALUES (?,?,?,1,?)`).run(namespace, key, encoded, Date.now())
    : database.query(`UPDATE harness_security_state SET data=?, revision=revision+1, updated_at=?
        WHERE namespace=? AND state_key=? AND revision=?`).run(encoded, Date.now(), namespace, key, revision)
  if (result.changes !== 1) throw new Error("harness_security_state_conflict")
  return revision + 1
}

export function deleteHarnessSecurityState(namespace: string, key: string): void {
  securityDatabase().query("DELETE FROM harness_security_state WHERE namespace=? AND state_key=?").run(namespace, key)
}

/** 计划与权限的切换必须同事务提交，失败时两边一并回滚。 */
export function withHarnessSecurityTransaction<T>(operation: () => T): T {
  return securityDatabase().transaction(operation).immediate()
}

/**
 * 依序跑完所有未套用的 migration（idempotent、逐版执行）。
 * - 先确保审计表 `schema_migrations` 存在（迁移清单之外，最先建立）。
 * - 只跑 `version > from` 的版本；已套用者跳过（重复呼叫不再变更）。
 * - 单一 migration 失败：不 throw，记结构化事件（journal ＋ failures）后**继续尝试后续版本**；
 *   user_version 只推进到「连续成功」的最后一版（不跳版，见档头理由）。
 * - 回传 MigrationReport 供测试与启动日志取用。
 */
export function runMigrations(database: Database): MigrationReport {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  const from = readUserVersion(database)
  const applied: number[] = []
  const failures: MigrationReport["failures"] = []
  let contiguous = from
  let gap = false
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    try {
      m.up(database)
      database
        .query("INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(m.version, m.name, Date.now())
      applied.push(m.version)
      if (!gap) contiguous = m.version
    } catch (e) {
      gap = true
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      failures.push({ version: m.version, name: m.name, error: msg })
      console.error(redactForLog(`[gateway] schema migration failed: version=${m.version} name=${m.name} err=${msg}`))
    }
  }
  if (contiguous !== from) writeUserVersion(database, contiguous)
  return { from, to: contiguous, applied, failures }
}

export function initPersistence(): void {
  try {
    db = new Database(DB_PATH, { create: true })
    db.exec("PRAGMA journal_mode=WAL")
    db.exec("PRAGMA synchronous=NORMAL")
    const report = runMigrations(db)
    // 2026-10-13：SQLite 权限不足时会静默把连接降级成只读（O_RDONLY），
    // 之后每次写都失败而 gateway 照常服务 —— 本次「会话丢失」正是如此。
    // 开库后立刻做一次真写探测（BEGIN IMMEDIATE 取写锁，随即回滚，不改数据），
    // 只读/不可写必须当场大声报出来，不许静默。
    try {
      db.exec("BEGIN IMMEDIATE")
    } catch (e) {
      noteSaveFailure(e, "init-write-probe")
      const message = e instanceof Error ? e.message : String(e)
      if (/readonly|read-only/i.test(message)) {
        console.error(
          redactForLog(`[gateway] FATAL: sessions db is READ-ONLY (${DB_PATH}): ${message} — new sessions WILL be lost on restart`),
        )
      }
    } finally {
      try { db.exec("ROLLBACK") } catch {}
    }
    console.log(
      redactForLog(
        `[gateway] session persistence ready: ${DB_PATH} (schema v${report.to}/${SCHEMA_VERSION}` +
          `${report.failures.length ? `, ${report.failures.length} migration failure(s)` : ""})`,
      ),
    )
  } catch (e) {
    degrade(e, "init")
    db = null
  }
}

// ---- 序列化 / 反序列化 ----

/**
 * 持久化 `data` JSON 的栏位全集——**新增栏位必须同步更新的集合式守门清单**。
 * 这份清单与 `serialize()` 的输出键集逐项相等；`hydrateRow()` 对每个键都必须还原
 * （别名映射见 persistence-schema.test.ts）。哪一天有人只改了 serialize 忘了清单/还原，
 * 测试会直接红。完整「新栏位需同步改哪几处」清单见档头 runMigrations 上方注解。
 */
export const PERSISTED_DATA_KEYS = [
  "eventCounter",
  "replayBuffer",
  "lastActivityAt",
  "partTextEmitted",
  "announcedUrls",
  "toolStatusSeen",
  "toolInvokeSeen",
  "stepCostLogged",
  "messageRole",
  "suppressedParts",
  "canvasSummary",
  "canvasSummaryAt",
  "canvasSnapshot",
  "workflowSnapshot",
  "vettingInjected",
  "userMemory",
  "profileOnboardingPending",
  "compact",
  "lastTurnActiveAt",
  "title", // 别名：记忆体 sessionTitle ↔ 落盘 title（见 hydrateRow）
  "tplDeviateToken",
] as const

export function serialize(state: PersistableState): PersistedData {
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
 * 从 DB row 重建完整 SessionState（含所有活跃结构的空容器）。
 * 回传物件形状与 index.ts 的 SessionState 完全一致（clients/pending* 为空）。
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
    // S2b：出站剥离器状态——回合级 ephemeral，不持久化（重启后新回合重建）。
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
    // 2026-10-02：模板偏离 token 形状防护——非物件/缺 token 字串 → null；
    // at 非有限数 → 以当下时刻起算（保守：不因坏 at 让 token 永不过期）。
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

export function saveSession(state: PersistableState): boolean {
  if (!db) {
    noteSaveFailure(new Error("persistence not initialized (db is null)"), "save")
    return false
  }
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
    noteSaveSuccess()
    return true
  } catch (e) {
    // UNIQUE(opencode_session_id) 冲突 = 旧 row 残留同 opencode id（如重启竞态），
    // 先删旧 row 再重试一次；再失败才判定本帧写入失败（回传 false，绝不假报成功）。
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
      noteSaveSuccess()
      return true
    } catch (e2) {
      noteSaveFailure(e2, "save")
      return false
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


// 会话目录：当前 key 的全部会话 row（按 updated_at 降序）。给
// GET /agent/v1/sessions 列表端点用；data 只解 lastActivityAt 一个字段，
// 不做完整 hydrate（目录不需要整包状态）。
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
 * 目录回填用：只改 data JSON 的 title 栏（读-改-写同 parseRow/listSessionRows
 * 的 JS 序列化链，不动 updated_at 以免打乱列表排序）。fail-open 同全局策略。
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
      return // data 坏损的行不强写，交由降级路径
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

// ---- 用户级 Settings（2026-08-29，key 维度）----
// 存储模式与 canvasSummary/userMemory 同构（JSON data 栏位），但归属维度是
// owner_key（用户级，跨会话共享），重启不丢。shape 校验在 index.ts，这里只存取。

export interface UserSettings {
  interrupt_mode: string
  persona: string
  cost_mode: string
  /** 野兽模式（MOE 改革，2026-09-08）：settings 布林，dispatch 时快照进 subagent run。 */
  beast_mode?: boolean
}

/** 读取 key 维度 settings；无记录回 null（呼叫端套默认值）。fail-open 同全局策略。 */
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

/** 写入 key 维度 settings（UPSERT）。 */
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

// 使用既有 settings 表的独立命名空间，以已鉴权 tenant 绑定模式；短效设备票不作 owner key。
// 明确授权持续有效，只有新的显式 mode 会覆盖它，不能按心跳超时撤销。
const tenantPermissionModes = new Map<string, "off" | "ask" | "auto" | "full">()

export function loadTenantPermissionMode(tenant: string): "off" | "ask" | "auto" | "full" | null {
  const cached = tenantPermissionModes.get(tenant)
  if (cached) return cached
  if (!db || !tenant) return null
  try {
    const row = db.query("SELECT data FROM user_settings WHERE owner_key = ?").get(`tenant-device-permission:${tenant}`) as { data: string } | null
    const mode = row ? JSON.parse(row.data)?.mode : null
    if (mode === "off" || mode === "ask" || mode === "auto" || mode === "full") {
      tenantPermissionModes.set(tenant, mode)
      return mode
    }
  } catch (e) { degrade(e, "loadTenantPermissionMode") }
  return null
}

export function saveTenantPermissionMode(tenant: string, mode: "off" | "ask" | "auto" | "full"): void {
  if (!tenant) return
  tenantPermissionModes.set(tenant, mode)
  if (!db) return
  try {
    db.query(
      `INSERT INTO user_settings (owner_key, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    ).run(`tenant-device-permission:${tenant}`, JSON.stringify({ mode }), Date.now())
  } catch (e) { degrade(e, "saveTenantPermissionMode") }
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

/** 写入/更新一条 rework run 记录（run_id 主键 UPSERT）。fail-open 同全局策略。 */
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

/** 读取全部 in-flight rework 记录（启动扫描用）。fail-open 回空阵列。 */
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

/** 删除一条 rework 记录（终态即清；幂等，run 不存在也成功）。fail-open。 */
export function deleteReworkRecord(runId: string): void {
  if (!db || !runId) return
  try {
    db.query("DELETE FROM subagent_reworks WHERE run_id = ?").run(runId)
  } catch (e) {
    degrade(e, "deleteReworkRecord")
  }
}

// ---- 刀 2（2026-09-15）：机器 critic pass 每会话一次性旗标 ----

/** 标记该会话已用掉 machine critic pass（session_id 主键，重复呼叫幂等）。fail-open。 */
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

/** 该会话是否已用过 machine critic pass。fail-open 回 false（呼叫端另有内存旗标兜底）。 */
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

/** 清一条 pass 旗标（会话拆除时用；幂等）。fail-open。 */
export function deleteCriticPass(sessionId: string): void {
  if (!db || !sessionId) return
  try {
    db.query("DELETE FROM critic_passes WHERE session_id = ?").run(sessionId)
  } catch (e) {
    degrade(e, "deleteCriticPass")
  }
}

// ---- D7（2026-10-02）：品质量测基座存取。全部 fail-open（量测不得影响交付主流程）----

/**
 * critic 分数来源（v3，2026-10-03）。
 *   * `measured`：存在**独立于被测模型**的量测来源（如对成品跑硬检）→ 唯一可套用数值阈值者。
 *   * `model_self`：同族模型自评 → 只作便宜、快、可当筛子的讯号，永不构成验收 oracle（禁同源断言）。
 *   * `human`：人工接受/拒绝 → 外生标签，另存 human_labels，不是数值量测。
 * 没有分数时 score 为 null、不得填 0 假值。score_source 是「这列分数讯号的来源」：
 * `model_self`／`human` 允许与 null score 并存（分类判决本就没有数值）；`measured` 则必须有数值，
 * 否则不落来源（宣告了量测就必须有数字，不得制造假量测）。
 */
export type CriticScoreSource = "measured" | "model_self" | "human"

let d7Seq = 0
function d7Id(prefix: string): string {
  d7Seq = (d7Seq + 1) % 1_000_000
  return `${prefix}-${Date.now().toString(36)}-${d7Seq.toString(36)}`
}

/**
 * 记一笔审核判决（critic_verdicts）。score 未量测时传 null，不得填 0 假值。
 * v3：支援 `scoreSource` 记录分数**来源**。反伪造不变式：
 *   * 有 score 但没标来源 → 来源留 null（不猜，不把自评冒充量测）；
 *   * 标 `measured` 却没有数值 → 来源强制 null（宣告了量测就必须有数值，否则不落 provenance）；
 *   * `model_self` / `human` 允许与 null score 并存（分类判决没有数值），但永不通过数值阈值。
 */
export function saveCriticVerdict(v: {
  sessionId: string
  runId?: string
  agent?: string
  label?: string
  verdict: "pass" | "reject" | "unknown"
  score?: number | null
  scoreSource?: CriticScoreSource | null
  judgeModel?: string
  verdictText?: string
}): void {
  if (!db || !v.sessionId) return
  try {
    const scoreNum = typeof v.score === "number" && Number.isFinite(v.score) ? v.score : null
    const declared = v.scoreSource ?? null
    const scoreSource = declared === "measured" && scoreNum === null ? null : declared
    // 真实审核回执必须完整落库；只截人话，不能切断当前artifact绑定JSON。
    const verdictLines = (v.verdictText ?? "").split("\n")
    const receiptLine = verdictLines.find((line) => line.startsWith("RECEIPT:"))
    const verdictText = receiptLine
      ? `${receiptLine}\n${verdictLines.filter((line) => line !== receiptLine).join("\n").slice(0, 4000)}`
      : (v.verdictText ?? "").slice(0, 4000)
    db.query(
      `INSERT OR REPLACE INTO critic_verdicts (id, session_id, run_id, agent, label, verdict, score, score_source, judge_model, verdict_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      v.runId ? `cv-${v.runId}` : d7Id("cv"),
      v.sessionId,
      v.runId ?? null,
      v.agent ?? null,
      v.label ?? null,
      v.verdict,
      scoreNum,
      scoreSource,
      v.judgeModel ?? null,
      verdictText,
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveCriticVerdict")
  }
}

/** 读一笔审核判决（诊断／验收用；唯读）。查无回 null。 */
export function getCriticVerdictByRun(runId: string): {
  verdict: string
  score: number | null
  score_source: CriticScoreSource | null
  judge_model: string | null
  verdict_text: string | null
} | null {
  if (!db || !runId) return null
  try {
    return (
      (db
        .query("SELECT verdict, score, score_source, judge_model, verdict_text FROM critic_verdicts WHERE run_id = ?")
        .get(runId) as {
        verdict: string
        score: number | null
        score_source: CriticScoreSource | null
        judge_model: string | null
        verdict_text: string | null
      } | null) ?? null
    )
  } catch (e) {
    degrade(e, "getCriticVerdictByRun")
    return null
  }
}

/**
 * 记一笔人工验收标签（human_labels）。`label` ∈ accept|reject。
 * 幂等：同 run_id 重复标注＝INSERT OR REPLACE（最后一次为准，不长第二列）。
 * 这是「评审外生」的落点：人工接受/拒绝 join 进 qualitySignalStats 的 acceptRate。
 */
export function saveHumanLabel(h: {
  sessionId: string
  runId?: string
  agent?: string
  label: "accept" | "reject"
  note?: string
}): void {
  if (!db || !h.sessionId) return
  try {
    db.query(
      `INSERT OR REPLACE INTO human_labels (id, session_id, run_id, agent, label, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      h.runId ? `hl-${h.runId}` : d7Id("hl"),
      h.sessionId,
      h.runId ?? null,
      h.agent ?? null,
      h.label,
      (h.note ?? "").slice(0, 4000),
      Date.now(),
    )
  } catch (e) {
    degrade(e, "saveHumanLabel")
  }
}

/** 读某 run 的人工标签（诊断／验收用；唯读）。查无回 null。 */
export function getHumanLabelByRun(
  runId: string,
): { label: string; agent: string | null; note: string | null } | null {
  if (!db || !runId) return null
  try {
    return (
      (db
        .query("SELECT label, agent, note FROM human_labels WHERE run_id = ?")
        .get(runId) as { label: string; agent: string | null; note: string | null } | null) ?? null
    )
  } catch (e) {
    degrade(e, "getHumanLabelByRun")
    return null
  }
}

/** 永久留存一个失败模式（expert_lessons）。 */
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

/** 记一笔交付事件（deliveries）。重问率＝同 (session, agent, label) 重复出现的比例。 */
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

/** 同父会话的真实交付记录，研究前置与续跑复用既有产物，不另造准备状态。 */
export function loadSessionDeliveries(sessionId: string): Array<{ runId: string; agent: string; label: string; relPath: string }> {
  if (!db || !sessionId) return []
  try {
    return db.query("SELECT run_id AS runId, agent, label, rel_path AS relPath FROM deliveries WHERE session_id = ? AND run_id IS NOT NULL AND rel_path IS NOT NULL ORDER BY created_at").all(sessionId) as Array<{ runId: string; agent: string; label: string; relPath: string }>
  } catch (e) {
    degrade(e, "loadSessionDeliveries")
    return []
  }
}

/** D7 量测读数：品质讯号数量与重问率（供 EVAL 直接用；唯读）。 */
export function qualitySignalStats(): {
  criticVerdicts: number
  rejects: number
  expertLessons: number
  deliveries: number
  reaskRate: number
  /** 人工标签数（每列 = 一个已标注交付）。 */
  labeledDeliveries: number
  /** accept / labeledDeliveries；零标签时 null（不得回 0 假值——零样本的比例未定义）。 */
  acceptRate: number | null
  /** 有数值分数的样本数（score IS NOT NULL）。 */
  scoreSamples: number
  /** 有分数样本的平均；零样本时 null（不得回 0 假值）。 */
  meanScore: number | null
} {
  const empty = {
    criticVerdicts: 0,
    rejects: 0,
    expertLessons: 0,
    deliveries: 0,
    reaskRate: 0,
    labeledDeliveries: 0,
    acceptRate: null as number | null,
    scoreSamples: 0,
    meanScore: null as number | null,
  }
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
    // 人工接受/拒绝：一列一交付，比例只在有样本时定义。
    const hl = (db.query("SELECT COUNT(*) AS n FROM human_labels").get() as { n: number } | null)?.n ?? 0
    const acc = (db.query("SELECT COUNT(*) AS n FROM human_labels WHERE label = 'accept'").get() as { n: number } | null)?.n ?? 0
    // score 样本：COUNT(score)/AVG(score) 天然忽略 NULL。零样本 → AVG 为 NULL，不得回 0。
    const sc = db.query("SELECT COUNT(score) AS n, AVG(score) AS avg FROM critic_verdicts").get() as
      | { n: number; avg: number | null }
      | null
    const scoreSamples = sc?.n ?? 0
    const meanScore = scoreSamples > 0 && typeof sc?.avg === "number" ? sc.avg : null
    return {
      criticVerdicts: cv,
      rejects: rj,
      expertLessons: el,
      deliveries: dl,
      reaskRate: dl > 0 ? dup / dl : 0,
      labeledDeliveries: hl,
      acceptRate: hl > 0 ? acc / hl : null,
      scoreSamples,
      meanScore,
    }
  } catch (e) {
    degrade(e, "qualitySignalStats")
    return empty
  }
}

// ---- REQ-D2b（2026-09-23）：steer 命令身份（tombstone）存取 ----
// 纯语义（状态机／payload 冻结／受理判定）在 steer-identity.ts；本节只做 SQLite 存取，
// 实作 SteerLedgerStore 缝（见 steer-identity.createSteerLedger）。
// **刻意不提供删除函数**：终态 row 就是 tombstone，删掉它＝重启后同一条指引又能被投递
// （见 initPersistence 的建表注释）。clear/删会话（deleteSessionRow）与 sweepStaleRows
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
    aliases = [] // 坏损的别名栏不影响主键身份（宁可少认别名，不可拒真身）
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
 * 读一条命令：先按主键，再按别名 id（同文去重时第二个 id 是同一个逻辑 steer，
 * 它的重放同样必须命中 tombstone）。
 *
 * D-7b（2026-09-23）修掉的假命中：别名查询原本是 `alias_ids LIKE '%"<id>"%'`，而 steer id
 * 的字元集（steer-core.STEER_ID_PATTERN）**含底线 `_`**——`_` 是 LIKE 的单字元通配符，
 * 于是查 `steer-p_q` 会命中别人的别名 `steer-pXq`：一颗与本请求无关的假 409（不会重复
 * 投递，但把「不存在」说成了「已存在」）。改成 JSON 阵列的元素级**精确等值**比对
 * （json_each）：不靠转义、也不靠「id 不含引号」这类外部假设，任何 id 都不会误命中他人。
 */
export function loadSteerCommand(steerId: string): SteerCommand | null {
  if (!db || !steerId) return null
  try {
    const row = db.query(`SELECT ${STEER_ROW_COLS} FROM steer_commands WHERE steer_id = ?`).get(steerId) as SteerCommandRow | null
    if (row) return parseSteerRow(row)
    const byAlias = db
      .query(
        // CASE 保序：json_valid 为假时不求值 json_each——坏损的别名栏只让「自己」不被认作别名
        // （与 parseSteerRow 同一个政策：宁可少认别名，不可让一行坏资料炸掉整次查询）。
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

/** 读一个会话的命令全表（重启恢复扫描用；按建立时间升序＝投递顺序）。 */
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
 * 写入/更新一条命令（steer_id 主键 UPSERT）。fail-open 同全局策略。
 * 注意：写入即「身份已冻结」，即使后续流程失败也不回滚——宁可留下未终结的记录
 * （重启恢复会把它落 uncertain），不可留下「查不到＝可重放」的漏洞。
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

/** persistence.ts 对 steer-identity 的 SteerLedgerStore 缝实作（生产侧唯一接线）。 */
export const steerCommandStore: SteerLedgerStore = {
  read: loadSteerCommand,
  readBySession: loadSteerCommandsForSession,
  write: saveSteerCommand,
}

/**
 * 清掉长期无活动的 DB rows（gateway 不在内存、updated_at 超过 maxIdleMs）。
 * 回传被删的 { sessionId, opencodeSessionId }，呼叫端负责 best-effort 清理
 * upstream opencode session 与 uploads 目录。
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
