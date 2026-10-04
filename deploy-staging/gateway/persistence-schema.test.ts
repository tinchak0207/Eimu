// persistence-schema.test.ts — 需求 2（schema 版本化迁移）＋需求 3（新增栏位同步集合检查）的真值验收。
//
// 全部使用暂存档（mkdtemp），**绝不碰生产 sessions.db**（那在 VPS）。DB 路径在 persistence
// 模组载入时固定，故先造好「旧库」再动态 import persistence。
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const dir = mkdtempSync(join(tmpdir(), "schema-mig-"))
const dbPath = join(dir, "sessions.db")
process.env.SESSIONS_DB_PATH = dbPath

// ── 造「旧库」：只有旧栏位的 sessions 表 ＋ 一笔真实资料（user_version=0）──
const legacy = new Database(dbPath, { create: true })
legacy.exec(`
  CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    owner_key           TEXT NOT NULL,
    opencode_session_id TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    data                TEXT NOT NULL
  )
`)
const legacyData = {
  eventCounter: 7,
  replayBuffer: [],
  lastActivityAt: 1234567890,
  partTextEmitted: [],
  announcedUrls: [],
  toolStatusSeen: [],
  toolInvokeSeen: [],
  stepCostLogged: [],
  messageRole: [],
  suppressedParts: [],
  vettingInjected: true,
}
legacy
  .query("INSERT INTO sessions (id, owner_key, opencode_session_id, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)")
  .run("sess-legacy", "sk-FAKE-OWNER", "oc-legacy", 1, 2, JSON.stringify(legacyData))
legacy.exec("PRAGMA user_version = 0")
legacy.close()

const persistence = await import("./persistence.ts")

function minimalState(): Record<string, unknown> {
  return {
    sessionId: `sess-fields-${Date.now().toString(36)}`,
    apiKey: "sk-FAKE-OWNER",
    opencodeSessionId: `oc-fields-${Date.now().toString(36)}`,
    eventCounter: 1,
    replayBuffer: [{ id: 1, frame: new TextEncoder().encode("data: {}\n\n"), strippable: false }],
    lastActivityAt: Date.now(),
    partTextEmitted: new Map([["p1", { emittedLen: 2 }]]),
    announcedUrls: new Set(["https://example.test/a"]),
    toolStatusSeen: new Set(["t1"]),
    toolInvokeSeen: new Set(["t2"]),
    stepCostLogged: new Set(["s1"]),
    messageRole: new Map([["m1", "assistant"]]),
    suppressedParts: new Set(["x"]),
    canvasSummary: { brief: "draft" },
    canvasSummaryAt: 111,
    vettingInjected: true,
    lastTurnActiveAt: 999,
    sessionTitle: "测试标题",
    tplDeviateToken: { token: "tpl-fake", at: 222 },
  }
}

