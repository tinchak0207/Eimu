/**
 * director-r3.test.ts — 2026-09-03 驗屍修復 R3 gateway 契約測試（node:test，tsx 運行）。
 * 覆蓋：①無 plan 即播種（addElement-first 死路修復）、②capabilities 進 state、
 * ③提案過期文案禁止靜默換案、④提案尊重鏡頭數（顯式 shot_count + instruction 解析 + 循環湊數）、
 * ⑤群組寫路徑（addGroup/removeGroup 契約往返 + 雙向同步 + state 兩態 + HTTP 單發信封）、
 * ⑥動作重疊守衛（默認報錯帶 id/區間、force 覆蓋出口、鄰接/異元素不误傷）、⑦錯誤文案衛生。
 * 證據源：eval-director-extreme/REPORT.md §5（P0-1/P1-2/P1-4/P1-5/P1-6/P2-7/P2-12）。
 * 注意：director.ts 在模組載入時讀 WORKSPACE_DIR/DIRECTOR_DATA_ROOT，必須在首次動態 import 前設好 env。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.WORKSPACE_DIR = mkdtempSync(path.join(tmpdir(), "director-r3-test-"))

type DirectorModule = typeof import("./director")
let director: DirectorModule
async function load(): Promise<DirectorModule> {
  director ??= await import("./director")
  return director
}

const mannequin = (id: string, x = 0, z = 0) => ({
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

type PlansWithShots = Array<{ id: string; name: string; summary: string; shots: Array<{ id: string; name: string; actions: Array<{ id: string }> }> }>

// ── ① P0：無 plan 即播種 ─────────────────────────────────────────────────────

test("R3-① addElement-first 不再繞過播種：後續 requiresPlan op 自動注入 bare addPlan", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r3-seed-first-add"
  // 首 op addElement（舊門禁只在 !current 播種 → doc 建了但 plans 空，REPORT P0-1 死路起點）
  const r1 = await applyDirectorOps(sid, [{ op: "addElement", element: mannequin("el-seed", 1, 1) }], "first")
  assert.equal((r1.project.plans as unknown[]).length, 0, "addElement 自身不觸發播種")
  // 次 op 需 plan（manage_shot→addShot）→ 通用守衛注入 bare addPlan，不再撞「当前没有活动方案」
  const r2 = await applyDirectorOps(sid, [{ op: "addShot", shot: { name: "S1", durationSec: 3 } }], "second")
  const plans = r2.project.plans as unknown as PlansWithShots
  assert.equal(plans.length, 1)
  assert.equal(plans[0].name, "未命名方案", "播種必須是 bare 殼（R1-#3 語義）")
  assert.equal(plans[0].shots.length, 1)
  const state = await getDirectorState(sid)
  assert.ok(state.active_plan_id, "播種後 activePlanId 不得為 null")
  // 已有 activePlan 的用戶零影響：再發需 plan op 不追加第二方案
  const r3 = await applyDirectorOps(sid, [{ op: "addShot", shot: { name: "S2" } }], "third")
  assert.equal((r3.project.plans as unknown[]).length, 1)
  assert.equal((r3.project.plans as unknown as PlansWithShots)[0].shots.length, 2)
})

// ── ② P1：capabilities 進 state ─────────────────────────────────────────────

test("R3-② state 帶 capabilities（summary/full 兩態 + 未初始化也帶）", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r3-capabilities"
  await applyDirectorOps(sid, [{ op: "addElement", element: mannequin("el-cap") }], "setup")
  const full = await getDirectorState(sid)
  const summary = await getDirectorState(sid, "summary")
  for (const st of [full, summary]) {
    assert.ok(st.capabilities.action_templates.includes("walk"), "action 模板清單")
    assert.ok(st.capabilities.camera_moves.includes("push"), "camera_move 清單")
    assert.ok(st.capabilities.poses.includes("stand"), "pose 清單")
    assert.ok(st.capabilities.supported_ops.includes("addGroup"), "op 清單含群組寫路徑")
    assert.equal(st.capabilities.group_write, true, "⑤完成後如實標群组可写")
    assert.match(st.capabilities.export_boundary, /不会执行渲染导出/, "導出邊界誠實聲明")
  }
  assert.ok(full.capabilities.action_templates.length >= 58, "模板清單應取自註冊表全量")
  const virgin = await getDirectorState("r3-capabilities-virgin")
  assert.equal(virgin.initialized, false)
  assert.ok(virgin.capabilities.action_templates.length > 0, "未初始化工程也要帶能力清單（agent 開局即知邊界）")
})

// ── ③ P1：提案過期禁止靜默換案 ───────────────────────────────────────────────

test("R3-③ 提案過期錯誤文案封死「生成新 proposal 直接 apply」", async () => {
  const { applyDirectorProposal, DirectorNotFoundError } = await load()
  await assert.rejects(
    () => applyDirectorProposal("r3-proposal-expired", "director-proposal-missing"),
    (e: unknown) => {
      assert.ok(e instanceof DirectorNotFoundError)
      const msg = (e as Error).message
      assert.match(msg, /候选方案不存在或已过期，请重新生成/)
      assert.match(msg, /必须重新向用户出提案卡并等待用户批准/)
      assert.match(msg, /禁止生成新 proposal 后直接 apply/)
      return true
    },
  )
})

// ── ④ P1：提案尊重鏡頭數 ─────────────────────────────────────────────────────

test("R3-④ 提案鏡頭數：顯式 shot_count、instruction 正則解析、>8 循環湊數、非法值報錯", async () => {
  const { createDirectorProposals } = await load()
  const sid = "r3-shot-count"
  const explicit = await createDirectorProposals(sid, "沙漠夜逃商队遭遇沙暴", 6)
  assert.equal(explicit.plans.length, 3)
  for (const p of explicit.plans) assert.equal(p.shots.length, 6, `顯式 shot_count=6：${p.name}`)
  const parsed = await createDirectorProposals(sid, "沙漠夜逃 6 个镜头：商队遭遇沙暴")
  for (const p of parsed.plans) assert.equal(p.shots.length, 6, "「N 个镜头」解析")
  const parsedShort = await createDirectorProposals(sid, "追逐 3 镜")
  for (const p of parsedShort.plans) assert.equal(p.shots.length, 3, "「N 镜」解析")
  const none = await createDirectorProposals(sid, "商队行进")
  for (const p of none.plans) assert.equal(p.shots.length, 4, "無計數資訊 → 模板默認 4 鏡")
  const many = await createDirectorProposals(sid, "沙漠夜逃", 12)
  for (const p of many.plans) {
    assert.equal(p.shots.length, 12, "12 > planning-core 上限 8 → 循環湊數兜底")
    assert.equal(new Set(p.shots.map((s) => s.name)).size, 12, "循環克隆鏡頭名稱不得重複")
  }
  await assert.rejects(() => createDirectorProposals(sid, "沙漠夜逃", 13), /shot_count 必须是 1-12 的整数/)
  await assert.rejects(() => createDirectorProposals(sid, "沙漠夜逃", 2.5), /shot_count 必须是 1-12 的整数/)
})

// ── ⑤ P1：群組寫路徑 ─────────────────────────────────────────────────────────

test("R3-⑤ addGroup/removeGroup 往返：契約欄位、雙向同步、只刪組不刪元素、state 兩態", async () => {
  const { applyDirectorOps, getDirectorState } = await load()
  const sid = "r3-group"
  await applyDirectorOps(sid, [
    { op: "addElement", element: mannequin("el-g1", 1, 0) },
    { op: "addElement", element: mannequin("el-g2", 2, 0) },
    { op: "addPlan", plan: { name: "G", shots: [] } },
  ], "setup")
  const rAdd = await applyDirectorOps(sid, [{ op: "addGroup", name: "商队", element_ids: ["el-g1", "el-g2"] }], "group")
  assert.ok(rAdd.group, "addGroup 響應必須帶 group 契約欄位")
  assert.equal(rAdd.group.name, "商队")
  assert.deepEqual(rAdd.group.element_ids, ["el-g1", "el-g2"])
  const gid = rAdd.group.id
  const els = rAdd.project.elements as Array<{ id: string; groupId: string | null }>
  assert.equal(els.find((e) => e.id === "el-g1")?.groupId, gid, "element.groupId 雙向同步")
  assert.equal(els.find((e) => e.id === "el-g2")?.groupId, gid)
  // state 兩態都帶群組；summary 帶 id/name/element_ids
  const full = await getDirectorState(sid)
  assert.deepEqual((full.project.groups as Array<{ id: string }>).map((g) => g.id), [gid])
  const summary = await getDirectorState(sid, "summary")
  const sg = (summary.project.groups as unknown as Array<{ id: string; name: string; element_ids: string[] }>)[0]
  assert.equal(sg.id, gid)
  assert.equal(sg.name, "商队")
  assert.deepEqual(sg.element_ids, ["el-g1", "el-g2"])
  // removeGroup：只刪組不刪元素，成員 groupId 復位
  const rDel = await applyDirectorOps(sid, [{ op: "removeGroup", group_id: gid }], "ungroup")
  assert.equal(rDel.removed_group_id, gid)
  assert.equal((rDel.project.elements as unknown[]).length, 2, "removeGroup 不得刪元素")
  assert.equal((rDel.project.groups as unknown[]).length, 0)
  assert.equal((rDel.project.elements as Array<{ id: string; groupId: string | null }>).find((e) => e.id === "el-g1")?.groupId, null)
  // 負例：元素不存在 / 空成員 / 群組不存在
  await assert.rejects(() => applyDirectorOps(sid, [{ op: "addGroup", name: "X", element_ids: ["nope"] }]), /找不到对象 nope/)
  await assert.rejects(() => applyDirectorOps(sid, [{ op: "addGroup", name: "X", element_ids: [] }]), /element_ids/)
  await assert.rejects(() => applyDirectorOps(sid, [{ op: "removeGroup", group_id: "nope" }]), /找不到群组 nope/)
})

test("R3-⑤/⑦ HTTP 單發信封：addGroup 回 group、removeGroup 回 removed_group_id、未知 op 帶清單", async () => {
  const mod = await load()
  const sid = "r3-group-http"
  mod.setDirectorSessionResolver(() => ({ sessionId: sid, apiKey: "sk-test" }))
  mod.setDirectorEmitter(() => {})
  const post = (payload: Record<string, unknown>) =>
    mod.handleDirectorRoutes(
      "sk-test",
      new Request(`http://gw.local/agent/v1/director/op?session_id=${sid}`, { method: "POST", body: JSON.stringify(payload) }),
      "/agent/v1/director/op",
    )
  await post({ op: "addElement", element: mannequin("el-h1") })
  await post({ op: "addElement", element: mannequin("el-h2") })
  const rAdd = await post({ op: "addGroup", name: "驼队", element_ids: ["el-h1", "el-h2"] })
  const jAdd = (await rAdd.json()) as { ok: boolean; group?: { id: string; name: string; element_ids: string[] }; revision: number }
  assert.equal(rAdd.status, 200)
  assert.equal(jAdd.ok, true)
  assert.equal(jAdd.group?.name, "驼队")
  assert.deepEqual(jAdd.group?.element_ids, ["el-h1", "el-h2"])
  assert.ok(typeof jAdd.revision === "number")
  const rDel = await post({ op: "removeGroup", group_id: jAdd.group!.id })
  const jDel = (await rDel.json()) as { ok: boolean; removed_group_id?: string }
  assert.equal(jDel.removed_group_id, jAdd.group!.id)
  // R3-⑦：未知 op → 400「不支持的操作 <op>，可用：清單」
  const rBad = await post({ op: "bogusOp" })
  const jBad = (await rBad.json()) as { error: { message: string } }
  assert.equal(rBad.status, 400)
  assert.match(jBad.error.message, /^不支持的操作 bogusOp，可用：/)
  assert.match(jBad.error.message, /addGroup/)
})

// ── ⑥ P2：動作重疊守衛 ───────────────────────────────────────────────────────

test("R3-⑥ 同元素同鏡動作重疊默認報錯帶 id+區間；force 覆蓋；鄰接/異元素不误傷", async () => {
  const { applyDirectorOps } = await load()
  const sid = "r3-overlap"
  const r0 = await applyDirectorOps(sid, [
    { op: "addElement", element: mannequin("el-ov", 0, 0) },
    { op: "addPlan", plan: { shots: [] } },
    { op: "addShot", shot: { name: "S1", durationSec: 5 } },
  ], "setup")
  const shotId = (r0.project.plans as unknown as PlansWithShots)[0].shots[0].id
  const rA = await applyDirectorOps(sid, [{ op: "addAction", shot_id: shotId, action: { element_id: "el-ov", action: "look-back", start_sec: 1, duration_sec: 2 } }], "A")
  const idA = (rA.project.plans as unknown as PlansWithShots)[0].shots[0].actions[0].id
  // 重疊 [1,3) vs [2,4) → 結構化錯誤帶兩動作 id 與區間（REPORT P2-7：舊行為直接追加造成位置跳變）
  await assert.rejects(
    () => applyDirectorOps(sid, [{ op: "addAction", shot_id: shotId, action: { element_id: "el-ov", action: "raise-hand", start_sec: 2, duration_sec: 2 } }], "clash"),
    (e: unknown) => {
      const msg = (e as Error).message
      assert.match(msg, /同元素同镜头动作时间重叠/)
      assert.ok(msg.includes(idA), "錯誤必須點名既有動作 id")
      assert.match(msg, /1-3s/)
      assert.match(msg, /2-4s/)
      assert.match(msg, /force:true/, "保留強制覆蓋出口")
      return true
    },
  )
  // 鄰接邊界 [3,4) 不算重疊
  const rB = await applyDirectorOps(sid, [{ op: "addAction", shot_id: shotId, action: { element_id: "el-ov", action: "raise-hand", start_sec: 3, duration_sec: 1 } }], "B")
  assert.equal((rB.project.plans as unknown as PlansWithShots)[0].shots[0].actions.length, 2)
  // 異元素同區間不受影響
  await applyDirectorOps(sid, [{ op: "addElement", element: mannequin("el-ov2", 5, 5) }], "el2")
  const rC = await applyDirectorOps(sid, [{ op: "addAction", shot_id: shotId, action: { element_id: "el-ov2", action: "walk", start_sec: 1, duration_sec: 2 } }], "C")
  assert.equal((rC.project.plans as unknown as PlansWithShots)[0].shots[0].actions.length, 3)
  // force:true 強制覆蓋（舊出口保留）
  const rF = await applyDirectorOps(sid, [{ op: "addAction", shot_id: shotId, action: { element_id: "el-ov", action: "wave", start_sec: 1.5, duration_sec: 1, force: true } }], "force")
  assert.equal((rF.project.plans as unknown as PlansWithShots)[0].shots[0].actions.length, 4)
})

// ── ⑦ P2：錯誤文案衛生 ───────────────────────────────────────────────────────

test("R3-⑦ 空 plan_id 不再回「找不到方案 」（尾空格+空 id）", async () => {
  const { applyDirectorOps } = await load()
  const sid = "r3-msg-hygiene"
  await applyDirectorOps(sid, [{ op: "addPlan", plan: { shots: [] } }], "setup")
  await assert.rejects(
    () => applyDirectorOps(sid, [{ op: "updatePlan", plan_id: "  ", patch: { name: "x" } }], "bad"),
    (e: unknown) => {
      assert.equal((e as Error).message, "找不到方案（未提供有效的 plan_id）")
      return true
    },
  )
  // 真實 id 照帶
  await assert.rejects(
    () => applyDirectorOps(sid, [{ op: "setActivePlan", plan_id: "plan-missing" }], "bad2"),
    /找不到方案 plan-missing/,
  )
})
