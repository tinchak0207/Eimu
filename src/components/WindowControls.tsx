"use client";

import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEimuShell } from "@/hooks/use-eimu-shell";

/**
 * Eimu 桌面壳的自订视窗控制钮（最小化／最大化·还原／关闭）。
 *
 * 为什么由网页自绘：外壳（Electron 薄壳，loadURL eimu.dev）已移除原生视窗控制，
 * 三颗钮要「看得出来精心设计、完美融入 Eimu」，系统原生的做不到。
 *
 * 只在壳内渲染：外壳以 contextBridge 注入 `window.eimuShell`；普通浏览器（含 PWA）
 * 没有这个物件 ⇒ 一颗都不渲染（出现按了没反应的死钮比没有更糟）。
 * 侦测走 useEimuShell（useEffect 内判定），SSR／首帧一律 null，避免 hydration 不一致。
 *
 * 拖曳：外壳移除原生 overlay 后，拖曳区改由 header 的玻璃岛（nav，app-region-drag）
 * 提供；本元件位于右簇（app-region-no-drag）内，自身再标一次 no-drag 明确化。
 */

// 窄宽（<sm）缩一阶：外壳移除原生视窗钮后，三颗是唯关窗手段，绝不可隐藏；
// 只能缩小让它们在 480px 这种极窄外壳宽度下仍完整落在 nav 内。
const ICON = "h-3.5 w-3.5 max-sm:h-3 max-sm:w-3";

/** 三颗钮共用的极简玻璃态：与 header 既有极简图标钮同一阶（h-9 w-9、icon h-3.5）。 */
const BASE_BUTTON =
  "flex h-9 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.82)] active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 max-sm:h-7 max-sm:w-7";

export interface WindowControlsProps {
  className?: string;
}

export function WindowControls({ className }: WindowControlsProps) {
  const shell = useEimuShell();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!shell) return;
    let alive = true;
    // 初值取自外壳真相；外壳推送同步。Promise 包一层，外壳若回非 Promise 也不炸。
    Promise.resolve(shell.isMaximized())
      .then((value) => {
        if (alive) setMaximized(Boolean(value));
      })
      .catch(() => {
        /* 取不到初值就维持未最大化语义，不挡渲染 */
      });
    const unsubscribe = shell.onMaximizeChange((value) => setMaximized(Boolean(value)));
    return () => {
      alive = false;
      // 卸载务必退订：外壳推送不能打到已卸载元件的 setState。
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [shell]);

  if (!shell) return null;

  return (
    <div
      role="group"
      aria-label="窗口控制"
      className={cn(
        "app-region-no-drag flex h-9 shrink-0 items-center rounded-full border border-[rgba(255,255,255,0.55)] bg-[rgba(255,255,255,0.42)] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(0,0,0,0.06)] backdrop-blur-md max-sm:h-8",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => shell.minimize()}
        aria-label="最小化"
        title="最小化"
        className={cn(BASE_BUTTON, "hover:bg-[rgba(0,0,0,0.06)]")}
      >
        <Minus className={ICON} aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={() => shell.toggleMaximize()}
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        className={cn(BASE_BUTTON, "hover:bg-[rgba(0,0,0,0.06)]")}
      >
        {maximized ? (
          <Copy className={ICON} aria-hidden="true" />
        ) : (
          <Square className={ICON} aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        onClick={() => shell.close()}
        aria-label="关闭"
        title="关闭"
        className={cn(
          BASE_BUTTON,
          "hover:bg-[rgba(255,59,48,0.10)] hover:text-[#D92E2E] focus-visible:ring-[rgba(255,59,48,0.30)]",
        )}
      >
        <X className={ICON} aria-hidden="true" />
      </button>
    </div>
  );
}
