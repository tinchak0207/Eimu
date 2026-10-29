// S19 判准测试（设计文档 §7、§10 S19）：
//   ① 旧 workflowSnapshot 里已有产物的节点 → pinned 的 reference 节点，产物 sha256 实算（手算比对）；
//   ② 产物取不回来（下载失败）→ stale、不钉、不入图；
//   ③ 导入零上游生成调用（fake 网络层计数=0）；
//   ④ 席位锁存三键持久化往返；缺键旧行读回 creator_legacy / projectMode=false；
//      EIMU_PROJECT_MODE=off 新会话回旧席位；allowlist 按会话已鉴权 userId 生效（命中/未命中两侧）。
//
// 沙箱：临时 WORKSPACE_DIR + 本地 fixture 文件，全程不起网络（URL 失败用例用注入的 fetchImpl）。
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionState } from "../types-gateway.ts"

const SANDBOX = mkdtempSync(join(tmpdir(), "s19-legacy-"))
const FIXTURES = join(SANDBOX, "fixtures")
mkdirSync(FIXTURES, { recursive: true })
process.env.WORKSPACE_DIR = join(SANDBOX, "workspace")
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.GATEWAY_DB_PATH = join(SANDBOX, "gw.db")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")
// 残余路径一律指向不可达埠：测试不对任何真上游发请求。
process.env.OPENCODE_URL = "http://127.0.0.1:1"

// ── 本地 fixture：字节内容与「URL/文件名」无关，sha256 由本档独立手算 ──
const IMG_BYTES = Buffer.from("legacy image fixture \u0000\u0001 bytestream #1 — 1234567890")
const MP4_BYTES = Buffer.from("legacy video fixture — not a real mp4; we only verify the hash of these bytes")
const IMG_PATH = join(FIXTURES, "shot-1.png")
const MP4_PATH = join(FIXTURES, "shot-1.mp4")
writeFileSync(IMG_PATH, IMG_BYTES)
writeFileSync(MP4_PATH, MP4_BYTES)
const MISSING_PATH = join(FIXTURES, "gone.png") // 故意不创建：导入必须标 stale
const shaOf = (b: Buffer): string => createHash("sha256").update(b).digest("hex")
const IMG_SHA = shaOf(IMG_BYTES)
const MP4_SHA = shaOf(MP4_BYTES)

// ── 网络层探针：生成类上游调用都走 fetch；本档要求导入期间计数恒为 0 ──
const realFetch = globalThis.fetch
const fetchCalls: string[] = []
globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  fetchCalls.push(typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input))
  return realFetch(input as never, init)
}) as typeof fetch

const { importLegacyWorkflow, legacyNodeIdOf, legacyArtifactSource, LEGACY_IMPORT_SOURCE } = await import("./legacy-import.ts")
const { ensureProject, projectDirFor } = await import("./store.ts")
const { ArtifactStore } = await import("./artifacts.ts")
const persistence = await import("../persistence.ts")
const sessionsCore = await import("../sessions-core.ts")
const { hashKey } = await import("../auth-gw.ts")

afterAll(() => {
  globalThis.fetch = realFetch
  rmSync(SANDBOX, { recursive: true, force: true })
})

