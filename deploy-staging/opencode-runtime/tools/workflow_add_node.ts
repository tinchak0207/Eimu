import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "Add a node to a workflow. role: node name (character/scene/shot/result...). kind: text/config/image/video. metadata: { prompt, model, size, duration_seconds, count }.\n\n已有素材注入：kind=image|video|audio 且 metadata.content=平台素材URL → 節點直接視為完成，不觸發生成（舊片復用/素材入畫布用此法）。外部素材先 video_upload 入庫。",
  args: {
    workflow_id: tool.schema.string().describe("workflow_id from workflow_start"),
    role: tool.schema.string().describe("node role name"),
    kind: tool.schema.enum(["text", "config", "image", "video", "audio", "film"]).describe(
      "text = prompt/data node (engine skips); config = reference/setting node, NEVER executed — use only for inputs other nodes consume; image = generates an image via the platform (REQUIRED for any node that must output an image); video = generates a video via the platform (REQUIRED for any node that must output a video); audio = TTS 配音节点，生成台词音轨（免费，连到 film 节点自动混入成片）；film = 成片节点，免费本地拼接上游视频并混入上游配音音轨（不触发模型生成）",
    ),
    title: tool.schema.string().optional().describe("node title"),
    metadata: tool.schema.object({}).passthrough().optional().describe("{ prompt, model, size, duration_seconds, count }"),
  },
  async execute(args, context) {
    try {
      const body = { workflow_id: args.workflow_id, role: args.role, kind: args.kind, title: args.title || args.role, metadata: args.metadata || {}, session_id: context.sessionID }
      const res = await fetch(`${GATEWAY}/internal/workflow/node?session_id=${context.sessionID}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok && data?.nodeId) return ok({ node_id: data.nodeId })
      // S3b（2026-08-27）：透传 gateway 错误（message 优先），不再吞成 "HTTP 404"。
      const err = data?.error ?? {}
      const hint = typeof err.message === "string" && err.message ? err.message : `HTTP ${res.status}`
      return fail("workflow_add_node_failed", hint)
    } catch (e) {
      return fail("workflow_unreachable", (e as Error).message)
    }
  },
})
