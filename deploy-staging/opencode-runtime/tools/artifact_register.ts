import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const EXAMPLE_ARGS = {
  action: "register",
  name: "scene_01_master_keyframe",
  type: "image",
  uri: "https://store.tinchak0207.xyz/artifacts/scene_01_keyframe.png",
  metadata: {
    resolution: "1280x720",
    seed: 4294967295,
    prompt: "A neon-lit cyberpunk city alley with reflective puddles",
    cost_coins: 1,
  },
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "将具型产物（Typed Artifacts：图片、视频、音频、文档、代码、数据等）注册进主子代理共享的产物契约表（Workspace Registry）。",
    "注册后，主代理与兄弟子代理即可直接通过产物表结构化读取或按类型检索，无需靠 prompt 文本传递长 URL 或文件路径字符串。",
    "**支持动作（action）**：",
    "  - `register`：注册一个新产物（必填 name, type, uri，可选 metadata）；",
    "  - `list`：列出当前会话已注册的所有产物（可按 type 过滤）；",
    "  - `get`：按 artifact_id 或 name 获取具体产物。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    action: tool.schema
      .enum(["register", "list", "get"])
      .optional()
      .describe("操作动作：register（注册）、list（列出所有产物）、get（获取产物）"),
    name: tool.schema
      .string()
      .optional()
      .describe("产物唯一名称或描述标识（register 必填，如「scene_01_keyframe」「bgm_track_mix」）"),
    type: tool.schema
      .enum(["image", "video", "audio", "document", "code", "data", "model"])
      .optional()
      .describe("产物类型（register 必填）：image/video/audio/document/code/data/model"),
    uri: tool.schema
      .string()
      .optional()
      .describe("产物可访问 URI（register 必填：可为完整 HTTP 链接或相对文件系统路径）"),
    metadata: tool.schema
      .record(tool.schema.any())
      .optional()
      .describe("产物结构化元数据（可选：如分辨率、码率、时长、提示词、生成消耗等）"),
    artifact_id: tool.schema
      .string()
      .optional()
      .describe("产物 ID（action=\"get\" 时可选）"),
  },
  async execute(args, context) {
    const action = args.action || "list"
    const name = typeof args.name === "string" ? args.name.trim() : ""
    const type = typeof args.type === "string" ? args.type.trim() : ""
    const uri = typeof args.uri === "string" ? args.uri.trim() : ""

    if (action === "register" && (!name || !type || !uri)) {
      const missing = [!name ? "name" : "", !type ? "type" : "", !uri ? "uri" : ""].filter(Boolean)
      return fail(
        "missing_required_args",
        `artifact_register action="register" 缺少必填字段：${missing.join("、")}。示例：${EXAMPLE_JSON}`,
        { missing, example: EXAMPLE_ARGS },
      )
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/artifact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          action,
          name: name || undefined,
          type: type || undefined,
          uri: uri || undefined,
          metadata: args.metadata,
          artifact_id: args.artifact_id,
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "artifact_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      return ok({
        title: `具型产物操作成功（${action}）`,
        ...data,
      })
    } catch (e) {
      return fail("network_error", `产物注册通信失败：${e instanceof Error ? e.message : String(e)}`)
    }
  },
})
