"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CopyPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { HISTORY_RERUN_COUNT_OPTIONS } from "@/lib/history-rerun";

export interface AgentRerunMenuProps {
  /** 触发钮文案（视频／音频卡用「再来 N 组」）。 */
  label: string;
  /** 回调缺席＝disabled（卡片既有契约）；disabled 时连选单都不开。 */
  disabled?: boolean;
  /** 选定组数后回调（N 取自 HISTORY_RERUN_COUNT_OPTIONS，与历史卡同一组档位）。 */
  onPick: (count: number) => void;
  /** 触发钮图示；缺省用 CopyPlus（与历史卡的「再来 N 组」同语汇）。 */
  icon?: ReactNode;
}

/**
 * 影片／音频卡共用的「再来 N 组」小选单：一颗触发钮 + 一排组数档位。
 *
 * 为何是会话级而非 payload 级：影片按秒计费（history-rerun.ts:53 注释），
 * /api/generation-jobs 的 payload 重跑只放行图像模型，所以影片／音频这里
 * 只把「再来 N 组」翻成一句话丢回对话，由助理重新决定参数并走既有计费链。
 * 图卡另有 payload 级路径（RerunDialog 走 /api/generation-jobs，明码计价预检）。
 *
 * DOM 注意：选单是触发钮的**兄弟**（同一 relative 容器），不是子节点——
 * 巢状 <button> 是全站已知坑，agent-chat-ui.test.ts 有扫描锁。
 */
export function AgentRerunMenu({ label, disabled = false, onPick, icon }: AgentRerunMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外面就收——浮层不该把人锁在原地（与 Surface 的 dropdown 同惯例）。
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