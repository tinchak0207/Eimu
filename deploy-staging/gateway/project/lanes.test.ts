// S16 判准测试（设计文档 §3.8）：lane 约束、工程席位映射、回父摘要预算、工程模式不唤醒、
// critic 经 qc 节点写 verdict、critic 派发入口。
// 期望值来源（独立于被测实现）：
//  - 席位名：§3.10 第 10 点「工程版 <expert>_p 静态条目」；
//  - 不唤醒：§3.8「finishRun 不再 wakeParent（工程模式），完成事件进 events.jsonl」；
//  - lane：§3.1 Actor 表 + S2 patch.ts 的 LANE_VIOLATION（本档用真 applyPatch，不 mock 补丁引擎）；
//  - 摘要预算：§3.8「summary ≤2000 token≈4096 字节 + nodeIds ≤20」。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 沙箱：DB / 落盘 / 工程目录全指临时目录（与 subagent.test.ts、store.test.ts 同一套 env）。
const SANDBOX = mkdtempSync(join(tmpdir(), "s16-lanes-"))
process.env.SESSIONS_DB_PATH = join(SANDBOX, "sessions.db")
process.env.SUBAGENT_OUTPUT_DIR = join(SANDBOX, "outputs-subagent")
process.env.SUBAGENT_TRANSCRIPT_DIR = join(SANDBOX, "transcripts")
process.env.WORKSPACE_DIR = join(SANDBOX, "workspace")
process.env.LEDGER_PATH = join(SANDBOX, "ledger.jsonl")
mkdirSync(process.env.SUBAGENT_OUTPUT_DIR, { recursive: true })

const {
  LANE_MAX,
  SUBAGENT_SUMMARY_MAX_BYTES,
  compactSubagentSummary,
  dispatchCriticRun,
  emitSubagentProjectEvent,
  isExpertSeat,
  laneAllows,
  normalizeLane,
  projectSeatOf,
} = await import("./lanes.ts")
const { applyPatch } = await import("./patch.ts")
const { ensureProject, openProject } = await import("./store.ts")
const { initSubagent } = await import("../subagent-runs.ts")
const { handleSubagentDispatch } = await import("../subagent.ts")
const { finishRun } = await import("../subagent-finish.ts")
const { byParent } = await import("../subagent-runs.ts")
type Actor = import("./types.ts").Actor
type NodeType = import("./types.ts").NodeType
type Output = import("./types.ts").Output
type PatchOp = import("./types.ts").PatchOp
type ProjectGraph = import("./types.ts").ProjectGraph
type ProjectNode = import("./types.ts").ProjectNode

// ───────────────────────────── 0) 纯函数 ─────────────────────────────

describe("normalizeLane / laneAllows（§3.8 lane 语义）", () => {
  test("去重、保序、上限 20、非法 id 丢弃，空=只读", () => {
    expect(normalizeLane(undefined)).toEqual([])
    expect(normalizeLane([])).toEqual([])
    expect(normalizeLane("qc_a")).toEqual(["qc_a"])
    expect(normalizeLane(["k1", "k1", " k2 ", "Bad Id", "k1#row1", 7, null])).toEqual(["k1", "k2", "k1#row1"])
    expect(normalizeLane(["K1", "1k", "k-1"])).toEqual([])
    const many = Array.from({ length: LANE_MAX + 5 }, (_, i) => `n${i}`)
    expect(normalizeLane(many)).toHaveLength(LANE_MAX)
    expect(normalizeLane(many)[0]).toBe("n0")
  })

  test("空 lane 拒所有写；lane 内 set/write_result 允许；add_node 只允许 lane 指定的新 id", () => {
    expect(laneAllows([], "k1", "set")).toBe(false)
    expect(laneAllows([], "k1", "write_result")).toBe(false)
    expect(laneAllows([], "k1", "add_node")).toBe(false)
    expect(laneAllows(["k1"], "k1", "set")).toBe(true)
    expect(laneAllows(["k1"], "k1", "write_result")).toBe(true)
    expect(laneAllows(["k1"], "k2", "set")).toBe(false)
    expect(laneAllows(["k1"], "k1", "add_node")).toBe(true)
    expect(laneAllows(["k1"], "k9", "add_node")).toBe(false)
    // 实例沿用 patch.ts checkLane 的 base 命中规则（lane 条目=base 时覆盖其全部实例）
    expect(laneAllows(["shot"], "shot#r1", "set")).toBe(true)
    expect(laneAllows(["shot#r1"], "shot#r2", "set")).toBe(false)
    // 读操作／未知 op 不归本函数放行
    expect(laneAllows(["k1"], "k1", "replace_output")).toBe(false)
    expect(laneAllows(["k1"], "k1", "get")).toBe(false)
  })

  test("projectSeatOf：工程模式 <expert>_p，旧会话/未知席位原样", () => {
    expect(isExpertSeat("critic")).toBe(true)
    expect(isExpertSeat("critic_p")).toBe(false)
    expect(projectSeatOf("critic")).toBe("critic_p")
    expect(projectSeatOf("music", true)).toBe("music_p")
    expect(projectSeatOf("critic_p", true)).toBe("critic_p") // 幂等：已带后缀不重复加
    expect(projectSeatOf("critic", false)).toBe("critic")      // 旧会话逐字
    expect(projectSeatOf("unknown-seat", true)).toBe("unknown-seat")
    expect(projectSeatOf(undefined)).toBe("")
  })
})

