// uploads 根的目录列举必须被闸住（2026-10-29 Hack 实测：`read filePath="uploads"` 返回 90 条
// 全租户会话目录名，因为 read 在 PATH_TOOLS 里是 listing=false，旧码对 uploads 根在
// listing=false 时直接放行）。本测试锁住三条行为：根一律拒、本会话目录放行、他会话目录拒。
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

const ws = mkdtempSync(path.join(tmpdir(), "eimu-sandbox-"))
process.env.EIMU_WORKSPACE = ws
mkdirSync(path.join(ws, "uploads", "aaaaaaaa-1111-4111-8111-111111111111"), { recursive: true })
mkdirSync(path.join(ws, "uploads", "bbbbbbbb-2222-4222-8222-222222222222"), { recursive: true })

const { checkAgentPath, setOwner } = await import("./sandbox.ts")

const SID = "ses_test_owner"
setOwner(SID, ["aaaaaaaa-1111-4111-8111-111111111111"])

test("uploads 根：read（listing=false）也拒，不再漏出全租户目录名", () => {
  assert.equal(checkAgentPath("uploads", SID, { listing: false }).ok, false)
  assert.equal(checkAgentPath(path.join(ws, "uploads"), SID, { listing: true }).ok, false)
})

test("本会话附件目录与其档案放行", () => {
  assert.equal(checkAgentPath("uploads/aaaaaaaa-1111-4111-8111-111111111111", SID, { listing: false }).ok, true)
  assert.equal(checkAgentPath("uploads/aaaaaaaa-1111-4111-8111-111111111111/ref.wav", SID).ok, true)
})

test("他会话附件目录拒绝", () => {
  const v = checkAgentPath("uploads/bbbbbbbb-2222-4222-8222-222222222222", SID, { listing: false })
  assert.equal(v.ok, false)
  assert.equal(v.ok === false && v.reason, "foreign_upload")
})

test("workspace 外一律拒", () => {
  const v = checkAgentPath("/etc/hostname", SID)
  assert.equal(v.ok, false)
  assert.equal(v.ok === false && v.reason, "outside_workspace")
})
