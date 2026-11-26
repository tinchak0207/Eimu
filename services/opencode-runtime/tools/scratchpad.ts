import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const EXAMPLE_ARGS = {
  action: "set",
  key: "shared_style_preset",
  value: {
    color_palette: ["#1A1A2E", "#16213E", "#E94560"],
    lighting: "cinematic volumetric neon",
    camera_lens: "35mm anamorphic",
  },
  category: "style",
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "读写父子代理共享的结构化工作区白板（Run Context / Shared Blackboard / Scratchpad）。",
    "父子代理与兄弟子代理之间共享结构化状态板，用于跨代理共享临时变量、全局预设、任务清单或协作状态，无需靠 prompt 文本拼接传递。",
    "**支持动作（action）**：",
    "  - `set`：写入或更新一个键值（需要 key 与 value，可选 category）；",
    "  - `get`：读取指定 key 的值；",
    "  - `list`：列出当前白板的所有条目（可按 category 过滤）；",
    "  - `delete`：删除指定 key。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    action: tool.schema
      .enum(["get", "set", "list", "delete"])
      .optional()
      .describe("操作动作：set（写入）、get（读取）、list（列出所有）、delete（删除）"),
    key: tool.schema
      .string()
      .optional()
      .describe("状态板键名（set/get/delete 时必填，如「shared_style_preset」「scene_index」）"),
    value: tool.schema
      .any()
      .optional()
      .describe("键值（action=\"set\" 时必填，支持任意 JSON 对象、数组、数字或字符串）"),
    category: tool.schema
      .string()
      .optional()
      .describe("类别分类（可选，如「style」「storyboard」「parameters」，便于分组与 list 过滤）"),
  },
  async execute(args, context) {
    const action = args.action || "list"
    const key = typeof args.key === "string" ? args.key.trim() : ""
    const category = typeof args.category === "string" ? args.category.trim() : undefined

    if (["set", "get", "delete"].includes(action) && !key) {
      return fail(
        "missing_required_args",
        `scratchpad action="${action}" 缺少必填字段：key。示例：${EXAMPLE_JSON}`,
        { missing: ["key"], example: EXAMPLE_ARGS },
      )
    }
    if (action === "set" && args.value === undefined) {
      return fail(
        "missing_required_args",
        `scratchpad action="set" 缺少必填字段：value。示例：${EXAMPLE_JSON}`,
        { missing: ["value"], example: EXAMPLE_ARGS },
      )
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          action,
          key: key || undefined,
          value: args.value,
          category,
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "scratchpad_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: `共享白板操作成功（${action}）`,
        ...data,
      })
    } catch (e) {
      return fail("network_error", `白板通信失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