describe("compactSubagentSummary（§3.8 回父预算）", () => {
  test("4097 字节输入 → 输出 ≤4096 字节、nodeIds ≤20、带截断标注", () => {
    const line = "成品描述".repeat(50) // 一行 600 字节
    const input = Array.from({ length: 20 }, (_, i) => `第${i}行 ${line}`).join("\n")
    expect(Buffer.byteLength(input, "utf-8")).toBeGreaterThan(SUBAGENT_SUMMARY_MAX_BYTES)
    const ids = Array.from({ length: 25 }, (_, i) => `n${i}`)
    const r = compactSubagentSummary(input, ids)
    expect(r.truncated).toBe(true)
    expect(r.bytes).toBeLessThanOrEqual(SUBAGENT_SUMMARY_MAX_BYTES)
    expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThanOrEqual(SUBAGENT_SUMMARY_MAX_BYTES)
    expect(r.nodeIds).toHaveLength(20)
    expect(r.text).toContain("已截断")
    // 按整行截断：保留部分以完整行结尾（截断标注之前）
    expect(r.text.split("[已截断")[0].endsWith("\n")).toBe(true)
  })

  test("单行超预算时按码点边界硬切（不产生半个汉字），≤4096", () => {
    const input = "汉".repeat(2000) // 6000 字节单行
    const r = compactSubagentSummary(input)
    expect(r.truncated).toBe(true)
    expect(r.bytes).toBeLessThanOrEqual(SUBAGENT_SUMMARY_MAX_BYTES)
    expect(r.text).not.toContain("\uFFFD")
  })

  test("预算内原文原样、正文不复制到 nodeIds", () => {
    const r = compactSubagentSummary("短摘要", ["a", "b"])
    expect(r.truncated).toBe(false)
    expect(r.text).toBe("短摘要")
    expect(r.nodeIds).toEqual(["a", "b"])
  })
})

// ───────────────────────────── 1) 派发：席位与 lane ─────────────────────────────

const realFetch = globalThis.fetch
const promptBodies: Array<Record<string, unknown>> = []
const emitted: Array<{ name: string; data: any }> = []
const wakes: Array<{ id: string; summary: string }> = []
const parents = new Map<string, any>()
let sessionSeq = 0
let parentSeq = 0

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
  const method = (init?.method ?? "GET").toUpperCase()
  if (method === "POST" && /\/session$/.test(url)) {
    sessionSeq += 1
    return json({ id: `ses_s16_${sessionSeq}` })
  }
  if (url.includes("/prompt_async")) {
    try {
      promptBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>)
    } catch {
      promptBodies.push({})
    }
    return json({})
  }
  if (method === "GET" && /\/message$/.test(url)) return json([])
  return json({})
}) as typeof fetch

