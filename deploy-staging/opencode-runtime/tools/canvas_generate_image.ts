import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { compileGenerationFlow, gatewayDispatchOps, gatewayReadSnapshot } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "【画布已配模板时】先 canvas_get_state；节点 id 以 tpl- 开头的是用户配上的模板，生成必须落在这些节点上（update_node 写入 metadata.prompt/model/size，再 run_generation 对该节点 id），不要另建生成节点——网关会拦截。 在用户画布上搭建生图流程并立即触发生成（等于 canvas_create_generation_flow 的 auto_run=true）。当用户在画布语境下说「生成/画一张 XX」时使用：画布会出现提示词节点 + 配置节点并直接开跑，生成进度与结果落在画布上。扣费确认由前端生成链路处理，本工具不需另行确认。reference_node_ids 传画布上作为参考图的节点 id（先用 canvas_get_state 查）。",
  args: {
    deviate_from_template: tool.schema
      .boolean()
      .optional()
      .describe("画布已配模板且仍有空位时，确需另建节点才传 true（须先用 question 工具取得用户同意）"),
    deviate_reason: tool.schema.string().optional().describe("偏离模板的理由（deviate_from_template=true 时必填）"),
    deviate_token: tool.schema.string().optional().describe("用户在 question 卡上批准偏离后，网关签发的 token；重试时原样带回"),
    prompt: tool.schema.string().describe("生成提示词"),
    model: tool.schema.string().optional().describe("模型名，默认 gpt-image-2"),
    size: tool.schema.string().optional().describe("尺寸，如 1024x1024（默认）"),
    count: tool.schema.number().int().min(1).max(4).optional().describe("张数 1-4，默认 1"),
    reference_node_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("参考图节点 id 列表（会连线到配置节点）"),
  },
  async execute(args, context) {
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    const flow = compileGenerationFlow({ ...args, auto_run: true }, snap.state)
    const label = `生成图片：${flow.model} · ${flow.size} × ${flow.count}`
    const outcome = await gatewayDispatchOps(GATEWAY, context.sessionID, flow.ops, label, {
      deviate_from_template: args.deviate_from_template,
      deviate_reason: args.deviate_reason,
      deviate_token: args.deviate_token,
    })
    if (outcome.code === "OPS_TIMEOUT") {
      return fail(
        "ops_timeout",
        "前端 30 秒内未回执画布操作（画布页可能未打开或已断线）。请让用户打开画布工作台后重试。",
        { request_id: outcome.request_id },
      )
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
      text_node_id: flow.text_node_id,
      config_node_id: flow.config_node_id,
      model: flow.model,
      size: flow.size,
      count: flow.count,
      request_id: outcome.request_id,
      created_node_ids: result.created_node_ids ?? [flow.text_node_id, flow.config_node_id],
      note: "已在画布触发生成，进度与结果会直接落在画布节点上。",
    })
  },
})
