"use client";

// 畫布側欄：生成计划 / 指令解读 / 节点 三區，底部一行預算數字。
//
// 桌面（sm+）：左側固定欄，維持原樣。
// 行動端（<768px）：變成底部 sheet —— 圓角頂、可下拉關閉（拖過 120px 或快速下滑）、
//   點 backdrop 關閉；關閉後浮出「计划 N / 面板」按鈕可重新打開。關閉時預設收合，
//   讓畫布是行動端主角，避免一進場就被面板蓋住。

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
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
  [CanvasNodeType.CharacterCard]: "角色卡",
  [CanvasNodeType.SceneCard]: "场景卡",
  [CanvasNodeType.Audio]: "音频",
};

const SECTION_HEADING = "px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-[rgba(0,0,0,0.35)] uppercase";

const MOBILE_MQ = "(max-width: 767px)";

/** 下拉關閉的距離閾值與速度閾值 */
const CLOSE_DISTANCE_PX = 120;
const CLOSE_VELOCITY_PX_MS = 0.6;
const FLING_MIN_PX = 48;

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-sm:text-[12px] rounded-full bg-[rgba(0,0,0,0.05)] px-2 py-0.5 text-[11px] text-[rgba(0,0,0,0.6)]">
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
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_MQ).matches,
  );
  // 行動端預設收合（畫布為主），桌面永遠顯示。
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || !window.matchMedia(MOBILE_MQ).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(MOBILE_MQ);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 下拉關閉手勢
  const dragRef = useRef<{ pointerId: number; startY: number } | null>(null);
  const offsetRef = useRef(0);
  const velocityRef = useRef(0);
  const lastMoveRef = useRef<{ y: number; t: number } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const handleGrabberDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY };
    offsetRef.current = 0;
    velocityRef.current = 0;
    lastMoveRef.current = null;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const handleGrabberMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const y = e.clientY;
    const now = performance.now();
    const prev = lastMoveRef.current;
    velocityRef.current = prev && now > prev.t ? (y - prev.y) / (now - prev.t) : 0;
    lastMoveRef.current = { y, t: now };
    offsetRef.current = Math.max(0, y - d.startY);
    setDragOffset(offsetRef.current);
  };

  const handleGrabberUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const offset = offsetRef.current;
    const velocity = velocityRef.current;
    dragRef.current = null;
    offsetRef.current = 0;
    velocityRef.current = 0;
    lastMoveRef.current = null;
    setDragging(false);
    setDragOffset(0);
    const shouldClose = offset > CLOSE_DISTANCE_PX || (offset > FLING_MIN_PX && velocity > CLOSE_VELOCITY_PX_MS);
    if (shouldClose) setOpen(false);
  };

  const unitIndex = useMemo(() => {
    const map = new Map<string, CanvasUnit>();
    for (const unit of units) {
      for (const n of unit.nodes) map.set(n.id, unit);
    }
    return map;
  }, [units]);

  const unassigned = useMemo(() => nodes.filter((n) => !unitIndex.has(n.id)), [nodes, unitIndex]);

  const panelContent = (
    <>
      <div className="flex-1 space-y-4 p-3">
        {/* ── 生成计划 ── */}
        <section>
          <h3 className={SECTION_HEADING}>生成计划</h3>
          {plans.length === 0 ? (
            <p className="max-sm:text-[13px] rounded-xl bg-[rgba(0,0,0,0.03)] px-3 py-4 text-center text-[12px] text-[rgba(0,0,0,0.45)]">
              还没有生成计划，右侧对话里说一句就行
            </p>
          ) : (
            <div className="space-y-2">
              {plans.map((plan) => (
                <div key={plan.unit_id} className="lg-card rounded-xl p-3">
                  <p className="max-sm:text-[14px] truncate text-[13px] font-semibold text-[rgba(0,0,0,0.85)]">
                    {plan.label}
                  </p>
                  <p className="max-sm:text-[13px] mt-1 line-clamp-2 text-[12px] leading-relaxed text-[rgba(0,0,0,0.6)]">
                    {plan.prompt}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {plan.model ? <Chip>{plan.model}</Chip> : null}
                    {plan.size ? <Chip>{plan.size}</Chip> : null}
                    {typeof plan.count === "number" ? <Chip>{plan.count}</Chip> : null}
                    {plan.kind ? <Chip>{plan.kind}</Chip> : null}
                    {plan.source_image != null ? <Chip>图生图</Chip> : null}
                  </div>
                  {typeof plan.cost_hint === "number" ? (
                    <p className="max-sm:text-[12px] mt-2 text-[11px] tabular-nums text-[rgba(0,0,0,0.45)]">
                      预计 {plan.cost_hint} 币
                    </p>
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
                  <p className="max-sm:text-[14px] text-[13px] font-medium text-[rgba(0,0,0,0.8)]">
                    改图：{d.instruction}
                  </p>
                  {d.interpretation ? (
                    <p className="max-sm:text-[13px] mt-1 text-[12px] leading-relaxed text-[rgba(0,0,0,0.55)]">
                      {d.interpretation}
                    </p>
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
            <p className="max-sm:text-[13px] rounded-xl bg-[rgba(0,0,0,0.03)] px-3 py-4 text-center text-[12px] text-[rgba(0,0,0,0.45)]">
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
        <p className="max-sm:min-h-11 max-sm:text-[13px] flex shrink-0 items-center border-t border-[rgba(0,0,0,0.06)] px-3 py-2.5 text-[12px] tabular-nums text-[rgba(0,0,0,0.5)]">
          已花 {budget.usedCoins} / 剩 {budget.remainingCoins} 币
        </p>
      )}
    </>
  );

  // ── 桌面：原左側欄 ──
  if (!isMobile) {
    return <div className={cn("flex flex-col overflow-y-auto", className)}>{panelContent}</div>;
  }

  // ── 行動端：關閉 → 浮動重開按鈕 ──
  if (!open) {
    return (
      <div className="fixed right-4 bottom-24 z-40">
        <button
          type="button"
          data-canvas-interactive
          onClick={() => setOpen(true)}
          aria-label="打开侧栏"
          className="lg-float flex h-11 touch-manipulation items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-[rgba(0,0,0,0.7)] shadow-lg active:scale-95"
        >
          <ChevronUp className="h-4 w-4" aria-hidden="true" />
          {plans.length > 0 ? `计划 ${plans.length}` : "面板"}
        </button>
      </div>
    );
  }

  // ── 行動端：底部 sheet ──
  return (
    <>
      <button
        type="button"
        aria-label="关闭侧栏"
        tabIndex={-1}
        onClick={() => setOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/25 transition-opacity duration-300 motion-reduce:transition-none",
          dragging && "opacity-70",
        )}
      />
      <div
        data-canvas-interactive
        className="fixed inset-x-0 bottom-0 z-50"
        style={{
          transform: `translateY(${dragOffset}px)`,
          transition: dragging ? "none" : "transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div className="lg-sheet flex max-h-[72svh] flex-col overflow-hidden rounded-t-[1.6rem] pb-[max(env(safe-area-inset-bottom),0.75rem)]">
          <div className="relative shrink-0">
            <div
              onPointerDown={handleGrabberDown}
              onPointerMove={handleGrabberMove}
              onPointerUp={handleGrabberUp}
              onPointerCancel={handleGrabberUp}
              className="flex h-11 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
              role="presentation"
              aria-hidden="true"
            >
              <span className="h-1 w-10 rounded-full bg-[rgba(0,0,0,0.16)]" aria-hidden="true" />
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="收起侧栏"
              className="absolute top-0 right-2 flex h-11 w-11 touch-manipulation items-center justify-center rounded-full text-[rgba(0,0,0,0.45)] active:bg-[rgba(0,0,0,0.06)]"
            >
              <ChevronDown className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{panelContent}</div>
        </div>
      </div>
    </>
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
        // 行動端：≥44px 觸控目標；桌面維持原緊湊高度
        "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors",
        "hover:bg-[rgba(0,0,0,0.04)] active:bg-[rgba(0,0,0,0.06)]",
        "sm:min-h-0 sm:py-1.5",
        selected && "lg-fill-active",
      )}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: STATUS_COLOR[node.metadata?.status ?? "idle"] }}
        aria-hidden="true"
      />
      <span className="min-w-0 max-sm:text-[14px] flex-1 truncate text-[13px] text-[rgba(0,0,0,0.8)]">{node.title}</span>
      <span className="shrink-0 text-[11px] text-[rgba(0,0,0,0.35)]">{NODE_TYPE_LABEL[node.type]}</span>
    </button>
  );
}