describe("schema 版本化迁移（需求 2）", () => {
  test("initPersistence 对旧库跑完迁移：(a) user_version==SCHEMA_VERSION、(b) 旧资料无损", () => {
    persistence.initPersistence()

    const probe = new Database(dbPath)
    const v = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(v).toBe(persistence.SCHEMA_VERSION)

    // 审计表记了清单里每一版（真副作用，非源码断言）
    const audits = probe.query("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]
    expect(audits.map((a) => a.version)).toEqual(persistence.MIGRATIONS.map((m) => m.version))

    // v2 产物（索引）确实存在
    const idx = probe.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_owner_updated'").get()
    expect(idx).not.toBeNull()
    // v1 baseline 产物（新表）存在
    const t = probe.query("SELECT name FROM sqlite_master WHERE type='table' AND name='critic_verdicts'").get()
    expect(t).not.toBeNull()
    probe.close()

    // (b) 旧资料读回、未遗失
    const row = persistence.loadSessionById("sess-legacy")
    expect(row).not.toBeNull()
    expect(row!.data.eventCounter).toBe(7)
    expect((row!.data as Record<string, unknown>).vettingInjected).toBe(true)
    expect(row!.apiKey).toBe("sk-FAKE-OWNER")
  })

  test("(c) 重复跑 runMigrations 不再变更（idempotent）", () => {
    const probe = new Database(dbPath)
    const before = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const report = persistence.runMigrations(probe)
    expect(report.from).toBe(persistence.SCHEMA_VERSION)
    expect(report.applied).toEqual([])
    expect(report.failures).toEqual([])
    expect(report.to).toBe(persistence.SCHEMA_VERSION)
    const after = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(after).toBe(before)
    // 审计表不因重跑长出新列
    const n = (probe.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n
    expect(n).toBe(persistence.MIGRATIONS.length)
    probe.close()
  })
})

describe("新增栏位同步集合检查（需求 3）", () => {
  test("serialize() 输出键集 == PERSISTED_DATA_KEYS", () => {
    const keys = Object.keys(persistence.serialize(minimalState() as never)).sort()
    expect(keys).toEqual([...persistence.PERSISTED_DATA_KEYS].sort())
  })

  test("每个落盘键在 hydrateRow() 输出都能找到（含别名 title→sessionTitle）", () => {
    const state = minimalState()
    persistence.saveSession(state as never)
    const row = persistence.loadSessionById(state.sessionId as string)!
    expect(row).not.toBeNull()
    const hydrated = persistence.hydrateRow(row)
    const ALIAS: Record<string, string> = { title: "sessionTitle" }
    const missing = persistence.PERSISTED_DATA_KEYS.filter((k) => !(k in hydrated) && !(ALIAS[k] in hydrated))
    expect(missing).toEqual([])
  })

  test("round-trip 真值：旗标/别名/形状不丢（曾踩的 replay strippable 与 lastTurnActiveAt）", () => {
    const state = minimalState()
    persistence.saveSession(state as never)
    const row = persistence.loadSessionById(state.sessionId as string)!
    const h = persistence.hydrateRow(row)
    expect(h.lastTurnActiveAt).toBe(999)
    expect(h.sessionTitle).toBe("测试标题")
    expect((h.tplDeviateToken as { token: string }).token).toBe("tpl-fake")
    const replay = h.replayBuffer as { id: number; strippable?: boolean; frame: Uint8Array }[]
    expect(replay.length).toBe(1)
    expect(replay[0].strippable).toBe(false)
    // 长度帧必须是 bytes（round-trip 后还能解出原文字）
    expect(new TextDecoder().decode(replay[0].frame)).toBe("data: {}\n\n")
  })
})

// ── v2 → v3 增量升级：真实的旧生产库（2026-10-03）──────────────────────────────
// 为何另造一个库：上面那个 fixture 是 user_version=0 的最旧库，一路 0→3；本节专门覆盖
// 「已上线的 v2 生产库（user_version=2）升到 v3」这条真实路径，v3 产物（human_labels 表、
// critic_verdicts.score_source 栏）在此才有专属断言。
//
// 造库方式＝真实：直接呼叫本模组既有的 migration 函式（MIGRATIONS[0]/[1].up）把 v1/v2 的
// schema 逐步建出来，再把 user_version 设成 2——不手抄一份可能与实作漂移的假 DDL。
// 注：DB_PATH 在模组载入时固定（persistence.ts:106），同进程无法对第二个路径再跑
// initPersistence()；此处改用 initPersistence 内部**唯一实际执行迁移的入口** runMigrations()，
// 与 initPersistence 走的是同一段迁移代码（initPersistence = open db + runMigrations）。
const v2Dir = mkdtempSync(join(tmpdir(), "schema-v2-"))
const v2Path = join(v2Dir, "sessions.db")
const v2Build = new Database(v2Path, { create: true })
const v2Migrations = persistence.MIGRATIONS.filter((m) => m.version <= 2)
for (const m of v2Migrations) m.up(v2Build)
// 真实 v2 库的审计表：runMigrations 套用 v1/v2 时会写入这两列（照抄同一段语句，让 fixture
// 与真库等价——否则升级后 schema_migrations 只有 v3，与生产库状态不符）
v2Build.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )
`)
for (const m of v2Migrations) {
  v2Build
    .query("INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
    .run(m.version, m.name, Date.now())
}
v2Build.exec("PRAGMA user_version = 2")
// 前置事实：v2 库的 critic_verdicts 尚无 score_source，也还没有 human_labels 表
const v2ColsBefore = (v2Build.query("PRAGMA table_info(critic_verdicts)").all() as { name: string }[]).map((c) => c.name)
if (v2ColsBefore.includes("score_source")) throw new Error("fixture 不真实：v2 库不该已有 score_source")
if (v2Build.query("SELECT name FROM sqlite_master WHERE type='table' AND name='human_labels'").get()) {
  throw new Error("fixture 不真实：v2 库不该已有 human_labels")
}
// 塞一笔真实的 v2 时代审核判决（升级后必须仍在、且 score_source 维持 null）
v2Build
  .query(
    "INSERT INTO critic_verdicts (id, session_id, run_id, agent, label, verdict, score, judge_model, verdict_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .run("cv-legacy", "sess-legacy", "run-legacy", "expert", "cut-1", "pass", 4.25, "judge-x", "旧库判词", 111)
v2Build.close()

const v2db = new Database(v2Path)
const v2Report = persistence.runMigrations(v2db)

describe("v2 → v3 增量升级（真实旧库）", () => {
  test("runMigrations 把 v2 升到 v3：只套用 v3、user_version==3", () => {
    expect(v2Report.from).toBe(2)
    expect(v2Report.to).toBe(3)
    expect(v2Report.applied).toEqual([3])
    expect(v2Report.failures).toEqual([])
    const v = (v2db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(v).toBe(persistence.SCHEMA_VERSION)
    expect(v).toBe(3)
  })

  test("v3 产物齐备：human_labels 表存在、critic_verdicts 有 score_source 栏", () => {
    const hl = v2db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='human_labels'").get()
    expect(hl).not.toBeNull()
    const cols = (v2db.query("PRAGMA table_info(critic_verdicts)").all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain("score_source")
  })

  test("旧资料无损：该笔 critic_verdicts 仍在、score 保留、score_source 为 null（未伪造成 measured）", () => {
    const row = v2db
      .query("SELECT score, score_source, verdict, judge_model FROM critic_verdicts WHERE id = 'cv-legacy'")
      .get() as { score: number; score_source: string | null; verdict: string; judge_model: string } | null
    expect(row).not.toBeNull()
    expect(row!.score).toBe(4.25)
    expect(row!.score_source).toBeNull()
    expect(row!.verdict).toBe("pass")
    expect(row!.judge_model).toBe("judge-x")
  })

  test("v3 对「栏已存在」的库幂等：可重跑、不重复 ALTER、审计表不长新列", () => {
    const report = persistence.runMigrations(v2db)
    expect(report.from).toBe(3)
    expect(report.applied).toEqual([])
    expect(report.failures).toEqual([])
    const n = (v2db.query("PRAGMA table_info(critic_verdicts)").all() as { name: string }[]).filter(
      (c) => c.name === "score_source",
    ).length
    expect(n).toBe(1)
    const audits = v2db.query("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]
    expect(audits.map((a) => a.version)).toEqual([1, 2, 3])
  })
})
