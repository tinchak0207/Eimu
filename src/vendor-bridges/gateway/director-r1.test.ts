/**
 * director-r1.test.ts — 2026-09-03 驗屍修復 R1 契約測試（node:test，tsx 運行）。
 * 覆蓋六項：#1 state summary 分級剝 joints、#2 動作 from 接續前鏡末求解位、
 * #3 工具觸發 auto-seed 改 bare plan、#4 K 幀升冪重排 + 同幀去重（真實會話彈跳樣本）、
 * #5 project_frame 越界 hint 帶範圍、#6 plan.summary 結構變更動態同步。
 * 復現證據：真實會話 fd22bd6e（68 rev）——彈跳序列 times [0,0.225,0.625,1,1.025,1.25] 逐字對齊。
 * 注意：director.ts 在模組載入時讀 WORKSPACE_DIR，必須在首次動態 import 前設好 env。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { actionFrameRangeHint, shotFrameRangeHint } from "../lib/director-common"

process.env.WORKSPACE_DIR = mkdtempSync(path.join(tmpdir(), "director-r1-test-"))

type DirectorModule = typeof import("./director")
let director: DirectorModule
async function load(): Promise<DirectorModule> {
  director ??= await import("./director")
  return director
}

const mannequin = (id: string, x: number, z: number) => ({
  id,
  kind: "mannequin" as const,
  name: `演员-${id}`,
  position: { x, y: 0, z },
  rotationDeg: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  color: "#cccccc",
  visible: true,
  groupId: null,
  poseId: "stand",
  joints: { hips: { x: 1, y: 2, z: 3 } },
  heightM: 1.75,
})

/** 建基礎工程：1 元素 + bare 方案 + 兩鏡頭（S4 3.5s / S5 5s），回傳 shot id */
async function seedTwoShots(sid: string, elementId: string): Promise<[string, string]> {
  const { applyDirectorOps } = await load()
  const r1 = await applyDirectorOps(sid, [
    { op: "addElement", element: mannequin(elementId, -5, 0) },
    { op: "addPlan", plan: { name: "R1 測試", shots: [] } },
  ], "test-setup")
  const r2 = await applyDirectorOps(sid, [
    { op: "addShot", shot: { name: "S4-对峙", durationSec: 3.5 } },
    { op: "addShot", shot: { name: "S5-收尾", durationSec: 5 } },
  ], "test-shots")
  void r1
  const shots = (r2.project.plans as Array<{ shots: Array<{ id: string }> }>)[0].shots
  return [shots[0].id, shots[1].id]
}

