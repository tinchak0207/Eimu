/**
 * canvas_apply_ops VPS 测试支线稿（2026-10-06 机械导出）。
 *
 * 行为真源＝deploy-staging/opencode-runtime/tools/canvas_apply_ops.ts
 * （部署真源：deploy/vps/opencode-release.sh SRC_SUBDIR=deploy-staging/opencode-runtime、
 * SCOPE 含 tools；vps-opencode-recon.sh 亦以 opencode-runtime 为 LOCAL_DIR 对账生产）。
 * 本档＝真源全文逐行复制，唯一 diff＝本注释头。禁止手改本档——改真源后同一步骤覆盖本档。
 * （vps-tools/ 不参与部署，本档仅供本地测试跑道引用与检索，不构成第二份模型面定义。）
 */

import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayDispatchOps } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "**改画布产线（节点在 `dsl` 里）→ 一律 `workflow_write`**（幂等；读 `dsl`→改 `steps`→整份交回）。单步或多步、改 prompt 或改结构，都是它。**`dsl` 已自动覆盖存量画布上的产线节点（含未带产线身份键的提示词节点与生成配置节点），每步的 `meta._origin_node_id` 由读面自动填好——原样带回即可，不要自己发明。**改提示词要改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。节点不在 `dsl` 里，或要动 DSL 表达不到的栏位（位置／尺寸／手调连线）→ 才用 `canvas_apply_ops`（`update_node`／`connect_nodes`／`delete_connections`）。**铺新产线＝有意动作**：交回会新建节点的 source 时，若 `source.workflow` 不在当前画布 `dsl` 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），工具先回 `confirm_new_line` 要你确认——确认前画布不动。确为有意（用户要铺这条线／你在规划另一张画布）就带 `confirm_new_line: true` 重交同一份 source；若它只是记忆或别的画布的 source 就不要交回。**回执里的新建/更新颗数（`created_node_ids`）必须如实转述，不得声称「无新建」。** **禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。**\n\n" +
    "【画布已配模板时】先 canvas_get_state；节点 id 以 tpl- 开头的是用户配上的模板，生成必须落在这些节点上（update_node 写入 metadata.prompt/model/size，再 run_generation 对该节点 id），不要另建生成节点——网关会拦截。 向用户画布下发一批操作并等待前端执行结果（最长 30 秒）。支持的 type：add_node（{node:{id,type,title,position:{x,y},width,height,metadata}}）、update_node（{id,patch}）、delete_nodes（{ids}）、connect_nodes（{connections:[{fromNodeId,toNodeId}]}）、delete_connections（{ids}）、select_nodes（{ids}）、set_viewport（{viewport:{x,y,k}}）、run_generation（{node_id,prompt,model,size,count}）、set_project_meta（{patch:{projectType,currentStep,episodes}}——写作品级字段：作品形态 movie/series、七步流程步号 1-7、剧集清单 [{episodeNo,title,status}]。用于「建作品/建剧集/记录创作进展到第几步」，改的是作品而非画布结构，不需要 node id）、revert_node（{nodeId,version?}——把某节点内容退回旧版，省略 version=上一版；优先直接用 workflow_rollback）。当用户要求整理画布、改节点参数、删节点/连线、聚焦某处等直接操作画布时使用；调用前先用 canvas_get_state 拿现有节点 id 与位置。要搭「生图流程」时优先用 canvas_create_generation_flow / canvas_generate_image，不要手拼 ops。【模板插入配方】画布上已有用户配的模板时（节点 id 以 tpl- 开头）：① 生成必须落在模板已有的生成节点（id 以 -gen 结尾）——用 update_node 写 metadata.prompt/model/size，再 run_generation 对目标节点 id 开跑，结果会回填在模板节点上；② 本工具的 add_node + connect_nodes 仅用于**画布上还不存在、且不属于既有产线声明**的节点（例：参考图／备注）：先想清楚它的前驱与下游，再用**同一批 ops** add_node + connect_nodes 接上（新增节点至少要有一条边连到既有节点；扇入合法，不必删旧边）；**要往既有产线里加一步（含「多加一个角色」这类产线节点）或改产线结构，一律走 `workflow_write` 加 `step`**，不要手拼 ops 搭产线结构；③ 凭空新增、没接线的生成节点会被网关拦（回 code=TEMPLATE_SLOT_OPEN）——收到就把接线补上重试，不要改成绕路；④ 确实要偏离模板，先用 question 工具向用户说明并取得真实同意；同意后网关签发 deviate_token，下次调用带上 deviate_token（自带 deviate_from_template=true 无效）。",
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
    if (outcome.ok !== true && outcome.code !== "OPS_TIMEOUT") {
      return fail("canvas_ops_failed", outcome.error || (outcome.status ? `HTTP ${outcome.status}` : "下发失败"))
    }
    const result = outcome.result ?? {}
    const queued = result.queued === true || outcome.code === "OPS_TIMEOUT"
    if (result.ok !== true && !queued) {
      return fail("ops_rejected", result.error || "前端执行画布操作失败（可能被用户拒绝）", {
        request_id: outcome.request_id,
      })
    }
    return ok({
      request_id: outcome.request_id,
      created_node_ids: result.created_node_ids ?? [],
      ...(queued
        ? {
            queued: true,
            note: "画布页未即时回执，操作已写入可 hydrate 快照队列（queued＝已落盘）。向用户列已写入的节点标题／变更摘要或 document 链接；**禁止**写「请打开画布／打开画布即可看到／打开画布即可查看／打开即可看到」。",
          }
        : {}),
    })
  },
})
