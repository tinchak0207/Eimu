/**
 * director-proposals-persistence.test.ts — 2026-09-04 proposals 落盘契约测试（node:test，tsx 运行）。
 * 病灶（R3 复测实锤）：pendingProposals 内存 Map 随 agent-gateway 重启清零 → 用户手里提案卡全部过期。
 * 覆盖：①create 落盘 + 正常 apply 往返（回归）+ 成功后盘上消费删；
 * ②模拟重启（__clearPendingProposalsForTest 清内存 Map，盘保留）→ apply 仍成功走盘载入路径（持久化实锤）；
 * ③盘上条目过期（篡改 createdAt）→ apply 仍 DirectorNotFoundError（R3-③ 文案守卫不破）且过期条目被删盘；
 * ④多轮 create 合并不互相覆盖 + 过期条目随写清理。
 * 注意：director.ts 在模组载入时读 DIRECTOR_DATA_ROOT，必须在首次动态 import 前设好 env。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = mkdtempSync(path.join(tmpdir(), "director-proposals-test-"))
process.env.DIRECTOR_DATA_ROOT = ROOT

type DirectorModule = typeof import("./director")
let director: DirectorModule
async function load(): Promise<DirectorModule> {
  director ??= await import("./director")
  return director
}

const proposalsFile = (sid: string) => path.join(ROOT, sid, "proposals.json")
const readDisk = (sid: string): Record<string, { plans: unknown[]; createdAt: number }> =>
  JSON.parse(readFileSync(proposalsFile(sid), "utf-8")) as Record<string, { plans: unknown[]; createdAt: number }>

test("P-① create 即落盘；内存命中 apply 成功且盘上消费删", async () => {
  const { createDirectorProposals, applyDirectorProposal } = await load()
  const sid = "persist-normal"
  const created = await createDirectorProposals(sid, "沙漠夜逃商队遭遇沙暴", 4)
  assert.equal(created.proposal_ids.length, 3)
  // 落盘实锤：三个 id 全在盘上，plans 各 1 案
  const disk = readDisk(sid)
  assert.deepEqual(Object.keys(disk).sort(), [...created.proposal_ids].sort())
  for (const id of created.proposal_ids) assert.equal(disk[id].plans.length, 1)
  // 内存命中路径 apply 成功
  const applied = await applyDirectorProposal(sid, created.proposal_ids[0])
  assert.equal(applied.ok, true)
  assert.equal((applied.project.plans as unknown[]).length, 1, "replacePlans 只留被批准一案")
  // 消费后盘上同步清除，其余两案保留
  const after = readDisk(sid)
  assert.ok(!(created.proposal_ids[0] in after))
  assert.equal(Object.keys(after).length, 2)
})

test("P-② 模拟重启（清内存 Map）后 apply 仍成功：走盘载入路径", async () => {
  const { createDirectorProposals, applyDirectorProposal, __clearPendingProposalsForTest, getDirectorState } = await load()
  const sid = "persist-restart"
  const created = await createDirectorProposals(sid, "雨夜天台对决", 5)
  __clearPendingProposalsForTest()
  // 重启语义：内存全空，仅剩盘上档案
  const applied = await applyDirectorProposal(sid, created.proposal_ids[1])
  assert.equal(applied.ok, true)
  assert.equal((applied.project.plans as unknown[]).length, 1)
  const state = await getDirectorState(sid)
  assert.equal(state.initialized, true)
  assert.equal((state.project.plans as unknown[]).length, 1, "盘载入路径的 replacePlans 照常落 current")
  assert.ok(!(created.proposal_ids[1] in readDisk(sid)), "盘载入消费后条目删除")
  assert.equal(Object.keys(readDisk(sid)).length, 2)
})

test("P-③ 盘上条目过期 → apply 仍 404 文案守卫 + 过期条目删盘", async () => {
  const { createDirectorProposals, applyDirectorProposal, DirectorNotFoundError, __clearPendingProposalsForTest } = await load()
  const sid = "persist-expired"
  const created = await createDirectorProposals(sid, "雪原护送", 3)
  __clearPendingProposalsForTest()
  // 篡改盘上 createdAt 至 31 分钟前（TTL 30 分）
  const disk = readDisk(sid)
  for (const id of Object.keys(disk)) disk[id].createdAt = Date.now() - 31 * 60_000
  writeFileSync(proposalsFile(sid), JSON.stringify(disk), "utf-8")
  await assert.rejects(
    () => applyDirectorProposal(sid, created.proposal_ids[0]),
    (e: unknown) => {
      assert.ok(e instanceof DirectorNotFoundError)
      const msg = (e as Error).message
      assert.match(msg, /候选方案不存在或已过期，请重新生成/)
      assert.match(msg, /必须重新向用户出提案卡并等待用户批准/)
      assert.match(msg, /禁止生成新 proposal 后直接 apply/)
      return true
    },
  )
  assert.ok(!(created.proposal_ids[0] in readDisk(sid)), "被校验的过期条目已删盘")
  assert.equal(Object.keys(readDisk(sid)).length, 2, "其余过期条目留待下次 create 合并时清理（读路径不隐式写）")
})

test("P-④ 多轮 create 合并共存；写盘时顺手清过期条目", async () => {
  const { createDirectorProposals, __clearPendingProposalsForTest } = await load()
  const sid = "persist-merge"
  const first = await createDirectorProposals(sid, "港口追逐", 2)
  // 手工把第一轮盘上条目改过期，模拟「旧提案躺在盘上」
  const disk = readDisk(sid)
  for (const id of Object.keys(disk)) disk[id].createdAt = Date.now() - 31 * 60_000
  writeFileSync(proposalsFile(sid), JSON.stringify(disk), "utf-8")
  const second = await createDirectorProposals(sid, "港口追逐", 2)
  const after = readDisk(sid)
  assert.equal(Object.keys(after).length, 3, "第二轮 3 案落盘，过期第一轮被顺手清理")
  for (const id of second.proposal_ids) assert.ok(id in after)
  for (const id of first.proposal_ids) assert.ok(!(id in after))
  __clearPendingProposalsForTest()
})
