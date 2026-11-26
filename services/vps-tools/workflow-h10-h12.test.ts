import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs"
import path from "node:path"
import { buildStatusReceipt } from "./lib/workflow-status-summary"
import { buildUpdateReceipt } from "./lib/workflow-update-receipt"
import { checkAgentPath, WORKSPACE } from "./lib/sandbox"

const bigWorkflow = () => ({
  workflowId: "wf1",
  templateId: "feature_film",
  status: "partial",
  nodes: Array.from({ length: 90 }, (_, i) => ({
    id: `n${i}`, role: "r", kind: "video", title: "镜头".repeat(30),
    status: i === 5 ? "error" : "success",
    content: i === 5 ? "PG 真因：" + "x".repeat(500) : "http://x/" + "y".repeat(2000),
    costCoins: 1,
    metadata: { model: "m", junk: "z".repeat(3000), duration_seconds: 6 },
  })),
  connections: Array.from({ length: 120 }, (_, i) => ({ from: `n${i % 90}`, to: `n${(i + 1) % 90}` })),
  delivery: [{ film_node_id: "n9", delivery_complete: false }],
})

describe("H10 workflow_status summary", () => {
  test("摘要远小于全量，且不会触发截断（<20KB）", () => {
    const wf = bigWorkflow()
    const full = JSON.stringify({ workflow: wf }).length
    const sum = JSON.stringify(buildStatusReceipt(wf)).length
    expect(full).toBeGreaterThan(150_000)
    expect(sum).toBeLessThan(30_000)
  })
  test("error 节点保留完整真因；计数与 delivery 保留", () => {
    const r: any = buildStatusReceipt(bigWorkflow())
    expect(r.nodes[5].content.length).toBeGreaterThan(500)
    expect(r.status_counts).toEqual({ success: 89, error: 1 })
    expect(r.delivery[0].delivery_complete).toBe(false)
    expect(r.connection_count).toBe(120)
    expect(r.nodes[0].metadata.junk).toBeUndefined()
  })
  test("node_id 取单节点完整资料；未知 id 诚实回 found=false", () => {
    const r: any = buildStatusReceipt(bigWorkflow(), { nodeId: "n3" })
    expect(r.node.metadata.junk.length).toBe(3000)
    expect(r.upstream).toContain("n2")
    expect((buildStatusReceipt(bigWorkflow(), { nodeId: "nope" }) as any).found).toBe(false)
  })
  test("view=full 原样回传", () => {
    const wf = bigWorkflow()
    expect((buildStatusReceipt(wf, { view: "full" }) as any).workflow).toBe(wf)
  })
})

describe("H12 workflow_update_node receipt", () => {
  const data = {
    node: { id: "n1", metadata: { model: "minimax-h3", duration_seconds: 6, size: "16:9", deliverable: "d".repeat(300) } },
    affected_node_ids: Array.from({ length: 14 }, (_, i) => `feature_film-node-${i}`),
    status: "pending",
  }
  test("只回数量+前 3 个 id+生效栏位，< 400 字", () => {
    const r: any = buildUpdateReceipt({ data, nodeId: "n1", patch: { model: "minimax-h3", duration_seconds: 6 }, resolvedModel: "minimax-h3" })
    expect(r.affected_count).toBe(14)
    expect(r.affected_preview).toHaveLength(3)
    expect(r.applied).toEqual({ model: "minimax-h3", duration_seconds: 6 })
    expect(r.node).toBeUndefined()
    expect(JSON.stringify({ ok: true, ...r }).length).toBeLessThan(400)
  })
  test("无 affected 时不带 preview", () => {
    const r: any = buildUpdateReceipt({ data: { node: { id: "n1" }, status: "pending" }, nodeId: "n1", patch: {}, resolvedModel: null })
    expect(r.affected_count).toBe(0)
    expect(r.affected_preview).toBeUndefined()
  })
})

describe("H10 grep tool-output 白名单", () => {
  const dir = path.join(WORKSPACE, ".local/share/opencode/tool-output")
  let canWrite = true
  try { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, "tool_test_h10"), "x") } catch { canWrite = false }
  const t = canWrite ? test : test.skip
  t("grep(listing)对单一落盘档放行；对目录仍拒", () => {
    expect(checkAgentPath(path.join(dir, "tool_test_h10"), "s", { listing: true })).toEqual({ ok: true })
    expect(checkAgentPath(dir, "s", { listing: true })).toEqual({ ok: false, reason: "internal_state" })
  })
  test("read 放行；其他内部目录 grep 仍拒；不存在档不放行（listing）", () => {
    expect(checkAgentPath(path.join(dir, "tool_x"), "s")).toEqual({ ok: true })
    expect(checkAgentPath(path.join(dir, "no_such_file_zz"), "s", { listing: true })).toEqual({ ok: false, reason: "internal_state" })
    expect(checkAgentPath(".opencode-state/x", "s", { listing: true })).toEqual({ ok: false, reason: "internal_state" })
  })
})
