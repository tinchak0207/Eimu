import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { buildStatusReceipt } from "../lib/workflow-status-summary"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "Check a workflow run status. Default view=summary: per-node id/role/kind/status/cost + short content (errors keep full text), status_counts, delivery/billing; fits in one receipt. Pass node_id for one node's full detail (metadata, full content, upstream/downstream). view=full returns the raw 150KB+ graph and WILL be truncated — avoid unless needed.",
  args: {
    workflow_id: tool.schema.string().describe("workflow_id"),
    node_id: tool.schema.string().optional().describe("optional: return full detail of this single node"),
    view: tool.schema.enum(["summary", "full"]).optional().describe("summary (default) or full (raw, large)"),
  },
  async execute(args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/workflow/status?session_id=${context.sessionID}&workflow_id=${encodeURIComponent(args.workflow_id)}`, { method: "GET", signal: AbortSignal.timeout(10000) })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok && data?.workflow) {
        return ok(buildStatusReceipt(data.workflow, { view: args.view, nodeId: args.node_id, billing: data.billing }))
      }
      return fail("workflow_status_failed", data?.error || `HTTP ${res.status}`)
    } catch (e) {
      return fail("workflow_unreachable", (e as Error).message)
    }
  },
})