test("R1-#1 summary 模式剝除全部 joints 並保留動作摘要（默認 full 不變）", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r1-summary-mode"
  const [s4] = await seedTwoShots(sid, "el-sum")
  await applyDirectorOps(sid, [
    { op: "addAction", shot_id: s4, action: { element_id: "el-sum", action: "walk", start_sec: 0, duration_sec: 2, to: { x: 2, y: 0, z: 0 } } },
    { op: "updateShot", shot_id: s4, patch: { cameraKeyframes: [{ id: "ckf-r1", timeSec: 0, position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 1, z: 0 }, fov: 50, rollDeg: 0, interpolation: "smooth", source: "agent" }] } },
  ], "test")

  const full = await getDirectorState(sid)
  const summary = await getDirectorState(sid, "summary")
  assert.equal(full.mode, "full")
  assert.equal(summary.mode, "summary")

  const fullJson = JSON.stringify(full)
  const summaryJson = JSON.stringify(summary)
  assert.ok(fullJson.includes('"joints"'), "full 模式必須保留 joints（前端 viewport 依賴）")
  assert.ok(!summaryJson.includes('"joints"'), "summary 模式必須剝除所有 joints（元素姿態 + K 幀關節）")
  assert.ok(fullJson.length > summaryJson.length)

  // 動作摘要欄位
  const sPlan = (summary.project as unknown as { plans: Array<{ shots: Array<{ actions: Array<Record<string, unknown>>; elementStates: Record<string, { visible: boolean }> }> }> }).plans[0]
  const action = sPlan.shots[0].actions[0]
  assert.equal(action.keyframe_count, 5)
  assert.equal(action.action, "walk")
  assert.equal(action.elementId, "el-sum")
  assert.deepEqual(action.first_position, { x: -5, y: 0, z: 0 })
  assert.deepEqual(action.last_position, { x: 2, y: 0, z: 0 })
  // cameraKeyframes 摘要只留 id/幀位/位置（full 模式保留 target/fov 等）
  const camFull = (full.project as unknown as { plans: Array<{ shots: Array<{ cameraKeyframes: Array<Record<string, unknown>> }> }> }).plans[0].shots[0].cameraKeyframes
  const cam = (summary.project as unknown as { plans: Array<{ shots: Array<{ cameraKeyframes: Array<Record<string, unknown>> }> }> }).plans[0].shots[0].cameraKeyframes
  assert.equal(camFull.length, 1)
  assert.equal(cam.length, 1)
  assert.ok("target" in camFull[0] && "fov" in camFull[0], "full 模式攝影機 K 幀保留完整欄位")
  assert.deepEqual(Object.keys(cam[0]).sort(), ["id", "position", "timeSec"])
  // 結構保留：shots/elementStates/counts/health
  assert.equal(sPlan.shots[0].elementStates["el-sum"].visible, true)
  assert.deepEqual(summary.counts, { shots: 2, elements: 1, actions: 1 })
  assert.ok(Array.isArray(summary.health.issues))
  assert.equal(summary.initialized, true)
})

test("R1-#2 動作 from 默認接續上一鏡末幀求解位置；首鏡頭維持現狀；顯式 from 可覆蓋", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r1-from-chain"
  const [s4, s5] = await seedTwoShots(sid, "el-chain")
  await applyDirectorOps(sid, [
    { op: "addAction", shot_id: s4, action: { element_id: "el-chain", action: "run", start_sec: 0, duration_sec: 2, to: { x: 14.5, y: 0, z: -1.5 } } },
  ], "S4")
  // S5：舊邏輯會錨滯留的 elementStates (-5,0,0)（真實會話 12 次手工錨定的根因）
  const rS5 = await applyDirectorOps(sid, [
    { op: "addAction", shot_id: s5, action: { element_id: "el-chain", action: "step-back", start_sec: 0, duration_sec: 1.25, to: { x: 15, y: 0, z: -2 } } },
  ], "S5")
  let act = (rS5.project.plans as unknown as Array<{ shots: Array<{ actions: Array<{ from: { x: number; y: number; z: number } }> }> }>)[0].shots[1].actions[0]
  assert.deepEqual(
    { x: Math.round(act.from.x * 100) / 100, y: act.from.y, z: Math.round(act.from.z * 100) / 100 },
    { x: 14.5, y: 0, z: -1.5 },
    "S5 from 必須求解為 S4 末幀位置 (14.5,0,-1.5)",
  )
  // 首鏡頭（無前序無同鏡前動作）維持現狀 elementStates
  const stFull = await getDirectorState(sid)
  act = (stFull.project as unknown as { plans: Array<{ shots: Array<{ actions: Array<{ from: { x: number; y: number; z: number } }> }> }> }).plans[0].shots[0].actions[0]
  assert.deepEqual(act.from, { x: -5, y: 0, z: 0 })
  // 顯式 from 覆蓋
  const rExplicit = await applyDirectorOps(sid, [
    { op: "addAction", shot_id: s5, action: { element_id: "el-chain", action: "wait", start_sec: 2, duration_sec: 1, from: { x: 9, y: 0, z: 9 } } },
  ], "explicit-from")
  act = (rExplicit.project.plans as unknown as Array<{ shots: Array<{ actions: Array<{ from: { x: number; y: number; z: number } }> }> }>)[0].shots[1].actions[1]
  assert.deepEqual(act.from, { x: 9, y: 0, z: 9 })
  // 原地動作（無 to）：to 接續求解 from，不再虛構 (0,0,0)
  const rInPlace = await applyDirectorOps(sid, [
    { op: "addAction", shot_id: s5, action: { element_id: "el-chain", action: "nod", start_sec: 3, duration_sec: 0.8 } },
  ], "in-place")
  const inPlace = (rInPlace.project.plans as unknown as Array<{ shots: Array<{ actions: Array<{ from: { x: number; z: number }; to: { x: number; z: number } }> }> }>)[0].shots[1].actions[2]
  void act
  assert.equal(inPlace.to.x, inPlace.from.x)
  assert.equal(inPlace.to.z, inPlace.from.z)
  assert.ok(Math.abs(inPlace.from.x) > 0.01 || Math.abs(inPlace.from.z) > 0.01, "原地動作 to 不得虛構為原點")
})

