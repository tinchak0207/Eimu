import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "Connect two nodes in a workflow: from node id to node id. from output feeds to as input/reference.",
  args: {
    workflow_id: tool.schema.string().describe("workflow_id"),
    from: tool.schema.string().describe("source node id (from workflow_add_node)"),
    to: tool.schema.string().describe("target node id"),
  },
  async execute(args, context) {
    try {
      const body = { workflow_id: args.workflow_id, from: args.from, to: args.to, session_id: context.sessionID }
      const res = await fetch(`${GATEWAY}/internal/workflow/connect?session_id=${context.sessionID}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) return ok({ connected: true, note: `${args.from} -> ${args.to}` })
      return fail("workflow_connect_failed", data?.error || `HTTP ${res.status}`)
    } catch (e) {
      return fail("workflow_unreachable", (e as Error).message)
    }
  },
})
