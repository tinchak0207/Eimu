import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayDispatchOps } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// workflow_rollback — 人机共笔的回滚面：把某节点的内容还原到指定版本（省略 version = 上一版）。
// 语义复用画布 reducer 的 revert_node：只还原 title+metadata，座标/尺寸不动；回退本身也落一版
// （reason="revert"），因此回退可再被回退（append-only，不覆盖历史）。
export default tool({
  description:
    "把某个节点的内容回滚到指定版本（版本史见 workflow_history / canvas_get_state 的 workflow_versions）。\n\n" +
    "version 省略 = 回上一版。只还原内容（title+metadata），不动节点位置/尺寸；回滚本身也会落一版（reason=revert），所以可再回滚回去。\n" +
    "用在用户说「这步退回上一版 / 用回第 2 版那个提示词」时；要改出新内容（不是回旧内容）用 workflow_write 或 canvas_apply_ops 的 update_node。",
  args: {
    node_id: tool.schema.string().describe("要回滚的节点 id（画布节点 id，如 wf-… 或 tpl-…）"),
    version: tool.schema.number().int().positive().optional().describe("目标版本号；省略 = 上一版"),
    label: tool.schema.string().optional().describe("给用户看的一句话操作意图，如「退回上一版」"),
  },
  async execute(args, context) {
    const op: Record<string, unknown> = { type: "revert_node", nodeId: args.node_id }
    if (typeof args.version === "number") op.version = args.version
    const outcome = await gatewayDispatchOps(GATEWAY, context.sessionID, [op], args.label)
    if (outcome.code === "OPS_TIMEOUT") {
      return fail("ops_timeout", "前端 30 秒内未回执（画布页可能未打开或已断线）。请让用户打开画布工作台后重试。", {
        request_id: outcome.request_id,
      })
    }
    if (outcome.ok !== true) {
      return fail("canvas_ops_failed", outcome.error || (outcome.status ? `HTTP ${outcome.status}` : "下发失败"))
    }
    const result = outcome.result ?? {}
    if (result.ok !== true) {
      return fail("ops_rejected", result.error || "前端执行回滚失败（可能没有可回退的版本）", {
        request_id: outcome.request_id,
      })
    }
    return ok({ request_id: outcome.request_id, node_id: args.node_id, version: args.version ?? "previous" })
  },
})