beforeAll(() => {
  initSubagent({
    emitToSession: (_state: unknown, name: string, data: unknown) => {
      emitted.push({ name, data })
    },
    resolveSession: (id: string) => parents.get(id),
    findSessionByOpenCodeId: (oc: string) => [...parents.values()].find((p) => p.opencodeSessionId === oc),
    openCodeUrl: "http://gw.test",
    openCodeHeaders: () => ({}),
    describeError: (e: unknown) => String(e),
    subagentModelChain: () => [{ providerID: "p", modelID: "m" }],
    beastMode: (state: any) => state?.beastMode === true,
    wakeParent: (_state: unknown, run: { id: string; summary: string }) => {
      wakes.push({ id: run.id, summary: run.summary })
    },
  })
})

afterAll(() => {
  globalThis.fetch = realFetch
  rmSync(SANDBOX, { recursive: true, force: true })
})

function makeParent(tag: string, extra: Record<string, unknown> = {}) {
  const sid = `${tag}-${Date.now().toString(36)}-${(parentSeq++).toString(36)}`
  const p = { sessionId: sid, opencodeSessionId: `ses_parent_${sid}`, turnGen: 1, ...extra }
  parents.set(sid, p)
  return p
}
function dispatch(p: { sessionId: string }, label: string, extra: Record<string, unknown> = {}) {
  return handleSubagentDispatch(
    new Request("http://gw.test/internal/subagent/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: p.sessionId, label, prompt: "【任务】评审以下成品并按 rubric 打分（预期 5 分钟）。", async: true, ...extra }),
    }),
  )
}
const runOf = (sessionId: string) => (byParent.get(sessionId) ?? [])[0]

describe("工程模式派发：席位 <expert>_p 与 lane 进子运行配置", () => {
  test("工程会话（beast OFF）点名 critic → 子会话 agent=critic_p，lane 规范化并截到 20", async () => {
    const p = makeParent("s16-proj", { projectMode: true, beastMode: false })
    const many = Array.from({ length: LANE_MAX + 5 }, (_, i) => `n${i}`)
    const res = await dispatch(p, "评审官", { expert: "critic", lane: ["qc1", "qc1", "bad id", ...many] })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(promptBodies.at(-1)?.agent).toBe("critic_p")
    const run = runOf(p.sessionId)
    expect(run.seat).toBe("critic_p")
    expect(run.projectMode).toBe(true)
    expect(run.lane).toHaveLength(LANE_MAX)
    expect(run.lane[0]).toBe("qc1") // 去重保序
  })

  test("旧会话 → 席位原名（逐字），run 上没有 lane/seat/projectMode 新栏", async () => {
    const p = makeParent("s16-legacy", { beastMode: true })
    const res = await dispatch(p, "评审官", { expert: "critic", lane: ["qc1"] })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(promptBodies.at(-1)?.agent).toBe("critic")
    const run = runOf(p.sessionId)
    expect(run.agent).toBe("critic")
    expect(run.lane).toBeUndefined()
    expect(run.seat).toBeUndefined()
    expect(run.projectMode).toBeUndefined()
  })
})

// ───────────────────────────── 2) finishRun：不唤醒 + 事件 + 摘要预算 ─────────────────────────────