test("R1-#3 空工程 auto-seed 播 bare plan（無模板鏡頭垃圾）", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r1-bare-seed"
  // 空工程直接 addShot（requiresPlan op）→ 前置播種必須是 bare 殼，追加後全方案僅 1 鏡頭
  const r = await applyDirectorOps(sid, [{ op: "addShot", shot: { name: "唯一鏡頭" } }], "bare-seed")
  const plans = r.project.plans as unknown as Array<{ name: string; summary: string; shots: unknown[] }>
  assert.equal(plans.length, 1)
  assert.equal(plans[0].shots.length, 1, "auto-seed 不得攜帶 4 個模板鏡頭")
  assert.equal(plans[0].name, "未命名方案")
  // proposals 路徑的 makeDefaultPlan 播種語義不受影響（base 仍可生成候選）
  const state = await getDirectorState(sid)
  assert.equal(state.initialized, true)
})

test("R1-#4 K 幀升冪重排 + 同幀去重（真實會話彈跳樣本逐字復現後收斂）", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r1-kf-normalize"
  const [s4] = await seedTwoShots(sid, "el-kf")
  await applyDirectorOps(sid, [
    { op: "addAction", shot_id: s4, action: { element_id: "el-kf", action: "walk", start_sec: 0, duration_sec: 1.25, to: { x: 3, y: 0, z: 0 } } },
  ], "walk")
  const state = await getDirectorState(sid)
  const action = (state.project as unknown as { plans: Array<{ shots: Array<{ actions: Array<{ id: string; keyframes: Array<{ id: string; timeSec: number; position: { x: number; y: number; z: number }; interpolation: "smooth" }> }> }> }> }).plans[0].shots[0].actions[0]
  // 舊工具半幀窗合併產物（彈跳形狀）+ 亂序提交
  const bouncePatch = [
    { ...action.keyframes[3] }, // t=1.025 模板填充（11.4 類比位）
    { id: "kf-user001", timeSec: 1.0, position: { x: 3, y: 0, z: 0 }, interpolation: "smooth" as const, source: "agent" as const, note: "提前到達" },
    { ...action.keyframes[0] },
    { ...action.keyframes[4] },
    { ...action.keyframes[2] },
    { ...action.keyframes[1] },
  ]
  const r = await applyDirectorOps(sid, [
    { op: "updateAction", shot_id: s4, action_id: action.id, patch: { keyframes: bouncePatch } },
  ], "set_motion_keyframe@468")
  const after = (r.project.plans as unknown as Array<{ shots: Array<{ actions: Array<{ keyframes: Array<{ id: string; timeSec: number; position: { x: number; y: number; z: number }; interpolation: "smooth" }> }> }> }>)[0].shots[0].actions[0].keyframes
  assert.equal(after.length, 5, "同幀槽（1.0 與 1.025 差 0.6 幀）必須收斂為一幀")
  for (let i = 1; i < after.length; i++) {
    assert.ok(after[i].timeSec - after[i - 1].timeSec >= 1 / 24 - 1e-9, `K 幀間隔必須 ≥ 一幀：${after[i - 1].timeSec} → ${after[i].timeSec}`)
  }
  assert.equal(after[3].timeSec, 1, "同幀槽保留較早者（用戶提前到達幀）")
  // 完全同刻重複幀去重
  const dup = [...after.map((k) => ({ ...k })), { ...after[2], id: "kf-dup" }]
  const r2 = await applyDirectorOps(sid, [
    { op: "updateAction", shot_id: s4, action_id: action.id, patch: { keyframes: dup } },
  ], "dup")
  const after2 = (r2.project.plans as unknown as Array<{ shots: Array<{ actions: Array<{ keyframes: unknown[] }> }> }>)[0].shots[0].actions[0].keyframes
  assert.equal(after2.length, after.length, "完全同刻重複幀必須去重")
  // 人工鎖定幀永不丟棄：鎖定幀落在同幀槽（1/24 內）也必須保留
  const withLocked = [...after.map((k) => ({ ...k })), { id: "kf-locked", timeSec: after[2].timeSec + 0.01, position: { x: 9, y: 9, z: 9 }, interpolation: "smooth" as const, locked: true }]
  const r3 = await applyDirectorOps(sid, [
    { op: "updateAction", shot_id: s4, action_id: action.id, patch: { keyframes: withLocked } },
  ], "locked-guard")
  const after3 = (r3.project.plans as unknown as Array<{ shots: Array<{ actions: Array<{ keyframes: Array<{ id: string; locked?: boolean }> }> }> }>)[0].shots[0].actions[0].keyframes
  assert.ok(after3.some((k) => k.id === "kf-locked" && k.locked), "同幀槽內的鎖定幀不得被去重丟棄")
})

