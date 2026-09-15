"use client";

// D-23 参数卡片在窄屏是**底部抽屉**，宽屏是就地手风琴。
//
// 为什么不是同一套 UI 缩一缩：手机上聊天流本来就只有一屏，
// 就地展开一张参数表会把刚出的图顶出视野，人得往回滚才找得到自己在看什么。
// 抽屉从底部盖上来，图还在原地，关掉就回到原位——这是「另一个布局」，
// 不是把桌面那套压窄。
//
// 展开状态两个布局共用一个 `open`：转屏 / 拉窗宽时抽屉变手风琴，
// 展开的东西继续展开，不会因为换布局就莫名收起来，也不会留一层
// 关不掉的遮罩在屏幕上。

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import { AgentParamCard } from "./AgentParamCard";

export interface AgentParamDisclosureProps {
  argsSummary: string;
  /** 折叠区 / 抽屉的 DOM id 前缀，同一页多张卡不能撞。 */
  idPrefix: string;
  /** 抽屉标题里的工具名，让人知道这张参数属于哪次调用。 */
  toolName?: string;
}

export function AgentParamDisclosure({ argsSummary, idPrefix, toolName }: AgentParamDisclosureProps) {
  const [open, setOpen] = useState(false);
  // F2：展开区在「首次展开」之前不挂载——默认渲染（DOM）里不许有 raw JSON /
  // 原始函数名，只有展开过一次才留在树上（关回去仍有收起动画，不闪断）。
  const [everOpened, setEverOpened] = useState(false);
  const narrow = useIsNarrow();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const drawerOpen = open && narrow;

  const toggle = (): void => {
    setOpen((v) => !v);
    setEverOpened(true);
  };

  const close = useCallback((): void => {
    setOpen(false);
    // 焦点还回触发它的按钮：抽屉关掉后焦点若留在已卸载的节点上，
    // 键盘用户会被扔回文档开头。
    triggerRef.current?.focus();
  }, []);

  // Esc 关闭 + 背景锁滚动。只在抽屉真的开着时装，
  // 依赖里带上 drawerOpen，所以拉宽窗口（抽屉变手风琴）会自动解锁——
  // 少了这一层，转屏后 body 会永久卡在 overflow:hidden。
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    // 存原值而不是收尾时写死 ""：这个页面别处也可能在锁滚动，
    // 直接清空会把别人的锁一起解开。
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`${idPrefix}-params`}
        className="inline-flex min-h-11 w-fit cursor-pointer touch-manipulation items-center gap-1.5 self-start rounded-full px-2.5 text-ios-subhead font-medium text-ios-blue/[0.92] transition-colors duration-200 hover:text-ios-blue active:bg-ios-blue/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
      >
        {/* 窄屏点开的是抽屉，图标跟着语义换：手风琴才有「转箭头」这回事。 */}
        {narrow ? (
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        ) : (
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
            aria-hidden="true"
          />
        )}
        {open && !narrow ? "收起参数" : "查看参数"}
      </button>

      {narrow ? (
        drawerOpen && (
          <div
            className="agent-param-scrim"
            role="presentation"
            onClick={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              id={`${idPrefix}-params`}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="agent-param-drawer lg-sheet"
            >
              {/* 抓手是可见的可抓性提示，不是装饰；真正的关闭靠右上角按钮与点遮罩。 */}
              <span className="agent-param-drawer-grip" aria-hidden="true" />
              <div className="flex items-center gap-2 px-4 pb-2">
                <p id={titleId} className="min-w-0 flex-1 text-ios-subhead font-semibold text-foreground">
                  {toolName ? `${toolName} 的参数` : "这次用到的参数"}
                </p>
                <button
                  ref={closeRef}
                  type="button"
                  onClick={close}
                  aria-label="关闭参数"
                  className="flex h-11 w-11 shrink-0 cursor-pointer touch-manipulation items-center justify-center rounded-full bg-black/5 text-muted-foreground transition-colors hover:bg-black/[0.09] hover:text-foreground active:bg-black/[0.13] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 motion-reduce:transition-none [-webkit-tap-highlight-color:transparent]"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              <div className="agent-param-drawer-body">
                <AgentParamCard argsSummary={argsSummary} idPrefix={`${idPrefix}-drawer`} />
              </div>
            </div>
          </div>
        )
      ) : (
        <div id={`${idPrefix}-params`} className={cn("agent-args", open && "is-open")}>
          {/* 全聊天流只許有一層滾動（最外側訊息流）。展開內容超過 60dvh
              直接截斷（.agent-args-inner 的 overflow:hidden），不設內部捲軸——
              卡內滾動手勢一律冒泡給外層，否則巨型參數卡會吞掉整屏滾動。 */}
          <div className="agent-args-inner max-h-[60dvh]" style={{ overflow: "clip" }}>
            {/* F2：原始函数名与完整参数只在展开后挂载（默认渲染不含 raw JSON）。 */}
            {everOpened && (
              <>
                {toolName !== undefined && (
                  <p className="px-0.5 pb-1.5 font-mono text-ios-caption1 text-foreground/45">{toolName}</p>
                )}
                {/* D-19：参数分常用层／进阶层两段，不再是一坨 JSON 原文。
                    花费不往下传：卡片头已经常驻显示，展开后再来一次是噪音。 */}
                <AgentParamCard argsSummary={argsSummary} idPrefix={idPrefix} />
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