// ───────────────────────────── 导入器 ─────────────────────────────
describe("旧工作流只读导入（legacy-import）", () => {
  const SID = "sess_legacy_import"
  /** 旧 PersistableWorkflow 形态（workflow-gw-submit.ts:117 workflowSnapshotOf）。 */
  const snapshot = {
    workflowId: "wf_legacy_1",
    templateId: "tpl_old",
    graph: {
      nodes: [
        { id: "tpl-x-shot-1", kind: "image", title: "镜头 1 关键帧", metadata: { role: "keyframe" } },
        { id: "tpl-x-video-1", kind: "video", title: "镜头 1 视频", metadata: { role: "clip" } },
        { id: "tpl-x-gone", kind: "image", title: "丢失的镜头", metadata: {} },
        { id: "tpl-x-prompt", kind: "text", title: "画面描述", metadata: { content: "雨夜站台，男主背影" } },
        { id: "tpl-x-config", kind: "config", title: "视频参数", metadata: { kind: "video" } },
      ],
      connections: [],
    },
    status: "building",
    nodeStatus: {
      "tpl-x-shot-1": "success",
      "tpl-x-video-1": "success",
      "tpl-x-gone": "success",
      "tpl-x-prompt": "success",
      "tpl-x-config": "success",
    },
    nodeContent: {
      "tpl-x-shot-1": IMG_PATH,
      "tpl-x-video-1": MP4_PATH,
      "tpl-x-gone": MISSING_PATH,
      // text/config 也有 nodeContent（提示词），但绝不能当产物下载
      "tpl-x-prompt": "雨夜站台，男主背影",
      "tpl-x-config": "",
    },
    nodeCost: {},
  }

  test("有产物 → pinned reference，sha256 实算（手算比对），缺文件 → stale 不钉，零上游调用", async () => {
    const { store } = await ensureProject(SID, { allowedPathRoots: [FIXTURES], parentGw: "gw-legacy-import" })
    const callsBefore = fetchCalls.length
    const report = await importLegacyWorkflow(snapshot, { store })

    // 上限：零上游调用（网络层探针）
    expect(fetchCalls.length).toBe(callsBefore)

    // 下限：有产物的两个节点入图并钉住；缺文件的标 stale；text/config 不进
    expect(report.imported.map((i) => i.legacyNodeId).sort()).toEqual(["tpl-x-shot-1", "tpl-x-video-1"])
    expect(report.stale.map((s) => s.legacyNodeId)).toEqual(["tpl-x-gone"])
    expect(report.failed).toEqual([])
    expect(report.skipped.map((s) => s.legacyNodeId).sort()).toEqual(["tpl-x-config", "tpl-x-prompt"])

    const g = await store.read()
    const img = g.nodes[legacyNodeIdOf("tpl-x-shot-1")]
    const vid = g.nodes[legacyNodeIdOf("tpl-x-video-1")]
    expect(img?.type).toBe("reference")
    expect(vid?.type).toBe("reference")
    expect(img?.status).toBe("done")
    expect(img?.params.source).toBe(LEGACY_IMPORT_SOURCE)
    expect(img?.params.artifactId).toBe("art_" + IMG_SHA.slice(0, 16))
    expect(vid?.params.artifactId).toBe("art_" + MP4_SHA.slice(0, 16))

    // sha256 是实际字节的哈希（不是旧快照里的任何字符串）：与手算值逐字相等，且落盘文件可复核
    expect(img?.outputs[0]?.sha256).toBe(IMG_SHA)
    expect(vid?.outputs[0]?.sha256).toBe(MP4_SHA)
    expect(img?.outputs[0]?.bytes).toBe(IMG_BYTES.length)
    expect(vid?.outputs[0]?.bytes).toBe(MP4_BYTES.length)
    expect(existsSync(img!.outputs[0]!.path)).toBe(true)
    expect(shaOf(readFileSync(img!.outputs[0]!.path))).toBe(IMG_SHA)

    // pinned 的语义：用户钉住、冻结全部输出口 sha；签名与钉住签名一致（不会一算就被判漂移）
    expect(img?.pinned?.by).toBe("user")
    expect(img?.pinned?.outputsSha).toEqual([IMG_SHA])
    expect(img?.signature).toBeTruthy()
    expect(img?.pinned?.signatureAtPin).toBe(img?.signature)

    // 下载失败的节点：不进图、不钉
    expect(g.nodes[legacyNodeIdOf("tpl-x-gone")]).toBeUndefined()
    // text/config 壳节点不进图
    expect(g.nodes[legacyNodeIdOf("tpl-x-prompt")]).toBeUndefined()
    expect(g.nodes[legacyNodeIdOf("tpl-x-config")]).toBeUndefined()
  })

  test("重复导入幂等：同一旧节点按固定 id 跳过，不重复入库/不重复钉", async () => {
    const { store } = await ensureProject(SID, { allowedPathRoots: [FIXTURES] })
    const g0 = await store.read()
    const report = await importLegacyWorkflow(snapshot, { store })
    expect(report.imported).toEqual([])
    expect(report.skipped.filter((s) => s.reason.includes("已导入")).map((s) => s.legacyNodeId).sort())
      .toEqual(["tpl-x-shot-1", "tpl-x-video-1"])
    const g1 = await store.read()
    expect(Object.keys(g1.nodes).sort()).toEqual(Object.keys(g0.nodes).sort())
    expect(g1.version).toBe(g0.version) // 没有新补丁提交
  })

  test("URL 产物下载失败 → stale 不钉；只尝试旧产物下载，不产生生成调用", async () => {
    const sid = "sess_legacy_url_fail"
    let artifactFetches = 0
    const artifacts = new ArtifactStore({
      projectDir: projectDirFor(sid),
      allowPrivateNetwork: true, // fixture 指向回环；生产不开
      fetchImpl: (async () => {
        artifactFetches++
        return new Response("gone", { status: 404 })
      }) as unknown as typeof fetch,
    })
    const { store } = await ensureProject(sid, { artifacts })
    const genBefore = fetchCalls.length
    const report = await importLegacyWorkflow(
      {
        workflowId: "wf_url_fail",
        graph: { nodes: [{ id: "v1", kind: "video", title: "缺产物" }] },
        nodeStatus: { v1: "success" },
        nodeContent: { v1: "http://127.0.0.1:1/tmp/missing.mp4" },
      },
      { store },
    )
    expect(report.stale.map((s) => s.legacyNodeId)).toEqual(["v1"])
    expect(report.imported).toEqual([])
    expect(artifactFetches).toBe(1) // 只碰旧产物本身一次
    expect(fetchCalls.length).toBe(genBefore) // 生成层 / 其它网络调用 = 0
    const g = await store.read()
    expect(g.nodes[legacyNodeIdOf("v1")]).toBeUndefined()
  })

  test("内容不是文件地址的节点不猜（skipped），不下载、不入图", () => {
    expect(legacyArtifactSource("雨夜站台，男主背影")).toBeNull()
    expect(legacyArtifactSource("")).toBeNull()
    expect(legacyArtifactSource("https://example.test/a.png")).toEqual({ kind: "url", url: "https://example.test/a.png" })
    expect(legacyArtifactSource(IMG_PATH)).toEqual({ kind: "path", path: IMG_PATH })
  })
})

