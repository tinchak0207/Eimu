import { tool } from "@opencode-ai/plugin/tool";
import { ok, fail } from "../lib/client";
import { buildUpdateReceipt } from "../lib/workflow-update-receipt";

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
    "Update workflow node parameters (prompt, model, size, shot_size, camera_move, locked, etc). Marks the node and its downstream as stale.\n\npatch.content=平台素材URL（image/video/audio/film 节点）→ 节点直接标记成功、下游消费此内容，不触发重新生成。",
  args: {
    workflow_id: tool.schema.string().describe("workflow id from workflow_start"),
    node_id: tool.schema.string().describe("node id to update"),
    patch: tool.schema.object({
      prompt: tool.schema.string().optional().describe("new prompt text"),
      model: tool.schema.string().optional().describe("model name"),
      size: tool.schema.string().optional().describe("image size"),
      count: tool.schema.number().optional().describe("image count"),
      duration_seconds: tool.schema.number().min(10).optional().describe("video duration (seconds, >= 10s per §4b maximization rule)"),
      shot_size: tool.schema.string().optional().describe("景别：特写/近景/中景/全景/远景"),
      camera_move: tool.schema.string().optional().describe("运镜：固定/推进/拉远/摇镜/跟拍"),
      locked: tool.schema.boolean().optional().describe("lock node result"),
      description: tool.schema.string().optional().describe("character/scene card description"),
      key_features: tool.schema.string().optional().describe("character/scene key features"),
    }).describe("fields to update (only changed fields)"),
  },
  async execute({ workflow_id, node_id, patch }, context) {
    const res = await fetch(`${GATEWAY}/internal/workflow/node/update?session_id=${context.sessionID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow_id, node_id, patch }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = data?.error ?? {};
      return fail(
        typeof err.code === "string" && err.code ? err.code : "update_failed",
        typeof err.message === "string" && err.message ? err.message : "update failed",
      );
    }
    // 2026-08-30：更新成功后调 status 取回该节点，把真实解析模型（节点自身
    // metadata.model 优先）一起回显。status 拉取失败只置 null，不阻塞。
    let resolvedModel: string | null = null;
    try {
      const stRes = await fetch(
        `${GATEWAY}/internal/workflow/status?session_id=${context.sessionID}&workflow_id=${encodeURIComponent(workflow_id)}`,
        { method: "GET", signal: AbortSignal.timeout(10000) },
      );
      const stData = await stRes.json().catch(() => ({}));
      if (stRes.ok && stData?.ok && stData?.workflow) {
        const target = (stData.workflow.nodes ?? []).find((n: any) => n.id === node_id);
        if (target && typeof target?.metadata?.model === "string" && target.metadata.model) {
          resolvedModel = target.metadata.model;
        } else {
          resolvedModel = resolveModelFromWorkflow(stData.workflow, node_id);
        }
      }
    } catch {
      resolvedModel = null; // 回显辅助，不阻塞
    }
    // H12：精简回执（原回整个 node + 全部 affected id ≈ 930 字噪音）。失败路径上方原样回报。
    return ok(buildUpdateReceipt({ data, nodeId: node_id, patch: patch as Record<string, unknown>, resolvedModel }));
  },
});
