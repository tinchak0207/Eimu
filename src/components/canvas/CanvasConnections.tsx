"use client";

import { useMemo } from "react";
import type { CanvasConnection, CanvasNode } from "@/lib/canvas/types";
import { bezierPath, computeWorldBounds } from "@/lib/canvas/layout";

export interface CanvasConnectionsProps {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  /** 高亮的连线（例如选中节点的相邻线） */
  activeNodeId?: string | null;
  onSelectConnection?: (connectionId: string) => void;
}

function CanvasConnections({
  nodes,
  connections,
  activeNodeId,
  onSelectConnection,
}: CanvasConnectionsProps) {
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const bounds = useMemo(() => computeWorldBounds(nodes, 200), [nodes]);

  return (
    <svg
      aria-hidden="true"
      style={{
        position: "absolute",
        left: bounds.minX,
        top: bounds.minY,
        width: bounds.width,
        height: bounds.height,
        overflow: "visible",
        pointerEvents: "none",
      }}
      viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
    >
      <defs>
        {/* SVG marker 无法继承 stroke，普通/高亮两条箭头各配一个 */}
        <marker
          id="canvas-conn-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="rgba(0,0,0,0.22)" />
        </marker>
        <marker
          id="canvas-conn-arrow-active"
          markerWidth="6"
          markerHeight="6"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="rgba(0,122,255,0.85)" />
        </marker>
      </defs>
      {connections.map((c) => {
        const from = nodeMap.get(c.fromNodeId);
        const to = nodeMap.get(c.toNodeId);
        if (!from || !to) return null;
        const active = activeNodeId === c.fromNodeId || activeNodeId === c.toNodeId;
        const d = bezierPath(from, to);
        return (
          <g key={c.id}>
            {/* 透明命中区：16px 宽的描边，负责接收点击 */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={16}
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onClick={() => onSelectConnection?.(c.id)}
            />
            {/* 可见连线 */}
            <path
              d={d}
              fill="none"
              strokeLinecap="round"
              stroke={active ? "rgba(0,122,255,0.85)" : "rgba(0,0,0,0.22)"}
              strokeWidth={active ? 3 : 1.5}
              markerEnd={active ? "url(#canvas-conn-arrow-active)" : "url(#canvas-conn-arrow)"}
            />
          </g>
        );
      })}
    </svg>
  );
}

export { CanvasConnections };
export default CanvasConnections;
