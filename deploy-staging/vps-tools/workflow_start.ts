import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const TEMPLATE_IDS = ["single_image", "character_sheet", "scene_setup", "single_video", "feature_film", "novel_film"] as const
const EXAMPLE_JSON = JSON.stringify({
  template_id: "feature_film",
  content: {
    script: "成片脚本内容",
    character: "角色设定内容",
    scene: "场景设定内容",
    shot1: "镜头 1 脚本",
    shot2: "镜头 2 脚本",
  },
})

export default tool({
  description: [
    "Create a canvas workflow. template_id 必填：" + TEMPLATE_IDS.join(" / ") + "。Backend expands the node graph. Returns workflow_id.",
    "**注意（2026-10-02 收權）**：製作類任務的骨架由網關在判定當下自動建立並執行，Expert 不需也不應自行建骨架；只有明確要手動建圖時才呼叫本工具，且必須帶 template_id 與該模板的必填 text roles（空呼叫會被拒）。",
    "feature_film 多镜头合同（R8）：一次调用把全部镜头塞进 content 的 shot1..shotN 键（每镜 { content: \"镜头脚本\" }），后端自动展开 N 条镜头链（shotN→shotN_gen→shotN_video→final_cut 全连+角色/场景参考连线），禁止再手动 add_node 克隆镜头。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    template_id: tool.schema
      .enum(TEMPLATE_IDS)
      .optional()
      .describe("workflow template id（必填；缺失会被拒并回传可用清单与示例）"),
    content: tool.schema
      .object({})
      .passthrough()
      .optional()
      .describe("content per template role: { role: { content } }. feature_film 必填 text roles：script/character/scene/shot1..shotN（N=镜头数，镜头数由你决定，全部一次传齐）；novel_film 必填：novel/script/character/art_brief/storyboard. 缺任何一个 text role 后端都会 400 拒绝；先向用户问齐剧本/角色/场景/镜头等素材再调用，不要只传 template_id。"),
  },
  async execute(args, context) {
    // D2（2026-10-02）：空呼叫（歷史實測 97 次 `{}`）→ 指名回「必填 template_id」＋可用清單＋示例。
    if (typeof args.template_id !== "string" || !args.template_id) {
      return fail(
        "missing_required_args",
        `workflow_start 缺少必填字段：template_id。可用模板：${TEMPLATE_IDS.join(" / ")}。若這是製作類任務，骨架已由網關自動建立，不需呼叫本工具。示例参数：${EXAMPLE_JSON}`,
        { missing: ["template_id"], available_templates: [...TEMPLATE_IDS], example: JSON.parse(EXAMPLE_JSON) },
      )
    }
    try {
      const body: Record<string, unknown> = { template_id: args.template_id }
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
      return fail(
        typeof data?.code === "string" && data.code ? data.code : "workflow_start_failed",
        data?.error || `HTTP ${res.status}`,
        { http_status: res.status, ...(Array.isArray(data?.missing_roles) ? { missing_roles: data.missing_roles } : {}) },
      )
    } catch (e) {
      return fail("workflow_unreachable", (e as Error).message)
    }
  },
})
