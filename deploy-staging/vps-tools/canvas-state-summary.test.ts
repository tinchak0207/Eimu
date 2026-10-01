import { describe, expect, test } from "bun:test"
import { buildCanvasReceipt } from "./lib/canvas-state-summary"

const state = () => ({
  nodes: Array.from({ length: 342 }, (_, i) => ({
    id: `n${i}`, type: i % 2 ? "image" : "text", title: "标题".repeat(40),
    position: { x: i * 10.4, y: 5 }, width: 300, height: 200,
    metadata: {
      content: "http://x/" + "y".repeat(2000), junk: "z".repeat(3000), kind: "image",
      ...(i === 7 ? { status: "error", error: "PG 真因：" + "e".repeat(600) } : { status: "success" }),
    },
  })),
  connections: Array.from({ length: 1213 }, (_, i) => ({ from: `n${i % 342}`, to: `n${(i + 1) % 342}` })),
  selectedNodeIds: ["n1"], viewport: { x: 0, y: 0, zoom: 1 },
})

describe("canvas_get_state summary", () => {
  test("大畫布摘要 <50KB，連線只回數量，計數正確", () => {
    const r: any = buildCanvasReceipt(state())
    expect(JSON.stringify(r).length).toBeLessThan(50_000)
    expect(r.node_count).toBe(342)
    expect(r.connection_count).toBe(1213)
    expect(r.connections).toBeUndefined()
    expect(r.by_type).toEqual({ text: 171, image: 171 })
    expect(r.by_status).toEqual({ success: 341, error: 1 })
    expect(r.selected_node_ids).toEqual(["n1"])
  })
  test("失敗資訊完整保留", () => {
    const r: any = buildCanvasReceipt(state())
    expect(r.failed_node_ids).toEqual(["n7"])
    expect(r.nodes[7].metadata.error.length).toBeGreaterThan(600)
    expect(r.nodes[7].metadata.junk).toBeUndefined()
  })
  test("node_id 取單點含上下游；不存在回 found:false", () => {
    const r: any = buildCanvasReceipt(state(), { nodeId: "n5" })
    expect(r.node.id).toBe("n5")
    expect(r.upstream.length).toBeGreaterThan(0)
    expect((buildCanvasReceipt(state(), { nodeId: "nope" }) as any).found).toBe(false)
  })
  test("view=full 回全量壓縮狀態（含連線）", () => {
    const r: any = buildCanvasReceipt(state(), { view: "full" })
    expect(r.state.connections.length).toBe(1213)
    expect(r.state.nodes.length).toBe(342)
  })
  test("空/壞輸入不拋", () => {
    expect((buildCanvasReceipt(null) as any).node_count).toBe(0)
  })
})
