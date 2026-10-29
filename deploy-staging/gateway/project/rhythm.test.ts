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

describe("R-20 研究先行", () => {
  test("研究没写满 → 付费节点被拒；写满 3 个出处后放行；代理删不掉研究节点", async () => {
    const { researchGate, researchIssues, RESEARCH_NODE } = await import("./research.ts")
    const { store } = await ensureProject(sid("research"))
    const out = await store.applyPatches({ ops: [{ op: "apply_recipe", recipe: "feature_film", params: {} }] }, { kind: "user" })
    expect(out.receipt.rejected).toEqual([])
    let g = await store.read()
    expect(g.nodes[RESEARCH_NODE]?.type).toBe("script")
    expect((g.nodes.script?.inputs as any)?.research?.from).toBe(RESEARCH_NODE)
    expect(researchGate(g)).toContain("研究先行")

    const del = await store.applyPatches({ ops: [{ op: "remove_node", node: RESEARCH_NODE }] }, { kind: "agent" })
    expect(del.receipt.rejected.map((r) => r.code)).toContain("ACTOR_FORBIDDEN")

    const thin = "参考了获奖作品 https://a.example/1"
    expect(researchIssues(thin).length).toBe(2)
    const full = [
      "同类头部 MV 普遍用一镜到底串起三段情绪：主歌压暗、预副歌提速、副歌硬切到全景，观众在 8 秒内看到核心意象。",
      "https://a.example/one-take https://b.example/anamorphic https://c.example/chorus-cut",
      "可借鉴：副歌第一拍做结构硬切；夜景用变形宽银幕的椭圆光斑统一质感；人物身份全片锁一套造型，避免跳脸。",
      "验收：每段情绪转折对齐小节线，副歌镜头时长不超过两小节，关键帧风格统一分数不低于 70。主歌每镜四到六秒，桥段放慢到八秒以上留呼吸；结尾回到开场意象形成闭环，片尾不加字卡。色彩上青琥珀对冲，湿面反光承担节奏点的高光闪烁，人物在副歌才第一次正面看镜头。",
    ].join("\n")
    expect(researchIssues(full)).toEqual([])
    await store.applyPatches({ ops: [{ op: "write_result", node: RESEARCH_NODE, value: full }] }, { kind: "agent" })
    g = await store.read()
    expect(researchGate(g)).toBeNull()

    // 非多步配方不加研究节点（保住几个字出图）
    const { store: single } = await ensureProject(sid("single"))
    await single.applyPatches({ ops: [{ op: "apply_recipe", recipe: "single_image", params: {} }] }, { kind: "user" })
    expect((await single.read()).nodes[RESEARCH_NODE]).toBeUndefined()
  })
})
