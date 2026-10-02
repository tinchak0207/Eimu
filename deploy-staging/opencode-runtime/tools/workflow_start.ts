import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "Create a canvas workflow. template_id optional: single_image / character_sheet / scene_setup / single_video / feature_film / novel_film. Backend expands the node graph. Returns workflow_id. feature_film 多镜头合同（R8）：一次调用把全部镜头塞进 content 的 shot1..shotN 键（每镜 { content: \"镜头脚本\" }），后端自动展开 N 条镜头链（shotN→shotN_gen→shotN_video→final_cut 全连+角色/场景参考连线），禁止再手动 add_node 克隆镜头。",
  args: {
    template_id: tool.schema
      .enum(["single_image", "character_sheet", "scene_setup", "single_video", "feature_film", "novel_film"])
      .optional()
      .describe("workflow template id; omit for empty workflow"),
    content: tool.schema
      .object({})
      .passthrough()
      .optional()
      .describe("content per template role: { role: { content } }. feature_film 必填 text roles：script/character/scene/shot1..shotN（N=镜头数，镜头数由你决定，全部一次传齐）；novel_film 必填：novel/script/character/art_brief/storyboard. 缺任何一个 text role 后端都会 400 拒绝；先向用户问齐剧本/角色/场景/镜头等素材再调用，不要只传 template_id。"),
  },
  async execute(args, context) {
    try {
      const body: Record<string, unknown> = {}
      if (args.template_id) body.template_id = args.template_id
      if (args.content) body.content = args.content
      body.session_id = context.sessionID
      const res = await fetch(`${GATEWAY}/internal/workflow/start?session_id=${context.sessionID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok && data?.workflowId) {
        return ok({ workflow_id: data.workflowId, note: "workflow created" })
      }
      return fail("workflow_start_failed", data?.error || `HTTP ${res.status}`)
    } catch (e) {
      return fail("workflow_unreachable", (e as Error).message)
    }
  },
})
