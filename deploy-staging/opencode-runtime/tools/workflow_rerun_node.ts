import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081";

// 2026-08-30：工具回显真实解析模型（AI 自欺源根治）。与 gateway resolveNodeModel
// 同语义：节点自身 metadata.model → 上游 config 节点（多 config 取 nodes 里 index
// 最大者 = 最新接的 cfg）→ 递归兜底 → pixai-tsubaki2 默认。返回 null 表示 status
// 不可用（回显辅助，不阻塞工具主流程）。
function resolveModelFromWorkflow(workflow: any, nodeId: string): string | null {
  const nodes = workflow?.nodes ?? [];
  const connections = workflow?.connections ?? [];
  const self = nodes.find((n: any) => n.id === nodeId);
  if (self && typeof self?.metadata?.model === "string" && self.metadata.model) return self.metadata.model;
  const upstreamIds = connections.filter((c: any) => c.to === nodeId).map((c: any) => c.from);
  let best: { model: string; idx: number } | null = null;
  for (const uid of upstreamIds) {
    const idx = nodes.findIndex((n: any) => n.id === uid);
    if (idx >= 0) {
      const un = nodes[idx];
      if (un?.kind === "config" && typeof un?.metadata?.model === "string" && un.metadata.model) {
        if (!best || idx > best.idx) best = { model: un.metadata.model, idx };
      }
    }
  }
  if (best) return best.model;
  // 递归兜底：上游节点自身带 model 也算（与 gateway resolveNodeModel 同语义）
  for (const uid of upstreamIds) {
    const un = nodes.find((n: any) => n.id === uid);
    if (un) {
      const m = resolveModelFromWorkflow(workflow, uid);
      if (m && m !== "pixai-tsubaki2") return m;
    }
  }
  return "pixai-tsubaki2";
}

export default tool({
  description:
    "Rerun a workflow node and all its downstream nodes. Use when user wants to regenerate a specific node or after updating node parameters.",
  args: {
    workflow_id: tool.schema.string().describe("workflow id from workflow_start"),
    node_id: tool.schema.string().describe("node id to rerun"),
  },
  // S3（2026-08-27）：opencode 工具上下文的會話鍵是 context.sessionID（全 VPS
  // 其他工具一致）；舊代碼解構 { session_id } 得 undefined，導致 gateway
  // resolveSession("undefined") 永遠 404 "session not found"。
  async execute({ workflow_id, node_id }, context) {
    // 2026-08-30：rerun 前先取 status，从 workflow.nodes 的真实 metadata 算出
    // resolvedModel 回显——AI 无法自欺。status 拉取失败只置 null，不阻塞 rerun。
    let resolvedModel: string | null = null;
    try {
      const stRes = await fetch(
        `${GATEWAY}/internal/workflow/status?session_id=${context.sessionID}&workflow_id=${encodeURIComponent(workflow_id)}`,
        { method: "GET", signal: AbortSignal.timeout(10000) },
      );
      const stData = await stRes.json().catch(() => ({}));
      if (stRes.ok && stData?.ok && stData?.workflow) {
        resolvedModel = resolveModelFromWorkflow(stData.workflow, node_id);
      }
    } catch {
      resolvedModel = null; // 回显辅助，不阻塞
    }
    const res = await fetch(`${GATEWAY}/internal/workflow/node/rerun?session_id=${context.sessionID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id, node_id }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = data?.error ?? {};
      return fail(
        typeof err.code === "string" && err.code ? err.code : "rerun_failed",
        typeof err.message === "string" && err.message ? err.message : "rerun failed",
        resolvedModel !== null ? { resolved_model: resolvedModel } : undefined,
      );
    }
    return ok({ execution_id: data.execution_id, root_node_id: data.root_node_id, status: data.status, resolved_model: resolvedModel });
  },
});
