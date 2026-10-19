"use client";

import { memo, useMemo } from "react";
import { useStableHandlers } from "./embed/stable-handlers";
import type { CanvasConnection, CanvasNode } from "@/lib/canvas/types";
import { bezierPath, computeWorldBounds } from "@/lib/canvas/layout";

export interface CanvasConnectionsProps {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  /** 高亮的连线（例如选中节点的相邻线） */
  activeNodeId?: string | null;
  onSelectConnection?: (connectionId: string) => void;
  /** A5：选中的连线（点击选中 → Delete 可删）。 */
  selectedConnectionId?: string | null;
  /** A5：连线右键（clientX/Y 为 viewport 座标，宿主自行换算）。 */
  onConnectionContextMenu?: (connectionId: string, clientX: number, clientY: number) => void;
  /** 连线拖拽中的预览路径（世界座标 SVG path d）；null = 没在拖。 */
  pendingPath?: string | null;
  /** 语义缩放：聚合中不可点（连线淡出时不拦截手势）。缺省 true。 */
  interactive?: boolean;
}

function CanvasConnectionsView({
  nodes,
  connections,
  activeNodeId,
  onSelectConnection,
  selectedConnectionId = null,
  onConnectionContextMenu,
  pendingPath = null,
  interactive = true,
}: CanvasConnectionsProps) {
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const bounds = useMemo(() => computeWorldBounds(nodes, 200), [nodes]);

  return (
    <svg
      aria-hidden="true"
      className="lod-conn"
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
            {/* 透明命中区：负责接收点击。萤幕上恒约 24px 宽（缩放时用
                --canvas-inverse-scale 反向补偿，手指在任意缩放级别都点得到），
                触控点击用 manipulation 避免任何点击延迟。 */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              style={{
                pointerEvents: interactive ? "stroke" : "none",
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
            {/* 可见连线（选中 = 更粗更蓝，Delete 可删） */}
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
      {/* 连线拖拽预览：蓝色虚线，不吃指标事件 */}
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

const MemoCanvasConnections = memo(CanvasConnectionsView);

/** memo＋稳定 on* 代理：平移/缩放每帧不重算所有连线路径。 */
function CanvasConnections(props: CanvasConnectionsProps) {
  return <MemoCanvasConnections {...useStableHandlers(props)} />;
}

export { CanvasConnections };
export default CanvasConnections;
