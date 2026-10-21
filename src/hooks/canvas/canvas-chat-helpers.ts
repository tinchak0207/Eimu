import { CanvasNodeType } from "@/lib/canvas/types";
import type { CanvasConnection, CanvasNode } from "@/lib/canvas/types";

/** WS4：节点交付→自动落卡的 debounce（串流期间节点内容高频变动，等安静再落卡）。 */
export const EMITTED_ANCHOR_DEBOUNCE_MS = 500;

export type {
  CanvasBackgroundMode,
  CanvasBudget,
  CanvasDeriveCard,
  CanvasPlanCard,
  CanvasProjectSummary,
  ChatCanvasEntry,
  UseCanvasChatProjectContext,
  UseCanvasChatReturn,
} from "./canvas-chat-types";

/**
 * 下游闭包（回跳作废用，纯函式，可直接单测）：沿连线 BFS 取 root 全部下游，
 * 滤掉 text/prompt/config（纯资料节点没有生成结果，无所谓作废——与网关
 * `workflow-service.updateNode` 的 BFS 规则逐条对齐：它同样只重置非 text/config）。
 * root 自身不在回传内（回跳改的是上游，被改的那步由用户自己重跑）。
 */
export function downstreamInvalidationIds(
  nodes: Pick<CanvasNode, "id" | "type">[],
  connections: Pick<CanvasConnection, "fromNodeId" | "toNodeId">[],
  rootId: string,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(rootId)) return [];
  const voidsDataOnly = (id: string): boolean => {
    const type = byId.get(id)?.type;
    return type === CanvasNodeType.Text || type === CanvasNodeType.Prompt || type === CanvasNodeType.Config;
  };
  const visited = new Set<string>([rootId]);
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const c of connections) {
      if (c.fromNodeId !== current || visited.has(c.toNodeId)) continue;
      visited.add(c.toNodeId);
      queue.push(c.toNodeId);
      if (byId.has(c.toNodeId) && !voidsDataOnly(c.toNodeId)) out.push(c.toNodeId);
    }
  }
  return out;
}
