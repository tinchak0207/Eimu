import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"
import { buildCanvasReceipt } from "../lib/canvas-state-summary"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "读取用户画布的当前快照（节点/连线/选中/视口的压缩摘要）。当你需要知道画布上有什么、决定新节点摆放位置、或要引用/修改/删除某个现有节点（拿它的 id）时，先调用本工具。节点只含 id/type/title/position/width/height/metadata 摘要，超长文本已截断；图片节点的 metadata.content 是其 URL。默认回摘要（节点计数、按类型/状态汇总、逐节点精简行、连线只回数量；失败信息完整保留）；传 node_id 取单个节点完整数据+上下游+版本史；view=full 取全量（节点多时会被截断）。\n\n" +
    "【改工作流看这里】摘要里若带 `dsl`，那是画布产线的**可逆声明**（WorkflowDslSource[]）—— 要增删改工作流步骤，就改这份 dsl 再用 workflow_write 交回（不要手拼 add_node/connect_nodes 搭流程）。带 `workflow_versions` 时，那是各节点的版本史（供 workflow_history / workflow_rollback 把某步退回旧版）。没有 dsl/workflow_versions = 画布上还没有可编译的产线或版本史。",
  args: {
    node_id: tool.schema.string().optional().describe("只取该节点的完整数据与上下游 id"),
    view: tool.schema.enum(["summary", "full"]).optional().describe("summary（默认）或 full 全量"),
  },
  async execute(args, context) {
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    if (!snap.has_state || snap.state === null) {
      return fail("no_canvas_state", "画布尚未上报状态，请让用户打开画布", {
        hint: "画布尚未上报状态，请让用户打开画布",
      })
    }
    return ok({ ...buildCanvasReceipt(snap.state, { view: args.view, nodeId: args.node_id }), updated_at: snap.updated_at })
  },
})
