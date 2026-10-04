import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { gatewayReadSnapshot } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// workflow_history — 人机共笔的「版本面」：读当前产线的可逆声明（dsl）与各节点版本史。
// 版本史住在画布端（append-only，单节点 20 版 / 单专案 400 版；挪位置/调尺寸不占版本），
// agent 读索引后指名 version 交 workflow_rollback，不必把旧 metadata 抄进上下文。
export default tool({
  description:
    "读取工作流当前的可逆声明（dsl）与节点版本史。用在：要回滚某一步的内容（先看该节点有哪些 version）、或要在改前确认当前声明基线。\n\n" +
    "返回 workflow_versions：[{ node_id, title, versions: [{ version, created_at, reason, title }] }]；reason ∈ created/generated/edited/metadata/revert。\n" +
    "带 node_id 只回该节点；include_dsl=false 可省掉（声明很大时）。版本只含内容史（title+metadata），不含坐标——回退不会动节点的位置/尺寸。",
  args: {
    node_id: tool.schema.string().optional().describe("只回该节点的版本史（拿 version 号去 workflow_rollback）"),
    include_dsl: tool.schema.boolean().optional().describe("是否回当前 dsl（默认 true）"),
  },
  async execute(args, context) {
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    if (!snap.has_state || snap.state === null) {
      return fail("no_canvas_state", "画布尚未上报状态，请让用户打开画布", {
        hint: "画布尚未上报状态，请让用户打开画布后重试。**拿到状态后：改步骤内容或结构一律 `workflow_write`（读 `dsl`→改 `steps`→整份交回）；退回某步旧内容用 `workflow_history` 查 version → `workflow_rollback`。**",
      })
    }
    const s = (snap.state ?? {}) as Record<string, unknown>
    let versions = Array.isArray(s.node_versions) ? (s.node_versions as any[]) : []
    const dsl = Array.isArray(s.dsl) ? s.dsl : []
    if (args.node_id) versions = versions.filter((e) => e?.node_id === args.node_id)
    if (versions.length === 0 && !args.node_id && dsl.length === 0) {
      return ok({ note: "画布上还没有可编译的工作流，也没有节点版本史", workflow_versions: [], dsl: [] })
    }
    return ok({
      ...(args.include_dsl === false ? {} : { dsl }),
      workflow_versions: versions,
    })
  },
})