describe("工程模式 finishRun", () => {
  test("不调 wakeParent（spy 0 次）；run_finished 事件落盘；回父摘要 ≤4096B、node_ids ≤20", async () => {
    const p = makeParent("s16-finish", { projectMode: true, beastMode: false })
    await ensureProject(p.sessionId)
    const ids = Array.from({ length: LANE_MAX }, (_, i) => `k${i}`)
    await dispatch(p, "写手", { expert: "screenwriter", lane: ids })
    const run = runOf(p.sessionId)
    const longText = Array.from({ length: 30 }, (_, i) => `第${i}段 ` + "成品正文".repeat(60)).join("\n")
    expect(Buffer.byteLength(longText, "utf-8")).toBeGreaterThan(SUBAGENT_SUMMARY_MAX_BYTES)

    const wakesBefore = wakes.length
    await finishRun(run, "ok", longText)
    expect(wakesBefore).toBe(0) // 本档所有工程模式 run 都未唤醒过父会话
    expect(wakes.length).toBe(0) // 工程模式不唤醒父会话
    expect(Buffer.byteLength(run.summary!, "utf-8")).toBeLessThanOrEqual(SUBAGENT_SUMMARY_MAX_BYTES)

    const store = await openProject(p.sessionId)
    const events = await store.log.read(0, 100)
    const finished = events.find((e) => e.kind === "run_finished")
    expect(finished).toBeDefined()
    expect(finished!.data.subagent).toBe("done")
    expect(finished!.run).toBe(run.id)
    const nodeIds = finished!.data.node_ids as string[]
    expect(nodeIds).toHaveLength(LANE_MAX)
    expect(Buffer.byteLength(String(finished!.data.summary), "utf-8")).toBeLessThanOrEqual(SUBAGENT_SUMMARY_MAX_BYTES)
  })

  test("工程不存在时 emitSubagentProjectEvent 静默 no-op（不抛、不建目录）", async () => {
    const ev = await emitSubagentProjectEvent("s16-no-such-project", { kind: "run_finished", runId: "r1" })
    expect(ev).toBeNull()
  })
})

// ───────────────────────────── 3) lane 越界：真 applyPatch ─────────────────────────────

class FakeArtifacts {
  readonly items = new Map<string, Output>()
  async get(id: string): Promise<Output | null> {
    return this.items.get(id) ?? null
  }
  async putBytes(bytes: Uint8Array | string, hint: { port: string; origin: Output["origin"]; mime?: string }): Promise<Output> {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf-8") : Buffer.from(bytes)
    const sha = createHash("sha256").update(buf).digest("hex")
    const o: Output = {
      port: hint.port,
      artifactId: "art_" + sha.slice(0, 16),
      sha256: sha,
      path: `/fake/${sha}`,
      mime: hint.mime ?? "application/octet-stream",
      bytes: buf.length,
      origin: hint.origin,
    }
    this.items.set(o.artifactId, o)
    return o
  }
}

const NOW = new Date("2026-10-28T00:00:00.000Z")
const artifacts = new FakeArtifacts()

function pnode(id: string, type: NodeType, over: Partial<ProjectNode> = {}): ProjectNode {
  return { id, type, intent: "", params: {}, inputs: {}, refs: [], pinned: null, status: "done", signature: null, lastRun: null, outputs: [], rev: 1, ...over }
}
function pgraph(nodes: ProjectNode[]): ProjectGraph {
  return {
    schema: 1,
    id: "sess_t",
    sessionId: "sess_t",
    version: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    brief: [],
    decisions: [],
    targets: null,
    defaults: {},
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    order: nodes.map((n) => n.id),
    budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
    activeRun: null,
    seq: 0,
  }
}
const sub = (lane: string[]): Actor => ({ kind: "subagent", runId: "run-s16", lane })
const apply = (g: ProjectGraph, ops: PatchOp[], actor: Actor) =>
  applyPatch(g, { ops }, actor, { now: () => NOW, artifacts })

