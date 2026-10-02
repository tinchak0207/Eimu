"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { HISTORY_RERUN_COUNT_OPTIONS } from "@/lib/history-rerun";

export interface AgentRerunMenuProps {
  /** 觸發鈕文案（視頻／音頻卡用「再来 N 组」）。 */
  label: string;
  /** 回調缺席＝disabled（卡片既有契約）；disabled 時連選單都不開。 */
  disabled?: boolean;
  /** 選定組數後回調（N 取自 HISTORY_RERUN_COUNT_OPTIONS，與歷史卡同一組檔位）。 */
  onPick: (count: number) => void;
  /** 觸發鈕圖示；缺省用 CopyPlus（與歷史卡的「再來 N 組」同語彙）。 */
  icon?: ReactNode;
}

/**
 * 影片／音頻卡共用的「再来 N 组」小選單：一顆觸發鈕 + 一排組數檔位。
 *
 * 為何是會話級而非 payload 級：影片按秒計費（history-rerun.ts:53 註釋），
 * /api/generation-jobs 的 payload 重跑只放行圖像模型，所以影片／音頻這裡
 * 只把「再來 N 組」翻成一句話丟回對話，由助理重新決定參數並走既有計費鏈。
 * 圖卡另有 payload 級路徑（RerunDialog 走 /api/generation-jobs，明碼計價預檢）。
 *
 * DOM 注意：選單是觸發鈕的**兄弟**（同一 relative 容器），不是子節點——
 * 巢狀 <button> 是全站已知坑，agent-chat-ui.test.ts 有掃描鎖。
 */
export function AgentRerunMenu({ label, disabled = false, onPick, icon }: AgentRerunMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 點外面就收——浮層不該把人鎖在原地（與 Surface 的 dropdown 同慣例）。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          "flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote text-muted-foreground transition-colors",
          "enabled:hover:bg-white/60 enabled:hover:text-foreground/70",
          "disabled:cursor-not-allowed disabled:text-foreground/45",
          "focus:outline-none focus:ring-2 focus:ring-ios-blue/30",
          "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
        )}
      >
        {icon ?? <CopyPlus className="h-3.5 w-3.5" aria-hidden="true" />}
        {label}
      </button>
      {open && !disabled && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-full left-0 z-20 mb-1 flex gap-1 rounded-lg bg-white/95 p-1 shadow-[0_6px_20px_rgba(31,34,48,0.12)] ring-1 ring-black/5 backdrop-blur-md"
        >
          {HISTORY_RERUN_COUNT_OPTIONS.map((count) => (
            <button
              key={count}
              type="button"
              role="menuitem"
              aria-label={`再来 ${count} 组`}
              onClick={() => {
                setOpen(false);
                onPick(count);
              }}
              className="flex h-9 w-9 items-center justify-center rounded-md text-ios-footnote font-medium text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ios-blue/30 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
            >
              {count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}