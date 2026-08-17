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
  /** A5：選中的連線（點擊選中 → Delete 可刪）。 */
  selectedConnectionId?: string | null;
  /** A5：連線右鍵（clientX/Y 為 viewport 座標，宿主自行換算）。 */
  onConnectionContextMenu?: (connectionId: string, clientX: number, clientY: number) => void;
  /** 連線拖拽中的預覽路徑（世界座標 SVG path d）；null = 沒在拖。 */
  pendingPath?: string | null;
}

function CanvasConnections({
  nodes,
  connections,
  activeNodeId,
  onSelectConnection,
  selectedConnectionId = null,
  onConnectionContextMenu,
  pendingPath = null,
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
        const isSelected = selectedConnectionId === c.id;
        const active = isSelected || activeNodeId === c.fromNodeId || activeNodeId === c.toNodeId;
        const d = bezierPath(from, to);
        return (
          <g key={c.id}>
            {/* 透明命中区：负责接收点击。螢幕上恆約 24px 寬（縮放時用
                --canvas-inverse-scale 反向補償，手指在任意縮放級別都點得到），
                觸控點擊用 manipulation 避免任何點擊延遲。 */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              style={{
                pointerEvents: "stroke",
                cursor: "pointer",
                strokeWidth: "calc(24px * var(--canvas-inverse-scale, 1))",
                touchAction: "manipulation",
              }}
              onClick={() => onSelectConnection?.(c.id)}
              onContextMenu={(e) => {
                if (!onConnectionContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                onConnectionContextMenu(c.id, e.clientX, e.clientY);
              }}
            />
            {/* 可见连线（選中 = 更粗更藍，Delete 可刪） */}
            <path
              d={d}
              fill="none"
              strokeLinecap="round"
              stroke={isSelected ? "rgba(0,122,255,1)" : active ? "rgba(0,122,255,0.85)" : "rgba(0,0,0,0.14)"}
              strokeWidth={isSelected ? 3 : active ? 2.5 : 1.2}
              markerEnd={active ? "url(#canvas-conn-arrow-active)" : "url(#canvas-conn-arrow)"}
            />
          </g>
        );
      })}
      {/* 連線拖拽預覽：藍色虛線，不吃指標事件 */}
      {pendingPath && (
        <path
          d={pendingPath}
          fill="none"
          strokeLinecap="round"
          stroke="rgba(0,122,255,0.75)"
          strokeWidth={2}
          strokeDasharray="6 5"
        />
      )}
    </svg>
  );
}

export { CanvasConnections };
export default CanvasConnections;
