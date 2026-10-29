import { tool } from "@opencode-ai/plugin/tool"
import { fail, ok, platformFetch } from "../lib/client"
import { projectGet, projectNodes } from "../lib/project-client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"
import { buildCanvasReceipt } from "../lib/canvas-state-summary"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "工程模式下读取真实ProjectGraph及同版本DSL；dsl.steps.id就是实际执行节点，baseVersion原样交workflow_write，避免覆盖新修改。非工程画布才采用下述快照说明。\n\n" +
    "读取用户画布的当前快照（节点/连线/选中/视口的压缩摘要）。当你需要知道画布上有什么、决定新节点摆放位置、或要引用/修改/删除某个现有节点（拿它的 id）时，先调用本工具。节点只含 id/type/title/position/width/height/metadata 摘要，超长文本已截断；图片节点的 metadata.content 是其 URL。默认回摘要（节点计数、按类型/状态汇总、逐节点精简行、连线只回数量；失败信息完整保留）；传 node_id 取单个节点完整数据+上下游+版本史；view=full 取全量（节点多时会被截断）。\n\n" +
    "【改工作流看这里】摘要里的 `dsl` **就是**画布产线的权威骨架（WorkflowDslSource[]）——**`dsl` 已自动覆盖存量画布上的产线节点**（不只编译器产物／模板卡／gateway 骨架，也包括没有产线身份键的「提示词节点＋生成配置节点」），每个 step 的 `meta._origin_node_id`（＝原画布节点 id）由读面自动填好：**读到就直接改它，`meta._origin_node_id` 原样带回，不要自己发明**——要增删改工作流步骤，就改这份 `dsl` 的 `steps` 再用 workflow_write 整份交回（不要手拼 add_node/connect_nodes 搭流程）。**改提示词要改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。**铺新产线＝有意动作**：交回会新建节点的 source 时，若 `source.workflow` 不在当前画布 `dsl` 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），工具先回 `confirm_new_line` 要你确认——确认前画布不动。确为有意（用户要铺这条线／你在规划另一张画布）就带 `confirm_new_line: true` 重交同一份 source；若它只是记忆或别的画布的 source 就不要交回。**回执里的新建/更新颗数（`created_node_ids`）必须如实转述，不得声称「无新建」。** `dsl` 为空有两种原因：①画布上确实没有任何产线节点；②画布太大，骨架超出快照预算——此时摘要里带 `dsl_omitted: \"budget\"`（**不代表没有产线**），先看节点清单，用 `canvas_apply_ops` 逐节点改、或按画布现状写 DSL 收编（**别另建平行节点**）。带 `workflow_versions` 时，那是各节点的版本史（供 workflow_history / workflow_rollback 把某步退回旧版）。",
  args: {
    node_id: tool.schema.string().optional().describe("只取该节点的完整数据与上下游 id"),
    view: tool.schema.enum(["summary", "full"]).optional().describe("summary（默认）或 full 全量"),
  },
  async execute(args, context) {
    const current = await projectNodes(context.sessionID)
    if (!current.ok) return fail(current.error?.code ?? "project_read_unknown", current.error?.message ?? "工程状态未知")
    if (current.data?.project_mode === true) {
      const nodes = current.data.nodes
      if (args.node_id) {
        const one = await projectGet(context.sessionID, { view: "node", node: args.node_id, detail: "full" })
        return one.ok ? ok({ ...one.data, target: "project", baseVersion: current.data.version }) : fail(one.error?.code ?? "node_unknown", one.error?.message ?? "节点读取未知")
      }
      let response: Response
      try { response = await platformFetch("/workflow/compile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "project", action: "decompile", current: { nodes } }) }, context.sessionID, context.abort) }
      catch (error) { return fail("project_dsl_read_unknown", (error as Error).message) }
      const read = await response.json().catch(() => null) as Record<string, any> | null
      if (!response.ok || read?.success !== true) return fail("project_dsl_read_unknown", "同工程DSL读取失败，未退回旧画布快照冒充执行事实")
      return ok({ target: "project", project_mode: true, project_version: current.data.version, node_count: nodes.length,
        nodes: args.view === "full" ? nodes : nodes.map((n) => ({ id: n.id, type: n.type, intent: n.intent, rev: n.rev, locked: n.locked, pinned: n.pinned })),
        dsl: read.dsl ? [{ workflow: "project", ...read.dsl, baseVersion: current.data.version }] : [],
        ...(read.dsl_omitted ? { dsl_omitted: read.dsl_omitted, note: "工程存在，DSL因格式或预算未输出；请按node_id读取，不能另建平行工程" } : {}),
        hint: "节点id与runner一致。修改对应steps后连同baseVersion交workflow_write，再用project_run按targets局部执行。" })
    }
    if (current.data?.project_mode !== false) return fail("project_mode_unknown", "网关未返回可信工程模式，未用旧快照替代工程")
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    // F1：无上报＝空画布，不甩「请打开画布」。规划类可直接 workflow_write 落盘；
    // 网关会写穿 canvasStates，用户稍后打开画布 hydrate 可见节点。
    const state = snap.has_state && snap.state !== null ? snap.state : { nodes: [], connections: [] }
    return ok({
      ...buildCanvasReceipt(state, { view: args.view, nodeId: args.node_id }),
      updated_at: snap.updated_at,
      ...(snap.has_state ? {} : { canvas_empty: true, note: "画布尚未上报（视为空画布）。规划／铺产线请直接 `workflow_write` 整份交 DSL——节点会写入可 hydrate 队列／快照。落盘成功后向用户列**节点标题清单**或本轮 document 公网链接；**禁止**在助手正文写「请打开画布／打开画布即可看到／打开画布即可查看／打开即可看到」族话术。" }),
    })
  },
})
