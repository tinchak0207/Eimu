// 畫布 op 型別白名單（2026-10-03 從 canvas-cascade-state.ts 抽出）。
//
// 為什麼單獨一支：canvas-cascade-state.ts 的 import 鏈會拉起 sessions-core（DB/SSE），
// 讓「白名單本身」無法在不起服務的前提下做真行為斷言。本檔零依賴，可獨立測試；
// 原檔 re-export 保持既有呼叫端（media-internal-routes）不變。

export const CANVAS_OPS_MAX = 100

/** 允許經 canvas_apply_ops / 前端下發的 op 型別（唯一真源）。 */
export const CANVAS_OP_TYPES = new Set([
  "add_node",
  "update_node",
  "delete_nodes",
  "connect_nodes",
  "delete_connections",
  "select_nodes",
  "set_viewport",
  "run_generation",
  "set_project_meta",
  // 節點版本回退（2026-10-03，人機共筆回滾面）：前端 agent_ops 分派到 reducer 既有
  // `revert_node`（只還原 title+metadata，座標不動；回退本身也落一版）。
  "revert_node",
])

export function validateCanvasOps(ops: unknown): { ok: true; ops: unknown[] } | { ok: false; message: string } {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, message: "ops must be a non-empty array" }
  if (ops.length > CANVAS_OPS_MAX) return { ok: false, message: `too many ops (max ${CANVAS_OPS_MAX})` }
  for (const op of ops) {
    const type = op && typeof op === "object" ? (op as { type?: unknown }).type : undefined
    if (typeof type !== "string" || !CANVAS_OP_TYPES.has(type)) {
      return { ok: false, message: `invalid op type: ${String(type)}` }
    }
  }
  return { ok: true, ops }
}
