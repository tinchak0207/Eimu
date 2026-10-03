"use client";

import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEimuShell } from "@/hooks/use-eimu-shell";

/**
 * Eimu 桌面殼的自訂視窗控制鈕（最小化／最大化·還原／關閉）。
 *
 * 為什麼由網頁自繪：外殼（Electron 薄殼，loadURL eimu.dev）已移除原生視窗控制，
 * 三顆鈕要「看得出來精心設計、完美融入 Eimu」，系統原生的做不到。
 *
 * 只在殼內渲染：外殼以 contextBridge 注入 `window.eimuShell`；普通瀏覽器（含 PWA）
 * 沒有這個物件 ⇒ 一顆都不渲染（出現按了沒反應的死鈕比沒有更糟）。
 * 偵測走 useEimuShell（useEffect 內判定），SSR／首幀一律 null，避免 hydration 不一致。
 *
 * 拖曳：外殼移除原生 overlay 後，拖曳區改由 header 的玻璃島（nav，app-region-drag）
 * 提供；本元件位於右簇（app-region-no-drag）內，自身再標一次 no-drag 明確化。
 */

// 窄寬（<sm）縮一階：外殼移除原生視窗鈕後，三顆是唯關窗手段，絕不可隱藏；
// 只能縮小讓它們在 480px 這種極窄外殼寬度下仍完整落在 nav 內。
const ICON = "h-3.5 w-3.5 max-sm:h-3 max-sm:w-3";

/** 三顆鈕共用的極簡玻璃態：與 header 既有極簡圖標鈕同一階（h-9 w-9、icon h-3.5）。 */
const BASE_BUTTON =
  "flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.82)] active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] max-sm:h-7 max-sm:w-7";

export interface WindowControlsProps {
  className?: string;
}

export function WindowControls({ className }: WindowControlsProps) {
  const shell = useEimuShell();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!shell) return;
    let alive = true;
    // 初值取自外殼真相；外殼推送同步。Promise 包一層，外殼若回非 Promise 也不炸。
    Promise.resolve(shell.isMaximized())
      .then((value) => {
        if (alive) setMaximized(Boolean(value));
      })
      .catch(() => {
        /* 取不到初值就維持未最大化語義，不擋渲染 */
      });
    const unsubscribe = shell.onMaximizeChange((value) => setMaximized(Boolean(value)));
    return () => {
      alive = false;
      // 卸載務必退訂：外殼推送不能打到已卸載元件的 setState。
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
