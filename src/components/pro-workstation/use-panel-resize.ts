"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  type InspectorTab,
  type LayoutPrefs,
  type LeftPanelTab,
  type NoticeLevel,
  useEventCallback,
  writeLayoutPrefs,
} from "./workstation-constants";

export interface PanelResizeApi {
  panelWidths: { left: number; right: number };
  resizingSide: "left" | "right" | null;
  startPanelResize: (side: "left" | "right", event: React.PointerEvent<HTMLButtonElement>) => void;
  handlePanelResize: (event: React.PointerEvent<HTMLButtonElement>) => void;
  endPanelResize: () => void;
  nudgePanel: (side: "left" | "right", delta: number) => void;
  resetPanel: (side: "left" | "right") => void;
  handleResizeKeyDown: (side: "left" | "right", event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * 面板缩放引擎（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 *
 * 拥有：分栏宽度 state、拖拽中的 side state、拖拽几何 ref、佈局偏好落盘 effect、
 * 六个 resize 函数。leftTab / inspectorTab / sectionOpen 的「读初值」留在入口
 * （它们在那边还有自己的 useState），这里只负责把它们随宽度一起写回 localStorage。
 */
export function usePanelResize(options: {
  initialLayout: LayoutPrefs;
  leftPanelTab: LeftPanelTab;
  inspectorTab: InspectorTab;
  sectionOpen: Record<string, boolean>;
  inspectorExpanded: boolean;
  setInspectorExpanded: (open: boolean | ((current: boolean) => boolean)) => void;
  setCanvasNotice: (text: string, level?: NoticeLevel) => void;
  studioBodyRef: RefObject<HTMLDivElement | null>;
}): PanelResizeApi {
  const {
    initialLayout,
    leftPanelTab,
    inspectorTab,
    sectionOpen,
    inspectorExpanded,
    setInspectorExpanded,
    setCanvasNotice,
    studioBodyRef,
  } = options;

  const [panelWidths, setPanelWidths] = useState({
    left: initialLayout.left ?? 440,
    right: initialLayout.right ?? 320,
  });
  const [resizingSide, setResizingSide] = useState<"left" | "right" | null>(null);
  const panelResizeRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number; container: number } | null>(null);

  /** 布局偏好落盘：分栏宽度、当前 tab、手风琴开合。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeLayoutPrefs({
        left: panelWidths.left,
        right: panelWidths.right,
        leftTab: leftPanelTab,
        inspectorTab,
        sections: sectionOpen,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [panelWidths, leftPanelTab, inspectorTab, sectionOpen]);

  const startPanelResize = (side: "left" | "right", event: React.PointerEvent<HTMLButtonElement>) => {
    // 收起态右栏宽度被 CSS 钉在 72px，先展开再让拖动接管，否则拖了没反应。
    if (side === "right" && !inspectorExpanded) setInspectorExpanded(true);
    const container = studioBodyRef.current?.clientWidth ?? 1200;
    panelResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? panelWidths.left : panelWidths.right,
      container,
    };
    setResizingSide(side);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePanelResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = panelResizeRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    if (drag.side === "left") {
      // 右栏至少 220、中栏至少 320，其余空间让给左栏。
      const max = drag.container - 220 - 320;
      const next = Math.min(Math.max(drag.startWidth + delta, 200), Math.max(max, 200));
      setPanelWidths((current) => (current.left === next ? current : { ...current, left: next }));
    } else {
      const max = drag.container - 200 - 320;
      const next = Math.min(Math.max(drag.startWidth - delta, 220), Math.max(max, 220));
      setPanelWidths((current) => (current.right === next ? current : { ...current, right: next }));
    }
  };

  const endPanelResize = () => {
    panelResizeRef.current = null;
    setResizingSide(null);
  };

  /**
   * 键盘调栏 + 双击复位。
   *
   * 分隔条原本只认 pointer 事件：不用鼠标的人完全没法调栏宽，而拖坏了比例
   * 也只能一点点拖回去。方向键每次 24px、Shift 加速到 96px，Home/双击回默认值。
   */
  const nudgePanel = useEventCallback((side: "left" | "right", delta: number) => {
    const container = studioBodyRef.current?.clientWidth ?? 1200;
    setPanelWidths((current) => {
      if (side === "left") {
        const max = Math.max(container - 220 - 320, 200);
        const next = Math.min(Math.max(current.left + delta, 200), max);
        return current.left === next ? current : { ...current, left: next };
      }
      const max = Math.max(container - 200 - 320, 220);
      const next = Math.min(Math.max(current.right + delta, 220), max);
      return current.right === next ? current : { ...current, right: next };
    });
  });

  const resetPanel = useEventCallback((side: "left" | "right") => {
    setPanelWidths((current) =>
      side === "left" ? { ...current, left: 440 } : { ...current, right: 320 },
    );
    setCanvasNotice(side === "left" ? "左栏宽度已复位。" : "右栏宽度已复位。");
  });

  const handleResizeKeyDown = useEventCallback(
    (side: "left" | "right", event: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 96 : 24;
      // 左栏向右拖是变宽，右栏向右拖是变窄，所以右栏的方向要反过来。
      const sign = side === "left" ? 1 : -1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        nudgePanel(side, -step * sign);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        nudgePanel(side, step * sign);
      } else if (event.key === "Home" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        resetPanel(side);
      }
    },
  );

  return {
    panelWidths,
    resizingSide,
    startPanelResize,
    handlePanelResize,
    endPanelResize,
    nudgePanel,
    resetPanel,
    handleResizeKeyDown,
  };
}
