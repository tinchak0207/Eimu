"use client";

// 畫布左側欄：生成计划 / 指令解读 / 节点 三區，底部一行預算數字。

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { CanvasNodeType, type CanvasNode, type CanvasNodeStatus, type CanvasUnit } from "@/lib/canvas/types";
import type { CanvasBudget, CanvasDeriveCard, CanvasPlanCard } from "@/hooks/use-canvas-chat";

export interface CanvasSidePanelProps {
  plans: CanvasPlanCard[];
  derives: CanvasDeriveCard[];
  units: CanvasUnit[];
  nodes: CanvasNode[];
  budget: CanvasBudget | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  /** 點節點列表項時把畫布移到該節點 */
  onFocusNode: (nodeId: string) => void;
  className?: string;
}

const STATUS_COLOR: Record<CanvasNodeStatus, string> = {
  idle: "rgba(0,0,0,0.18)",
  success: "#34C759",
  loading: "#007AFF",
  error: "#FF3B30",
};

const NODE_TYPE_LABEL: Record<CanvasNodeType, string> = {
  [CanvasNodeType.Image]: "图片",
  [CanvasNodeType.Text]: "文本",
  [CanvasNodeType.Config]: "生成配置",
  [CanvasNodeType.Video]: "视频",
  [CanvasNodeType.Group]: "组",
};

const SECTION_HEADING = "px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-[rgba(0,0,0,0.35)] uppercase";

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-[rgba(0,0,0,0.05)] px-2 py-0.5 text-[11px] text-[rgba(0,0,0,0.6)]">
      {children}
    </span>
  );
}

export function CanvasSidePanel({
  plans,
  derives,
  units,
  nodes,
  budget,
  selectedNodeId,
  onSelectNode,
  onFocusNode,
  className,
}: CanvasSidePanelProps) {
  const unitIndex = useMemo(() => {
    const map = new Map<string, CanvasUnit>();
    for (const unit of units) {
      for (const n of unit.nodes) map.set(n.id, unit);
    }
    return map;
  }, [units]);

  const unassigned = useMemo(() => nodes.filter((n) => !unitIndex.has(n.id)), [nodes, unitIndex]);

  return (
    <div className={cn("flex flex-col overflow-y-auto", className)}>
      <div className="flex-1 space-y-4 p-3">
        {/* ── 生成计划 ── */}
        <section>
          <h3 className={SECTION_HEADING}>生成计划</h3>
          {plans.length === 0 ? (
            <p className="rounded-xl bg-[rgba(0,0,0,0.03)] px-3 py-4 text-center text-[12px] text-[rgba(0,0,0,0.45)]">
              还没有生成计划，右侧对话里说一句就行
            </p>
          ) : (
            <div className="space-y-2">
              {plans.map((plan) => (
                <div key={plan.unit_id} className="lg-card rounded-xl p-3">
                  <p className="truncate text-[13px] font-semibold text-[rgba(0,0,0,0.85)]">{plan.label}</p>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[rgba(0,0,0,0.6)]">{plan.prompt}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {plan.model ? <Chip>{plan.model}</Chip> : null}
                    {plan.size ? <Chip>{plan.size}</Chip> : null}
                    {typeof plan.count === "number" ? <Chip>{plan.count}</Chip> : null}
                    {plan.kind ? <Chip>{plan.kind}</Chip> : null}
                    {plan.source_image != null ? <Chip>图生图</Chip> : null}
                  </div>
                  {typeof plan.cost_hint === "number" ? (
                    <p className="mt-2 text-[11px] text-[rgba(0,0,0,0.45)] tabular-nums">预计 {plan.cost_hint} 币</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 指令解读 ── */}
        {derives.length > 0 && (
          <section>
            <h3 className={SECTION_HEADING}>指令解读</h3>
            <div className="space-y-2">
              {derives.map((d) => (
                <div key={d.unitId} className="lg-tint-blue rounded-xl p-3">
                  <p className="text-[13px] font-medium text-[rgba(0,0,0,0.8)]">改图：{d.instruction}</p>
                  {d.interpretation ? (
                    <p className="mt-1 text-[12px] leading-relaxed text-[rgba(0,0,0,0.55)]">{d.interpretation}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── 节点 ── */}
        <section>
          <h3 className={SECTION_HEADING}>节点</h3>
          {nodes.length === 0 ? (
            <p className="rounded-xl bg-[rgba(0,0,0,0.03)] px-3 py-4 text-center text-[12px] text-[rgba(0,0,0,0.45)]">
              画布还是空的
            </p>
          ) : (
            <div className="space-y-3">
              {units.map((unit, idx) => (
                <div key={unit.unitId}>
                  <p className="px-1 pb-1 text-[11px] font-medium text-[rgba(0,0,0,0.35)]">
                    批次 {idx + 1} · {unit.tool}
                  </p>
                  <div className="space-y-1">
                    {unit.nodes.map((n) => (
                      <NodeRow
                        key={n.id}
                        node={n}
                        selected={selectedNodeId === n.id}
                        onActivate={() => {
                          onSelectNode(n.id);
                          onFocusNode(n.id);
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {unassigned.length > 0 && (
                <div>
                  <p className="px-1 pb-1 text-[11px] font-medium text-[rgba(0,0,0,0.35)]">其他</p>
                  <div className="space-y-1">
                    {unassigned.map((n) => (
                      <NodeRow
                        key={n.id}
                        node={n}
                        selected={selectedNodeId === n.id}
                        onActivate={() => {
                          onSelectNode(n.id);
                          onFocusNode(n.id);
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {budget && (
        <p className="shrink-0 border-t border-[rgba(0,0,0,0.06)] px-3 py-2.5 text-[12px] text-[rgba(0,0,0,0.5)] tabular-nums">
          已花 {budget.usedCoins} / 剩 {budget.remainingCoins} 币
        </p>
      )}
    </div>
  );
}

function NodeRow({
  node,
  selected,
  onActivate,
}: {
  node: CanvasNode;
  selected: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[rgba(0,0,0,0.04)]",
        selected && "lg-fill-active",
      )}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: STATUS_COLOR[node.metadata?.status ?? "idle"] }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-[13px] text-[rgba(0,0,0,0.8)]">{node.title}</span>
      <span className="shrink-0 text-[11px] text-[rgba(0,0,0,0.35)]">{NODE_TYPE_LABEL[node.type]}</span>
    </button>
  );
}