test("R1-#5 project_frame 越界 hint 帶動作/鏡頭幀範圍", async () => {
  // 對齊真實會話：S5 startSec 18.5，step-back 0-1.25s，project_frame 468 越界
  assert.equal(
    actionFrameRangeHint(468, 18.5, 0, 1.25),
    "project_frame 468 不在该动作片段范围内（该动作 project_frame 444-474，即镜头内 0-30）",
  )
  assert.equal(
    shotFrameRangeHint(600, 18.5, 5),
    "project_frame 600 不在该镜头范围内（该镜头 project_frame 444-564）",
  )
})

test("R1-#6 plan.summary 隨 addShot/removeShot/reorderShot 動態同步", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r1-summary-sync"
  const { applyDirectorOps: apply } = await load()
  void apply
  const r0 = await applyDirectorOps(sid, [{ op: "addPlan", plan: { shots: [] } }], "bare")
  let plans = r0.project.plans as unknown as Array<{ id: string; summary: string; shots: Array<{ id: string; name: string; durationSec: number }> }>
  assert.equal(plans[0].summary, "0 个镜头 · 0 秒", "bare 方案摘要同步空工程口徑")
  const planId = plans[0].id

  const r1 = await applyDirectorOps(sid, [
    { op: "addShot", shot: { name: "A", durationSec: 3.75 } },
    { op: "addShot", shot: { name: "B", durationSec: 2.5 } },
  ], "two-shots")
  plans = r1.project.plans as unknown as typeof plans
  assert.equal(plans[0].summary, "2 个镜头 · 6.25 秒")

  const r2 = await applyDirectorOps(sid, [{ op: "reorderShot", shot_id: plans[0].shots[1].id, to_index: 0 }], "reorder")
  plans = r2.project.plans as unknown as typeof plans
  assert.equal(plans[0].shots[0].name, "B")
  assert.equal(plans[0].summary, "2 个镜头 · 6.25 秒", "reorder 後摘要秒數同步重算")

  const r3 = await applyDirectorOps(sid, [{ op: "removeShot", shot_id: plans[0].shots[0].id }], "remove")
  plans = r3.project.plans as unknown as typeof plans
  assert.equal(plans[0].summary, "1 个镜头 · 3.75 秒")
  assert.equal(planId, plans[0].id)
  // 其他方案不受污染
  const state = await getDirectorState(sid)
  assert.equal((state.project.plans as Array<{ summary: string }>).length, 1)
})
