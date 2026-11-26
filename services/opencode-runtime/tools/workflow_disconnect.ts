import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "断开两节点之间的连线",
  args: {
    workflow_id: tool.schema.string().describe("workflow_id"),
    from: tool.schema.string().describe("source node id (from workflow_add_node)"),
    to: tool.schema.string().describe("target node id"),
  },
  async execute(args, context) {
    try {
      const body = { workflow_id: args.workflow_id, from: args.from, to: args.to, session_id: context.sessionID }
      const res = await fetch(`${GATEWAY}/internal/workflow/disconnect?session_id=${context.sessionID}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) return ok({ disconnected: true, note: `${args.from} -> ${args.to}` })
      return fail("workflow_disconnect_failed", data?.error || `HTTP ${res.status}`)
    } catch (e) {
      return fail("workflow_unreachable", (e as Error).message)
    }
  },
})
