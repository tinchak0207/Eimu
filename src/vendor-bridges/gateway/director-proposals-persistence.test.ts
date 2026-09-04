/**
 * director-proposals-persistence.test.ts — 2026-09-04 proposals 落盤契約測試（node:test，tsx 運行）。
 * 病灶（R3 複測實錘）：pendingProposals 內存 Map 隨 agent-gateway 重啟清零 → 用戶手裡提案卡全部過期。
 * 覆蓋：①create 落盤 + 正常 apply 往返（回歸）+ 成功後盤上消費刪；
 * ②模擬重啟（__clearPendingProposalsForTest 清內存 Map，盤保留）→ apply 仍成功走盤載入路徑（持久化實錘）；
 * ③盤上條目過期（篡改 createdAt）→ apply 仍 DirectorNotFoundError（R3-③ 文案守衛不破）且過期條目被刪盤；
 * ④多輪 create 合併不互相覆蓋 + 過期條目隨寫清理。
 * 注意：director.ts 在模組載入時讀 DIRECTOR_DATA_ROOT，必須在首次動態 import 前設好 env。
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

test("P-① create 即落盤；內存命中 apply 成功且盤上消費刪", async () => {
  const { createDirectorProposals, applyDirectorProposal } = await load()
  const sid = "persist-normal"
  const created = await createDirectorProposals(sid, "沙漠夜逃商队遭遇沙暴", 4)
  assert.equal(created.proposal_ids.length, 3)
  // 落盤實錘：三個 id 全在盤上，plans 各 1 案
  const disk = readDisk(sid)
  assert.deepEqual(Object.keys(disk).sort(), [...created.proposal_ids].sort())
  for (const id of created.proposal_ids) assert.equal(disk[id].plans.length, 1)
  // 內存命中路徑 apply 成功
  const applied = await applyDirectorProposal(sid, created.proposal_ids[0])
  assert.equal(applied.ok, true)
  assert.equal((applied.project.plans as unknown[]).length, 1, "replacePlans 只留被批准一案")
  // 消費後盤上同步清除，其餘兩案保留
  const after = readDisk(sid)
  assert.ok(!(created.proposal_ids[0] in after))
  assert.equal(Object.keys(after).length, 2)
})

test("P-② 模擬重啟（清內存 Map）後 apply 仍成功：走盤載入路徑", async () => {
  const { createDirectorProposals, applyDirectorProposal, __clearPendingProposalsForTest, getDirectorState } = await load()
  const sid = "persist-restart"
  const created = await createDirectorProposals(sid, "雨夜天台对决", 5)
  __clearPendingProposalsForTest()
  // 重啟語義：內存全空，僅剩盤上檔案
  const applied = await applyDirectorProposal(sid, created.proposal_ids[1])
  assert.equal(applied.ok, true)
  assert.equal((applied.project.plans as unknown[]).length, 1)
  const state = await getDirectorState(sid)
  assert.equal(state.initialized, true)
  assert.equal((state.project.plans as unknown[]).length, 1, "盤載入路徑的 replacePlans 照常落 current")
  assert.ok(!(created.proposal_ids[1] in readDisk(sid)), "盤載入消費後條目刪除")
  assert.equal(Object.keys(readDisk(sid)).length, 2)
})

test("P-③ 盤上條目過期 → apply 仍 404 文案守衛 + 過期條目刪盤", async () => {
  const { createDirectorProposals, applyDirectorProposal, DirectorNotFoundError, __clearPendingProposalsForTest } = await load()
  const sid = "persist-expired"
  const created = await createDirectorProposals(sid, "雪原护送", 3)
  __clearPendingProposalsForTest()
  // 篡改盤上 createdAt 至 31 分鐘前（TTL 30 分）
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
  assert.ok(!(created.proposal_ids[0] in readDisk(sid)), "被校驗的過期條目已刪盤")
  assert.equal(Object.keys(readDisk(sid)).length, 2, "其餘過期條目留待下次 create 合併時清理（讀路徑不隱式寫）")
})

test("P-④ 多輪 create 合併共存；寫盤時順手清過期條目", async () => {
  const { createDirectorProposals, __clearPendingProposalsForTest } = await load()
  const sid = "persist-merge"
  const first = await createDirectorProposals(sid, "港口追逐", 2)
  // 手工把第一輪盤上條目改過期，模擬「舊提案躺在盤上」
  const disk = readDisk(sid)
  for (const id of Object.keys(disk)) disk[id].createdAt = Date.now() - 31 * 60_000
  writeFileSync(proposalsFile(sid), JSON.stringify(disk), "utf-8")
  const second = await createDirectorProposals(sid, "港口追逐", 2)
  const after = readDisk(sid)
  assert.equal(Object.keys(after).length, 3, "第二輪 3 案落盤，過期第一輪被順手清理")
  for (const id of second.proposal_ids) assert.ok(id in after)
  for (const id of first.proposal_ids) assert.ok(!(id in after))
  __clearPendingProposalsForTest()
})
