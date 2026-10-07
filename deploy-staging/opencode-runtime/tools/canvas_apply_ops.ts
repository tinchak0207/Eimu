import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayDispatchOps } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "**适用边界**：改画布产线的步骤内容或结构一律用 `workflow_write`（幂等，读 `dsl`→改 `steps`→整份交回）；本工具只处理节点不在 `dsl` 里、或 DSL 表达不到的栏位（位置／尺寸／手调连线）。\n\n" +
    "文字节点正文必须用 update_node {id,patch:{metadata:{content:\"完整正文\"}}}；patch.content/prompt/status 不会被 reducer 消费，网关会拒绝。节点增改、节点删除和连线变更只有同会话快照真实匹配才返回成功；前端回执、已派发、节点数量都不能冒充内容已写。无客户端或断线导致未生效时如实报告，先交付完整可下载文档，不反复要求用户重发任务。\n\n" +
    "**改画布产线（节点在 `dsl` 里）→ 一律 `workflow_write`**（幂等；读 `dsl`→改 `steps`→整份交回）。单步或多步、改 prompt 或改结构，都是它。**节点不在 `dsl` 里，或 DSL 表达不到的栏位（位置／尺寸／手调连线）→ 才用 `canvas_apply_ops`**（`update_node`／`connect_nodes`／`delete_connections`）。**禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。\n\n" +
    "【画布已配模板时】先 canvas_get_state；节点 id 以 tpl- 开头的是用户配上的模板，生成必须落在这些节点上（update_node 写入 metadata.prompt/model/size，再 run_generation 对该节点 id），不要另建生成节点——网关会拦截。 向用户画布下发一批操作并等待前端执行结果（最长 30 秒）。支持的 type：add_node（{node:{id,type,title,position:{x,y},width,height,metadata}}）、update_node（{id,patch}）、delete_nodes（{ids}）、connect_nodes（{connections:[{fromNodeId,toNodeId}]}）、delete_connections（{ids}）、select_nodes（{ids}）、set_viewport（{viewport:{x,y,k}}）、run_generation（{node_id,prompt,model,size,count}）、set_project_meta（{patch:{projectType,currentStep,episodes}}——写作品级字段：作品形态 movie/series、七步流程步号 1-7、剧集清单 [{episodeNo,title,status}]。用于「建作品/建剧集/记录创作进展到第几步」，改的是作品而非画布结构，不需要 node id）、revert_node（{nodeId,version?}——把某节点内容退回旧版，省略 version=上一版；优先直接用 workflow_rollback）。当用户要求整理画布、改节点参数、删节点/连线、聚焦某处等直接操作画布时使用；调用前先用 canvas_get_state 拿现有节点 id 与位置。要搭「生图流程」时优先用 canvas_create_generation_flow / canvas_generate_image，不要手拼 ops。【模板插入配方】画布上已有用户配的模板时（节点 id 以 tpl- 开头）：① 生成必须落在模板已有的生成节点（id 以 -gen 结尾）——用 update_node 写 metadata.prompt/model/size，再 run_generation 对目标节点 id 开跑，结果会回填在模板节点上；② 用户要「多加一步／多加一个角色」时，先想清楚它的前驱与下游，然后在**同一批 ops** 内 add_node + connect_nodes 把它接上（新增节点至少要有一条边连到既有节点；扇入合法，不必删旧边）；③ 凭空新增、没接线的生成节点会被网关拦（回 code=TEMPLATE_SLOT_OPEN）——收到就把接线补上重试，不要改成绕路；④ 确实要偏离模板，先用 question 工具向用户说明并取得真实同意；同意后网关签发 deviate_token，下次调用带上 deviate_token（自带 deviate_from_template=true 无效）。",
  args: {
    deviate_from_template: tool.schema
      .boolean()
      .optional()
      .describe("已由网关 token 取代：单独传 true 不放行，必须同时带 deviate_token"),
    deviate_reason: tool.schema.string().optional().describe("偏离模板的理由"),
    deviate_token: tool.schema.string().optional().describe("用户在 question 卡上批准偏离后，网关签发的 token；重试时原样带回"),
    ops: tool.schema
      .array(tool.schema.object({ type: tool.schema.string().describe("操作类型") }).passthrough())
      .min(1)
      .describe("按顺序执行的画布操作数组（形状见工具描述）"),
    label: tool.schema.string().optional().describe("给用户看的一句话操作意图，如「整理布局」"),
  },
  async execute(args, context) {
    const outcome = await gatewayDispatchOps(GATEWAY, context.sessionID, args.ops, args.label, args)
    if (outcome.code === "OPS_TIMEOUT") {
      return fail(
        "ops_timeout",
        "画布操作未在30秒内收到执行回执，未证实生效（画布页可能未打开或已断线）。先交付完整可下载文档，不得宣称正文已写入。",
        { request_id: outcome.request_id },
      )
    }
    if (outcome.code === "OPS_NOT_APPLIED") {
      return fail("ops_not_applied", outcome.error || "画布回执已到，但同会话快照未包含请求写入的字段；未证实生效。", { request_id: outcome.request_id })
    }
    if (outcome.ok !== true) {
      return fail("canvas_ops_failed", outcome.error || (outcome.status ? `HTTP ${outcome.status}` : "下发失败"))
    }
    const result = outcome.result ?? {}
    if (result.ok !== true) {
      return fail("ops_rejected", result.error || "前端执行画布操作失败（可能被用户拒绝）", {
        request_id: outcome.request_id,
      })
    }
    return ok({
      request_id: outcome.request_id,
      created_node_ids: result.created_node_ids ?? [],
    })
  },
})
