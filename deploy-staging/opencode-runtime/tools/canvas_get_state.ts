import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"
import { buildCanvasReceipt } from "../lib/canvas-state-summary"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "读取用户画布的当前快照（节点/连线/选中/视口的压缩摘要）。当你需要知道画布上有什么、决定新节点摆放位置、或要引用/修改/删除某个现有节点（拿它的 id）时，先调用本工具。节点只含 id/type/title/position/width/height/metadata 摘要，超长文本已截断；图片节点的 metadata.content 是其 URL。默认回摘要（节点计数、按类型/状态汇总、逐节点精简行、连线只回数量；失败信息完整保留）；传 node_id 取单个节点完整数据+上下游+版本史；view=full 取全量（节点多时会被截断）。\n\n" +
    "【改工作流看这里】摘要里的 `dsl` **就是**画布产线的权威骨架（WorkflowDslSource[]）——**`dsl` 已自动覆盖存量画布上的产线节点**（不只编译器产物／模板卡／gateway 骨架，也包括没有产线身份键的「提示词节点＋生成配置节点」），每个 step 的 `meta._origin_node_id`（＝原画布节点 id）由读面自动填好：**读到就直接改它，`meta._origin_node_id` 原样带回，不要自己发明**——要增删改工作流步骤，就改这份 `dsl` 的 `steps` 再用 workflow_write 整份交回（不要手拼 add_node/connect_nodes 搭流程）。**改提示词要改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。`dsl` 为空有两种原因：①画布上确实没有任何产线节点；②画布太大，骨架超出快照预算——此时摘要里带 `dsl_omitted: \"budget\"`（**不代表没有产线**），先看节点清单，用 `canvas_apply_ops` 逐节点改、或按画布现状写 DSL 收编（**别另建平行节点**）。带 `workflow_versions` 时，那是各节点的版本史（供 workflow_history / workflow_rollback 把某步退回旧版）。",
  args: {
    node_id: tool.schema.string().optional().describe("只取该节点的完整数据与上下游 id"),
    view: tool.schema.enum(["summary", "full"]).optional().describe("summary（默认）或 full 全量"),
  },
  async execute(args, context) {
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    if (!snap.has_state || snap.state === null) {
      return fail("no_canvas_state", "画布尚未上报状态，请让用户打开画布", {
        hint: "画布尚未上报状态，请让用户打开画布后重试。**拿到状态后：改步骤内容或结构一律 `workflow_write`（读 `dsl`→改 `steps`→整份交回）；退回某步旧内容用 `workflow_history` 查 version → `workflow_rollback`。**",
      })
    }
    return ok({ ...buildCanvasReceipt(snap.state, { view: args.view, nodeId: args.node_id }), updated_at: snap.updated_at })
  },
})