// ───────────────────────── 持久化：三键往返 + 旧行回退 ─────────────────────────
function persistedState(id: string): Record<string, unknown> {
  return {
    sessionId: id,
    apiKey: "sk-FAKE-SEAT",
    opencodeSessionId: `oc-${id}`,
    eventCounter: 3,
    replayBuffer: [],
    lastActivityAt: 1,
    partTextEmitted: new Map(),
    announcedUrls: new Set<string>(),
    toolStatusSeen: new Set<string>(),
    toolInvokeSeen: new Set<string>(),
    stepCostLogged: new Set<string>(),
    messageRole: new Map(),
    suppressedParts: new Set<string>(),
    vettingInjected: false,
  }
}

describe("持久化：席位锁存键（projectMode/seat/beast）", () => {
  test("新键存进去读回来一致（serialize→DB→hydrateRow）", () => {
    const st = { ...persistedState("sess_seat_rt"), projectMode: true, seat: "creator", beast: true }
    expect(persistence.saveSession(st as never)).toBe(true)
    const row = persistence.loadSessionById("sess_seat_rt")!
    expect(row.data.seat).toBe("creator")
    expect(row.data.projectMode).toBe(true)
    expect(row.data.beast).toBe(true)
    const h = persistence.hydrateRow(row)
    expect(h.seat).toBe("creator")
    expect(h.projectMode).toBe(true)
    expect(h.beast).toBe(true)
  })

  test("缺键旧行读回 creator_legacy / projectMode=false / beast=false", () => {
    const st = persistedState("sess_seat_old")
    expect(persistence.saveSession(st as never)).toBe(true)
    const row = persistence.loadSessionById("sess_seat_old")!
    expect("seat" in (row.data as Record<string, unknown>)).toBe(false)
    expect("projectMode" in (row.data as Record<string, unknown>)).toBe(false)
    expect("beast" in (row.data as Record<string, unknown>)).toBe(false)
    const h = persistence.hydrateRow(row)
    expect(h.seat).toBe("creator_legacy")
    expect(h.projectMode).toBe(false)
    expect(h.beast).toBe(false)
  })
})

// ───────────────────────── 开关：EIMU_PROJECT_MODE / allowlist ─────────────────────────
function bareSession(apiKey: string, id: string): SessionState {
  return { sessionId: id, apiKey, opencodeSessionId: `oc-${id}` } as unknown as SessionState
}

