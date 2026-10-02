// persistence-schema.test.ts — 需求 2（schema 版本化遷移）＋需求 3（新增欄位同步集合檢查）的真值驗收。
//
// 全部使用暫存檔（mkdtemp），**絕不碰生產 sessions.db**（那在 VPS）。DB 路徑在 persistence
// 模組載入時固定，故先造好「舊庫」再動態 import persistence。
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const dir = mkdtempSync(join(tmpdir(), "schema-mig-"))
const dbPath = join(dir, "sessions.db")
process.env.SESSIONS_DB_PATH = dbPath

// ── 造「舊庫」：只有舊欄位的 sessions 表 ＋ 一筆真實資料（user_version=0）──
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
    sessionTitle: "測試標題",
    tplDeviateToken: { token: "tpl-fake", at: 222 },
  }
}

describe("schema 版本化遷移（需求 2）", () => {
  test("initPersistence 對舊庫跑完遷移：(a) user_version==SCHEMA_VERSION、(b) 舊資料無損", () => {
    persistence.initPersistence()

    const probe = new Database(dbPath)
    const v = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(v).toBe(persistence.SCHEMA_VERSION)

    // 審計表記了清單裡每一版（真副作用，非源碼斷言）
    const audits = probe.query("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]
    expect(audits.map((a) => a.version)).toEqual(persistence.MIGRATIONS.map((m) => m.version))

    // v2 產物（索引）確實存在
    const idx = probe.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_owner_updated'").get()
    expect(idx).not.toBeNull()
    // v1 baseline 產物（新表）存在
    const t = probe.query("SELECT name FROM sqlite_master WHERE type='table' AND name='critic_verdicts'").get()
    expect(t).not.toBeNull()
    probe.close()

    // (b) 舊資料讀回、未遺失
    const row = persistence.loadSessionById("sess-legacy")
    expect(row).not.toBeNull()
    expect(row!.data.eventCounter).toBe(7)
    expect((row!.data as Record<string, unknown>).vettingInjected).toBe(true)
    expect(row!.apiKey).toBe("sk-FAKE-OWNER")
  })

  test("(c) 重複跑 runMigrations 不再變更（idempotent）", () => {
    const probe = new Database(dbPath)
    const before = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const report = persistence.runMigrations(probe)
    expect(report.from).toBe(persistence.SCHEMA_VERSION)
    expect(report.applied).toEqual([])
    expect(report.failures).toEqual([])
    expect(report.to).toBe(persistence.SCHEMA_VERSION)
    const after = (probe.query("PRAGMA user_version").get() as { user_version: number }).user_version
    expect(after).toBe(before)
    // 審計表不因重跑長出新列
    const n = (probe.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n
    expect(n).toBe(persistence.MIGRATIONS.length)
    probe.close()
  })
})

describe("新增欄位同步集合檢查（需求 3）", () => {
  test("serialize() 輸出鍵集 == PERSISTED_DATA_KEYS", () => {
    const keys = Object.keys(persistence.serialize(minimalState() as never)).sort()
    expect(keys).toEqual([...persistence.PERSISTED_DATA_KEYS].sort())
  })

  test("每個落盤鍵在 hydrateRow() 輸出都能找到（含別名 title→sessionTitle）", () => {
    const state = minimalState()
    persistence.saveSession(state as never)
    const row = persistence.loadSessionById(state.sessionId as string)!
    expect(row).not.toBeNull()
    const hydrated = persistence.hydrateRow(row)
    const ALIAS: Record<string, string> = { title: "sessionTitle" }
    const missing = persistence.PERSISTED_DATA_KEYS.filter((k) => !(k in hydrated) && !(ALIAS[k] in hydrated))
    expect(missing).toEqual([])
  })

  test("round-trip 真值：旗標/別名/形狀不丟（曾踩的 replay strippable 與 lastTurnActiveAt）", () => {
    const state = minimalState()
    persistence.saveSession(state as never)
    const row = persistence.loadSessionById(state.sessionId as string)!
    const h = persistence.hydrateRow(row)
    expect(h.lastTurnActiveAt).toBe(999)
    expect(h.sessionTitle).toBe("測試標題")
    expect((h.tplDeviateToken as { token: string }).token).toBe("tpl-fake")
    const replay = h.replayBuffer as { id: number; strippable?: boolean; frame: Uint8Array }[]
    expect(replay.length).toBe(1)
    expect(replay[0].strippable).toBe(false)
    // 長度幀必須是 bytes（round-trip 後還能解出原文字）
    expect(new TextDecoder().decode(replay[0].frame)).toBe("data: {}\n\n")
  })
})
