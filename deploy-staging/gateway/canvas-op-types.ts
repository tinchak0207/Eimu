// 画布 op 型别白名单（2026-10-03 从 canvas-cascade-state.ts 抽出）。
//
// 为什么单独一支：canvas-cascade-state.ts 的 import 链会拉起 sessions-core（DB/SSE），
// 让「白名单本身」无法在不起服务的前提下做真行为断言。本档零依赖，可独立测试；
// 原档 re-export 保持既有呼叫端（media-internal-routes）不变。

export const CANVAS_OPS_MAX = 100

/** 允许经 canvas_apply_ops / 前端下发的 op 型别（唯一真源）。 */
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
  // 节点版本回退（2026-10-03，人机共笔回滚面）：前端 agent_ops 分派到 reducer 既有
  // `revert_node`（只还原 title+metadata，座标不动；回退本身也落一版）。
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