describe("EIMU_PROJECT_MODE 开关与 allowlist（按已鉴权 userId）", () => {
  test("两个都未设置 = on；显式乱值仍 off；on/allowlist 大小写与空白容错", () => {
    expect(sessionsCore.projectModeSwitch({})).toBe("on")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "" })).toBe("on")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "   " })).toBe("on")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "garbage" })).toBe("off")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "garbage", PROJECT_MODE_DEFAULT: "on" })).toBe("off")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: " ON " })).toBe("on")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "allowlist" })).toBe("allowlist")
    expect(sessionsCore.projectModeSwitch({ PROJECT_MODE_DEFAULT: "garbage" })).toBe("off")
    const st = bareSession("sk-seat-default-on", "sess_seat_default_on")
    sessionsCore.latchSessionSeat(st, {})
    expect(st.seat).toBe("creator_legacy")
    expect(st.projectMode).toBe(true)
  })

  test("PROJECT_MODE_DEFAULT=off 且未设 EIMU → off", () => {
    expect(sessionsCore.projectModeSwitch({ PROJECT_MODE_DEFAULT: "off" })).toBe("off")
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "", PROJECT_MODE_DEFAULT: "off" })).toBe("off")
  })

  test("EIMU_PROJECT_MODE=off 压过 PROJECT_MODE_DEFAULT=on（回滚）", () => {
    expect(sessionsCore.projectModeSwitch({ EIMU_PROJECT_MODE: "off", PROJECT_MODE_DEFAULT: "on" })).toBe("off")
    const st = bareSession("sk-seat-rollback", "sess_seat_rollback")
    sessionsCore.latchSessionSeat(st, { EIMU_PROJECT_MODE: "off", PROJECT_MODE_DEFAULT: "on" })
    expect(st.seat).toBe("creator_legacy")
    expect(st.projectMode).toBe(false)
  })

  test("PROJECT_MODE_DEFAULT=allowlist 且未设 EIMU → allowlist", () => {
    expect(sessionsCore.projectModeSwitch({ PROJECT_MODE_DEFAULT: "allowlist" })).toBe("allowlist")
  })

  test("off：新会话锁存为 creator_legacy（回滚）", () => {
    process.env.EIMU_PROJECT_MODE = "off"
    delete process.env.EIMU_PROJECT_MODE_ALLOWLIST
    const st = bareSession("sk-seat-off", "sess_seat_off")
    sessionsCore.sessions.set(st.sessionId, st)
    expect(st.seat).toBe("creator_legacy")
    expect(st.projectMode).toBe(false)
    expect(st.beast).toBe(false)
    // 客户端预塞的 projectMode 不被信任：锁存以开关+已鉴权身份为准
    const forged = { ...bareSession("sk-seat-off-2", "sess_seat_forged"), projectMode: true } as SessionState
    sessionsCore.sessions.set(forged.sessionId, forged)
    expect(forged.projectMode).toBe(false)
    expect(forged.seat).toBe("creator_legacy")
    sessionsCore.sessions.delete(st.sessionId)
    sessionsCore.sessions.delete(forged.sessionId)
  })

  test("on：新会话锁存为旧席位 creator_legacy＋工程引擎（projectMode=true），leanSeat 为 false", () => {
    process.env.EIMU_PROJECT_MODE = "on"
    delete process.env.EIMU_PROJECT_MODE_ALLOWLIST
    const st = bareSession("sk-seat-on", "sess_seat_on")
    sessionsCore.sessions.set(st.sessionId, st)
    expect(st.seat).toBe("creator_legacy")
    expect(st.projectMode).toBe(true)
    expect(sessionsCore.leanSeat(st)).toBe(false)
    expect(sessionsCore.leanSeat({ seat: "creator" })).toBe(true)
    expect(sessionsCore.seatDecision({ mode: "on", userId: "u1" })).toMatchObject({ seat: "creator_legacy", projectMode: true })
    sessionsCore.sessions.delete(st.sessionId)
  })

  test("allowlist：命中 → 旧席位＋工程引擎，未命中 → 旧席位无引擎；id 由已鉴权 apiKey 派生", async () => {
    const allowedKey = "sk-allow-hit"
    const otherKey = "sk-allow-miss"
    const allowedUserId = sessionsCore.seatUserId(allowedKey)
    // 与网关对外回报的 user_id 同一派生（auth-gw.hashKey）
    expect(allowedUserId).toBe(await hashKey(allowedKey))

    process.env.EIMU_PROJECT_MODE = "allowlist"
    process.env.EIMU_PROJECT_MODE_ALLOWLIST = `  ${allowedUserId} , 000000000000000000000000 `

    const hit = bareSession(allowedKey, "sess_allow_hit")
    const miss = bareSession(otherKey, "sess_allow_miss")
    sessionsCore.sessions.set(hit.sessionId, hit)
    sessionsCore.sessions.set(miss.sessionId, miss)
    expect(hit.seat).toBe("creator_legacy")
    expect(hit.projectMode).toBe(true)
    expect(miss.seat).toBe("creator_legacy")
    expect(miss.projectMode).toBe(false)
    sessionsCore.sessions.delete(hit.sessionId)
    sessionsCore.sessions.delete(miss.sessionId)
  })

  test("已锁存的会话永不变：env 改成 off 也不踢回旧席位（DB 往返＝重启恢复路径）", () => {
    process.env.EIMU_PROJECT_MODE = "on"
    const st = {
      ...persistedState("sess_seat_latched"),
      apiKey: "sk-seat-latched",
      seat: "creator",
      projectMode: true,
      beast: false,
    } as unknown as SessionState
    sessionsCore.sessions.set(st.sessionId, st)
    expect(st.seat).toBe("creator")
    expect(persistence.saveSession(st as never)).toBe(true)

    process.env.EIMU_PROJECT_MODE = "off"
    const restored = persistence.hydrateRow(persistence.loadSessionById("sess_seat_latched")!) as unknown as SessionState
    sessionsCore.sessions.set(restored.sessionId, restored) // 重启后 lazy reload 的入册路径
    expect(restored.seat).toBe("creator")
    expect(restored.projectMode).toBe(true)
    sessionsCore.sessions.delete(st.sessionId)
  })
})
