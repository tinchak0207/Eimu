// 节奏三条（R-17 铺满、R-18 派专家、R-19 多回报）的强制点：
//   共享 store（同一目录一个实例，跨入口写入互相可见）、配方表缺省注入、lane 推断、产物卡投影。
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = mkdtempSync(join(tmpdir(), "pg-rhythm-"))
process.env.SESSIONS_DB_PATH = join(ROOT, "sessions.db")

const routes = await import("./routes.ts")
const { ensureProject, openProject } = await import("./store.ts")
const { inferLaneFromGraph, laneBriefLine } = await import("./lanes.ts")
const { reopenSessionsDbForTest } = await import("../job-store.ts")
reopenSessionsDbForTest()

let seq = 0
const sid = (tag: string) => `rh_${tag}_${++seq}`

beforeEach(() => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(ROOT, "w-"))
  routes.resetProjectStores()
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe("共享 store：同一工程目录进程内只有一个实例", () => {
  test("ingress 与工具路由拿到同一个实例；一边写，另一边立刻读得到", async () => {
    const id = sid("shared")
    const { store: a } = await ensureProject(id)
    const b = await openProject(id)
    expect(b).toBe(a)
    await a.applyPatches({ ops: [{ op: "add_node", node: { id: "k1", type: "keyframe", params: { prompt: "x" } } }] as never }, { kind: "agent" })
    expect(Object.keys((await b.read()).nodes)).toContain("k1")
    const again = await ensureProject(id)
    expect(again.store).toBe(a)
    expect(again.created).toBe(false)
  })
})

describe("R-17 配方表缺省注入", () => {
  test("首句命中配方 → 节点建齐，不回 UNKNOWN_RECIPE", async () => {
    const { store } = await ensureProject(sid("recipe"))
    const out = await store.applyPatches({ ops: [{ op: "apply_recipe", recipe: "single_image", params: {} }] }, { kind: "user" })
    expect(out.receipt.rejected.map((r) => r.code)).not.toContain("UNKNOWN_RECIPE")
    expect(Object.keys((await store.read()).nodes).length).toBeGreaterThan(0)
  })
})

describe("R-18 lane 推断", () => {
  const graph = {
    order: ["s1", "m_done", "m_open", "k1"],
    nodes: {
      s1: { id: "s1", type: "script", status: "pending", intent: "歌词" },
      m_done: { id: "m_done", type: "music", status: "done" },
      m_open: { id: "m_open", type: "music", status: "failed", intent: "主打单曲" },
      k1: { id: "k1", type: "keyframe", status: "pending" },
    },
  }
  test("派 music 不带 lane → lane＝图里的 music 节点；未完成的排前面", () => {
    expect(inferLaneFromGraph(graph, "music")).toEqual(["m_open", "m_done"])
    expect(inferLaneFromGraph(graph, "music_p")).toEqual(["m_open", "m_done"])
    expect(inferLaneFromGraph(graph, "lyricist")).toEqual(["s1"])
    expect(inferLaneFromGraph(graph, "researcher")).toEqual([])
  })
  test("任务书写明可写节点；空 lane 写明只读", () => {
    expect(laneBriefLine(["m_open"], graph)).toContain("m_open（music：主打单曲）")
    expect(laneBriefLine([], graph)).toContain("只读")
  })
})

describe("R-19 产物卡投影", () => {
  const out = (sha: string, mime: string, url = `https://cdn.test/${sha}`) => ({
    port: "out", artifactId: `art_${sha.slice(0, 16)}`, sha256: sha, path: `/tmp/${sha}`, mime, bytes: 1, origin: "generated", url,
  })
  const graph: any = {
    nodes: {
      k1: { id: "k1", type: "keyframe", status: "done", intent: "镜1", outputs: [out("a".repeat(64), "image/png")], lastRun: { costCoins: 2 } },
      c1: { id: "c1", type: "clip", status: "done", intent: "镜1 动", outputs: [out("b".repeat(64), "video/mp4")], lastRun: { costCoins: 50 } },
      m1: { id: "m1", type: "music", status: "done", intent: "主打", outputs: [out("c".repeat(64), "audio/mpeg")], lastRun: { costCoins: 10 } },
      s1: { id: "s1", type: "script", status: "done", outputs: [out("d".repeat(64), "text/plain")] },
      k2: { id: "k2", type: "keyframe", status: "running", outputs: [] },
      k3: { id: "k3", type: "keyframe", status: "done", outputs: [out("e".repeat(64), "image/png", "")] },
    },
  }
  test("新 node_output 有公网 url → 对应 image/video/audio.done 各推一次、不重复", () => {
    const sent: Array<[string, any]> = []
    const emit = (name: string, data: unknown) => { sent.push([name, data]) }
    const n = routes.emitProgressCards({ sessionId: "x" } as any, graph, ["k1", "c1", "m1", "s1", "k2", "k3"], emit)
    expect(n).toBe(3)
    expect(sent.map(([name]) => name)).toEqual(["image.done", "video.done", "audio.done"])
    expect(sent[1][1]).toMatchObject({ task_id: "c1", cost_coins: 50, media_kind: "video", title: "镜1 动" })
    expect(routes.emitProgressCards({ sessionId: "x" } as any, graph, ["k1", "c1", "m1"], emit)).toBe(0)
  })
})