describe("lane 越界写被拒（真补丁引擎）", () => {
  test("set 越界 → LANE_VIOLATION；lane 内 → 提交", async () => {
    const g = pgraph([pnode("k1", "keyframe", { params: { prompt: "a", seed: 1 } }), pnode("k2", "keyframe", { params: { prompt: "b", seed: 2 } })])
    const bad = await apply(g, [{ op: "set", node: "k2", path: "params.prompt", value: "越界" }], sub(["k1"]))
    expect(bad.receipt.ok).toBe(false)
    expect(bad.receipt.rejected[0]?.code).toBe("LANE_VIOLATION")
    const ok = await apply(g, [{ op: "set", node: "k1", path: "params.prompt", value: "lane 内" }], sub(["k1"]))
    expect(ok.receipt.ok).toBe(true)
    expect(ok.graph.nodes.k1.params.prompt).toBe("lane 内")
  })

  test("空 lane（只读）拒所有写（set/write_result）", async () => {
    const g = pgraph([pnode("s1", "script", { params: { text: "旧" } })])
    const r1 = await apply(g, [{ op: "set", node: "s1", path: "params.text", value: "x" }], sub([]))
    expect(r1.receipt.rejected[0]?.code).toBe("LANE_VIOLATION")
    const r2 = await apply(g, [{ op: "write_result", node: "s1", value: { text: "x" } }], sub([]))
    expect(r2.receipt.rejected[0]?.code).toBe("LANE_VIOLATION")
  })

  test("add_node 只能用 lane 指定的新 id", async () => {
    const g = pgraph([])
    const bad = await apply(g, [{ op: "add_node", node: { id: "k9", type: "keyframe", params: { prompt: "p" } } }], sub(["k1"]))
    expect(bad.receipt.rejected[0]?.code).toBe("LANE_VIOLATION")
    const ok = await apply(g, [{ op: "add_node", node: { id: "k1", type: "keyframe", params: { prompt: "p" } } }], sub(["k1"]))
    expect(ok.receipt.ok).toBe(true)
    expect(ok.graph.nodes.k1).toBeDefined()
  })
})

// ───────────────────────────── 4) critic：经 QC 节点写 verdict ─────────────────────────────

describe("critic 经 qc 节点写 verdict（§3.8）", () => {
  const verdict = { score: 0.86, pass: true, deficiencies: ["第 3 镜字幕压边"] }

  test("lane=[qcNode] 的子代理 write_result {score,pass,deficiencies[]} 成功落盘", async () => {
    const g = pgraph([pnode("qc1", "qc", { params: { mode: "critic", rubric: "film" }, status: "pending", outputs: [] })])
    const r = await apply(g, [{ op: "write_result", node: "qc1", value: verdict }], sub(["qc1"]))
    expect(r.receipt.ok).toBe(true)
    const node = r.graph.nodes.qc1
    expect(node.status).toBe("done")
    expect(node.outputs).toHaveLength(1)
    const out = artifacts.items.get(node.outputs[0].artifactId)!
    expect(out.mime).toBe("application/json")
  })

  test("lane 不含该 QC 节点 → LANE_VIOLATION，判决不落盘", async () => {
    const g = pgraph([pnode("qc1", "qc", { params: { mode: "critic" }, status: "pending", outputs: [] })])
    const r = await apply(g, [{ op: "write_result", node: "qc1", value: verdict }], sub(["other"]))
    expect(r.receipt.ok).toBe(false)
    expect(r.receipt.rejected[0]?.code).toBe("LANE_VIOLATION")
    expect(r.graph.nodes.qc1.outputs).toHaveLength(0)
    expect(r.graph.nodes.qc1.status).toBe("pending")
  })
})

describe("dispatchCriticRun 触发入口", () => {
  test("用 critic 专家 + lane=[qcNode] 走现有派发（fake），回报工程席位 critic_p", async () => {
    const calls: Array<Record<string, unknown>> = []
    const out = await dispatchCriticRun(
      { sessionId: "sess_p", qcNodeId: "qc_final", prompt: "评审成片，按 rubric 打分并写 write_result。", label: "终审" },
      async (req) => {
        calls.push(req as unknown as Record<string, unknown>)
        return { ok: true, subagent_id: "run-123" }
      },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].expert).toBe("critic")
    expect(calls[0].lane).toEqual(["qc_final"])
    expect(calls[0].sessionId).toBe("sess_p")
    expect(calls[0].label).toBe("终审")
    expect(out.ok).toBe(true)
    expect(out.seat).toBe("critic_p")
    expect(out.lane).toEqual(["qc_final"])
    expect(out.subagentId).toBe("run-123")
  })

  test("qcNodeId 非法 → bad_input 且不派发", async () => {
    let called = 0
    const out = await dispatchCriticRun(
      { sessionId: "sess_p", qcNodeId: "QC FINAL", prompt: "评审" },
      async () => {
        called += 1
        return { ok: true }
      },
    )
    expect(out.ok).toBe(false)
    expect(out.code).toBe("bad_input")
    expect(called).toBe(0)
  })
})
