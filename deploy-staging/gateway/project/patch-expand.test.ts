// S21：forEach 扇出接进补丁路径（设计文档 §3.3 文法、§3.1 字段归属、§3.4 事件）。
// 期望值独立于实现：实例 id = `<模板>#<row.id>`；row 删除 → 无人类产物的实例删除，pinned/人手产物 → orphaned 保留；
// 模板本体只携带 ${row.*} 原文、不执行；实例是真节点，planRun 以 target=模板 时只选实例（§3.2 第 5 条）。
// 夹具：真 ProjectStore + 临时 WORKSPACE_DIR（与 routes.test.ts 同一手法），不另造 harness。
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NODE_SPECS_LITE } from "./specs.ts"
import { planRun } from "./signature.ts"
import { ensureProject } from "./store.ts"
import type { Actor, Output } from "./types.ts"
import type { ProjectStore } from "./store.ts"

const ROOT = mkdtempSync(join(tmpdir(), "pg-s21-patch-expand-"))
process.env.WORKSPACE_DIR = ROOT

const AGENT: Actor = { kind: "agent" }
const USER: Actor = { kind: "user" }

let seq = 0
beforeEach(() => {
  seq += 1
  process.env.WORKSPACE_DIR = mkdtempSync(join(ROOT, `w-${seq}-`))
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

async function fresh(): Promise<ProjectStore> {
  seq += 1
  return (await ensureProject(`s21_${String(seq).padStart(3, "0")}`)).store
}

const SHOTS = (rows: Array<{ id: string; action: string }>) => ({
  id: "shots",
  type: "shotlist" as const,
  params: { kind: "shots", rows },
})

async function add(store: ProjectStore, node: Record<string, unknown>) {
  const r = await store.applyPatches({ ops: [{ op: "add_node", node }] as never }, AGENT)
  expect(r.receipt.ok).toBe(true)
  return r
}

async function setRows(store: ProjectStore, rows: Array<{ id: string; action: string }>) {
  return store.applyPatches({ ops: [{ op: "set", node: "shots", path: "params.rows", value: rows }] as never }, AGENT)
}

/** 带两条 row 的镜头表 + keyframe 模板（prompt 里的 row 引用在实例上解析，模板保留原文）。 */
async function fanoutFixture(store: ProjectStore, rows: Array<{ id: string; action: string }> = [{ id: "r1", action: "雨夜奔跑" }, { id: "r2", action: "回头" }]) {
  await add(store, SHOTS(rows))
  return add(store, { id: "kf", type: "keyframe", params: { prompt: "镜头：${row.action}" }, forEach: { over: "shots", as: "shot" } })
}

const instanceIds = (ids: string[]): string[] => ids.filter((id) => id.includes("#")).sort()
const patchEventOf = (events: ReadonlyArray<{ kind: string; data: Record<string, unknown> }>) => events.find((e) => e.kind === "patch")!

describe("补丁路径触发 forEach 扇出", () => {
  test("扇出落图：实例 id/derivedFrom/order 正确，模板参数不被改写，patch 事件带实例 id", async () => {
    const store = await fresh()
    const r = await fanoutFixture(store)
    const g = r.graph

    expect(instanceIds(Object.keys(g.nodes))).toEqual(["kf#r1", "kf#r2"])
    expect(g.nodes["kf#r1"].derivedFrom).toEqual({ template: "kf", rowId: "r1" })
    expect(g.nodes["kf#r2"].derivedFrom).toEqual({ template: "kf", rowId: "r2" })
    expect(g.nodes["kf#r1"].params.prompt).toBe("镜头：雨夜奔跑")
    expect(g.nodes["kf#r2"].params.prompt).toBe("镜头：回头")
    expect(g.nodes["kf#r1"].status).toBe("pending") // 实例是待跑真节点
    expect(g.nodes["kf#r1"].outputs).toEqual([])

    // 模板本体：只携带 ${row.*} 原文，forEach 声明保留（§3.3：模板自身不执行）
    expect(g.nodes.kf.params.prompt).toBe("镜头：${row.action}")
    expect(g.nodes.kf.forEach).toEqual({ over: "shots", as: "shot" })

    // 顺序：模板后紧跟按 row 序的实例
    expect(g.order).toEqual(["shots", "kf", "kf#r1", "kf#r2"])

    // 事件：实例属派生节点，不进 changed，但 patch 事件的 nodes 要包含它们（画布据此建卡）
    expect(r.receipt.changed).toEqual([{ node: "kf", fields: ["add"] }])
    expect(patchEventOf(r.events).data.nodes).toEqual(["kf", "kf#r1", "kf#r2"])
    expect(r.receipt.warnings).toEqual(["fanout:+2 -0 orphan:0"])
  })

  test("幂等：再打一条与 forEach 无关的补丁 → 实例 id 集合与实例节点本体都不变", async () => {
    const store = await fresh()
    await fanoutFixture(store)
    const before = await store.read()
    const beforeIds = instanceIds(Object.keys(before.nodes))
    expect(beforeIds).toEqual(["kf#r1", "kf#r2"])

    const r = await store.applyPatches({ ops: [{ op: "set", node: "shots", path: "params.kind", value: "shots_v2" }] as never }, AGENT)
    expect(r.receipt.ok).toBe(true)
    const after = await store.read()

    expect(instanceIds(Object.keys(after.nodes))).toEqual(beforeIds) // 无新增、无重复
    expect(after.order.filter((id) => id.includes("#"))).toEqual(["kf#r1", "kf#r2"]) // 每 id 只出现一次
    // 定义没变 → 实例不被重建/升 rev（逐字节相同）
    expect(JSON.stringify(after.nodes["kf#r1"])).toBe(JSON.stringify(before.nodes["kf#r1"]))
    expect(JSON.stringify(after.nodes["kf#r2"])).toBe(JSON.stringify(before.nodes["kf#r2"]))
    expect(patchEventOf(r.events).data.nodes).toEqual(["shots"]) // 没有实例混进本批事件
    expect(r.receipt.warnings).toEqual([]) // 没有扇出变化就不刷摘要
  })

  test("删行：无产物的实例随 row 消失；人手产物+pinned 的实例保留为 orphaned", async () => {
    // 反例（证明会咬人）：kf#r2 有用户产物并 pin，删 row 后必须保留。
    const keptStore = await fresh()
    await fanoutFixture(keptStore)
    const art: Output = await keptStore.artifacts.putBytes("用户手选的定格", { port: "out", origin: "user" })
    const replaced = await keptStore.applyPatches({ ops: [{ op: "replace_output", node: "kf#r2", artifactId: art.artifactId }] as never }, USER)
    expect(replaced.receipt.ok).toBe(true)
    expect(replaced.graph.nodes["kf#r2"].pinned).not.toBeNull()

    const r = await setRows(keptStore, [{ id: "r1", action: "雨夜奔跑" }])
    expect(r.receipt.ok).toBe(true)
    const kept = r.graph.nodes["kf#r2"]
    expect(kept).toBeDefined()
    expect(kept.status).toBe("orphaned")
    expect(kept.pinned).not.toBeNull() // 产物没被删
    expect(kept.outputs.map((o) => o.artifactId)).toEqual([art.artifactId])
    expect(r.graph.order).toContain("kf#r2")
    expect(r.receipt.warnings).toEqual(["fanout:+0 -0 orphan:1"])
    // 状态转换要有事件（画布据此换卡面），但实例不进 patch 事件的 nodes
    expect(r.events.some((e) => e.kind === "node_status" && e.node === "kf#r2" && e.data.to === "orphaned")).toBe(true)
    expect(patchEventOf(r.events).data.nodes).toEqual(["shots"])

    // planRun：orphaned 实例不进任何计划桶（target=模板 与 默认全图 targets 两条路径都验）。
    // 反例：若 planRun 没排除 orphaned，kf#r2 会以 pinned/toRun 出现在下面四个桶之一。
    const plans = [
      await planRun(r.graph, ["kf"], "incremental", keptStore.artifacts, NODE_SPECS_LITE),
      await planRun(r.graph, undefined, "incremental", keptStore.artifacts, NODE_SPECS_LITE),
    ]
    for (const plan of plans) {
      expect(plan.toRun).not.toContain("kf#r2")
      expect(plan.reuse).not.toContain("kf#r2")
      expect(plan.pinned).not.toContain("kf#r2")
      expect(plan.blocked).not.toContain("kf#r2")
      expect(plan.unknown).not.toContain("kf#r2")
      // 防过度排除：存活的 kf#r1 必须仍在计划内
      expect([...plan.toRun, ...plan.reuse, ...plan.pinned, ...plan.blocked, ...plan.unknown]).toContain("kf#r1")
    }

    // 正向：没有人类产物时，删 row 后实例直接消失。
    const cutStore = await fresh()
    await fanoutFixture(cutStore)
    const removed = await setRows(cutStore, [{ id: "r1", action: "雨夜奔跑" }])
    expect(removed.receipt.ok).toBe(true)
    expect(removed.graph.nodes["kf#r2"]).toBeUndefined()
    expect(removed.graph.order).not.toContain("kf#r2")
    expect(instanceIds(Object.keys(removed.graph.nodes))).toEqual(["kf#r1"])
    expect(removed.receipt.warnings).toEqual(["fanout:+0 -1 orphan:0"])
    // removed 不造事件（画布按既有约定保留旧卡），也不进 patch 事件 nodes
    expect(removed.events.some((e) => e.node === "kf#r2")).toBe(false)
    expect(patchEventOf(removed.events).data.nodes).toEqual(["shots"])
  })

  test("非法扇出整批拒绝：over 不是 shotlist / rows 不是数组 → ok=false、BAD_REF|BAD_VALUE、version 不变", async () => {
    const store = await fresh()
    await add(store, { id: "base", type: "keyframe", params: { prompt: "占位" } })
    await add(store, { id: "kf0", type: "keyframe", params: { prompt: "占位2" } })
    await add(store, SHOTS([{ id: "r1", action: "A" }]))
    // 坏输入 A：over 指向 keyframe（模拟旧导出/外部写入的图；op 级 checkForEach 拦得住新写入，拦不住已落盘的图）。
    await store.update((g) => { (g.nodes.kf0 as { forEach?: unknown }).forEach = { over: "base", as: "shot" } })
    const before = await store.read()
    const version = before.version

    const r = await store.applyPatches({ ops: [{ op: "set", node: "shots", path: "params.kind", value: "shots_v2" }] as never }, AGENT)
    expect(r.receipt.ok).toBe(false)
    expect(r.committed).toBe(false)
    expect(["BAD_REF", "BAD_VALUE"]).toContain(r.receipt.rejected[0]?.code)
    expect(r.receipt.rejected[0]?.msg).toMatch(/shotlist/)
    expect(r.graph.version).toBe(version)
    expect(instanceIds(Object.keys(r.graph.nodes))).toEqual([])
    expect(r.graph.nodes.shots.params.kind).toBe("shots") // 图没动
    expect(await store.version()).toBe(version)

    // 坏输入 B：rows 在 op 层合法（任意 JSON 都收），但展开器拒绝 → 同一整批拒绝路径。
    const rowsStore = await fresh()
    await fanoutFixture(rowsStore)
    const v2 = (await rowsStore.read()).version
    const bad = await rowsStore.applyPatches({ ops: [{ op: "set", node: "shots", path: "params.rows", value: [{ id: "BAD ID", action: "x" }] }] as never }, AGENT)
    expect(bad.receipt.ok).toBe(false)
    expect(["BAD_REF", "BAD_VALUE"]).toContain(bad.receipt.rejected[0]?.code)
    expect(bad.graph.version).toBe(v2)
    expect(instanceIds(Object.keys(bad.graph.nodes))).toEqual(["kf#r1", "kf#r2"]) // 旧实例原样
    expect(await rowsStore.version()).toBe(v2)
  })

  test("planRun：target=模板 只展开为实例，模板本体不进任何状态桶", async () => {
    const store = await fresh()
    await fanoutFixture(store)
    const g = await store.read()
    const plan = await planRun(g, ["kf"], "incremental", store.artifacts, NODE_SPECS_LITE)

    expect(plan.toRun).toEqual(["kf#r1", "kf#r2"])
    expect(plan.reuse).toEqual([])
    expect(plan.pinned).toEqual([])
    expect(plan.blocked).toEqual([])
    expect(plan.unknown).toEqual([])
    const planned = [...plan.toRun, ...plan.reuse, ...plan.pinned, ...plan.blocked, ...plan.unknown]
    expect(planned).not.toContain("kf") // 模板自身不执行（§3.3）
    expect(planned).not.toContain("shots") // target 闭包只含实例（kf 没有上游边）
  })
})
