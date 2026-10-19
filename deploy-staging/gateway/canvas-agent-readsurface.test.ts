// 人机共笔读面／回滚面验收（2026-10-03）：真行为断言，非源码字串扫描。
//   1) validateCanvasOps 放行 revert_node（回滚 op 进得了画布）、仍拒未知型别。
//   2) compactCanvasState 透传 dsl / node_versions（agent 读回可逆声明与版本史）。
//   3) buildCanvasReceipt 摘要带 dsl + workflow_versions；node_id 单点带该节点版本清单。
// 跑法：timeout 60 bun run deploy-staging/gateway/canvas-agent-readsurface.test.ts
import { validateCanvasOps } from "./canvas-op-types.ts"
import { compactCanvasState } from "../opencode-runtime/lib/canvas-flow.ts"
import { buildCanvasReceipt } from "../opencode-runtime/lib/canvas-state-summary.ts"

let failed = 0
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

// ── 1. op whitelist
const revert = validateCanvasOps([{ type: "revert_node", nodeId: "wf-abc", version: 2 }])
check("validateCanvasOps 放行 revert_node", "ok" in revert && revert.ok === true, JSON.stringify(revert))
const bogus = validateCanvasOps([{ type: "nope_node" }])
check("validateCanvasOps 仍拒未知 op 型别", "message" in bogus, JSON.stringify(bogus))

// ── 2/3. snapshot passthrough
const dsl = [{ workflow: "demo_wf", steps: [{ id: "brief", title: "简报" }] }]
const nodeVersions = [{ node_id: "wf-abc", title: "镜头A", versions: [{ version: 1, created_at: "t", reason: "created", title: "v1" }] }]
const state = {
  nodes: [
    { id: "wf-abc", type: "image", title: "镜头A", position: { x: 1, y: 2 }, width: 340, height: 240, metadata: { stepId: "shot_a" } },
  ],
  connections: [{ id: "c1", fromNodeId: "wf-x", toNodeId: "wf-abc" }],
  selectedNodeIds: ["wf-abc"],
  viewport: { x: 0, y: 0, k: 1 },
  dsl,
  node_versions: nodeVersions,
}

const compact = compactCanvasState(state)
check("compactCanvasState 透传 dsl", JSON.stringify(compact.dsl) === JSON.stringify(dsl))
check("compactCanvasState 透传 node_versions", JSON.stringify(compact.node_versions) === JSON.stringify(nodeVersions))

const summary = buildCanvasReceipt(state, { view: "summary" }) as Record<string, unknown>
check("receipt 摘要带 dsl", JSON.stringify(summary.dsl) === JSON.stringify(dsl))
check("receipt 摘要带 workflow_versions", JSON.stringify(summary.workflow_versions) === JSON.stringify(nodeVersions))
check("receipt 仍回节点摘要", Array.isArray(summary.nodes) && (summary.nodes as unknown[]).length === 1)

const single = buildCanvasReceipt(state, { nodeId: "wf-abc" }) as Record<string, unknown>
check("receipt 单点带该节点版本清单", Array.isArray(single.versions) && (single.versions as unknown[]).length === 1)
check("receipt 单点仍回上下游", Array.isArray(single.upstream))

const full = buildCanvasReceipt(state, { view: "full" }) as Record<string, unknown>
const fullState = full.state as Record<string, unknown>
check("receipt full 亦带 dsl", JSON.stringify(fullState.dsl) === JSON.stringify(dsl))

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log("\nall canvas-agent-readsurface checks passed")
