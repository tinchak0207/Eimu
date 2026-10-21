import type { CanvasReducerState } from "../reducer";
import type { CanvasNodeStatus } from "../types";

// ─────────────────────────────────────────── canvas_state 摘要（上送 gateway）

export interface CanvasStateSummaryNode {
  id: string;
  type: string;
  title: string;
  status?: CanvasNodeStatus;
  model?: string;
  size?: string;
  cost_coins?: number;
}

export interface CanvasStateSummary {
  nodes: CanvasStateSummaryNode[];
  connections: { id: string; fromNodeId: string; toNodeId: string }[];
  units: { unit_id: string; tool: string; node_count: number }[];
}

/** 摘要上限：画布可以有 500 个节点，但没必要把 500 个都塞进每一次 send。 */
export const CANVAS_SUMMARY_MAX_NODES = 60;

/**
 * 连线上限。连线数不受节点上限约束——实测 53 个节点挂了 676 条线，光 connections
 * 就 123KB、整份摘要 128.8KB。而 send 的 canvas_state 在中继层超过 128KB 会被挡成
 * 400「画布摘要过大」，挡掉的是**整则讯息**：使用者每发必败，会话就此发不出话。
 * 与节点同理，只留最后 N 条。
 */
export const CANVAS_SUMMARY_MAX_CONNECTIONS = 120;

/**
 * 纯 metadata 摘要，**永不含图片 base64／dataURL**。
 * content 一律不带：图节点的 content 是 URL、文本节点的 content 是整段 prompt，
 * 两者都可能很长，而 gateway 要的只是「画布上有什么」。
 */
export function summarizeCanvasState(state: CanvasReducerState): CanvasStateSummary {
  const nodes = state.nodes.slice(-CANVAS_SUMMARY_MAX_NODES).map((n) => ({
    id: n.id,
    type: String(n.type),
    title: n.title,
    ...(n.metadata?.status ? { status: n.metadata.status } : {}),
    ...(n.metadata?.model ? { model: n.metadata.model } : {}),
    ...(n.metadata?.size ? { size: n.metadata.size } : {}),
    ...(typeof n.metadata?.cost_coins === "number" ? { cost_coins: n.metadata.cost_coins } : {}),
  }));
  const kept = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    connections: state.connections
      .filter((c) => kept.has(c.fromNodeId) && kept.has(c.toNodeId))
      .slice(-CANVAS_SUMMARY_MAX_CONNECTIONS)
      .map((c) => ({ id: c.id, fromNodeId: c.fromNodeId, toNodeId: c.toNodeId })),
    units: state.units.map((u) => ({ unit_id: u.unitId, tool: u.tool, node_count: u.nodes.length })),
  };
}
