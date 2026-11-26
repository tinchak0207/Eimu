import { Database } from "bun:sqlite"
import { redactForLog } from "./analytics-meta.ts"
import type { Migration, MigrationReport } from "./persistence-types.ts"
// 注意：DB 路径在模组载入时固定。bun test 会并行跑多个测试档且共用本模组单例；
// 若在 initPersistence() 重新读 env，各档会互相把 db 连线指向不同档案（隔离竞态，
// 实测会打断 steer-ledger-db 的持久层断言）。故维持单一路径、全进程共享。
const DB_PATH = process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db"

/** 目前使用的 DB 档路径（诊断／测试读回用；唯读）。 */
export function currentDbPath(): string {
  return DB_PATH
}

export let db: Database | null = null

// 2026-10-13「会话丢失」事故：旧实作用 warned 旗标只在**首次**失败时记一条日志，
// 之后整个进程静音 —— 生产上连续 11 小时写失败却只有一行日志，没人发现。
// 静默退化本身是事故的一部分，改为节流上报（首条立刻，其后每 30s 至多一条）。
let lastPersistError: { where: string; message: string; at: number } | null = null
let lastDegradeLogAt = 0

export function degrade(e: unknown, where: string): void {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  lastPersistError = { where, message, at: Date.now() }
  const now = Date.now()
  if (now - lastDegradeLogAt > 30_000) {
    lastDegradeLogAt = now
    console.error(redactForLog(`[gateway] persistence degraded (${where}): ${message}`))
  }
}

/** 保存失败/成功都必须经过这里记帐：失败 → 记下并节流上报；成功 → 若刚从失败中恢复就报一条恢复日志。 */
export function noteSaveFailure(e: unknown, where: string): void {
  degrade(e, where)
}

export function noteSaveSuccess(): void {
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

export const textDecoder = new TextDecoder()
export const textEncoder = new TextEncoder()

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
