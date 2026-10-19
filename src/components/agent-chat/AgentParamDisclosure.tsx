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

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsNarrow } from "@/hooks/use-is-narrow";
import { parseToolParams } from "@/lib/agent-tool-params";

export interface AgentParamDisclosureProps {
  argsSummary: string;
  /** 折叠区 / 抽屉的 DOM id 前缀，同一页多张卡不能撞。 */
  idPrefix: string;
  /** 抽屉标题里的工具名，让人知道这张参数属于哪次调用。 */
  toolName?: string;
  /**
   * 该工具已结算的花费（2026-09-20 对版预览：币数从行内移进展开面板）。
   * 未结算时不显示，绝不猜；缺席时面板少这最后一行。
   */
  costCoins?: number;
  /**
   * 整行触发器（2026-09-20 工具行化）：宿主把整行（通常是无底色细行）交给
   * 这里渲染，点行即展开；ref 必须挂到那个按钮上（抽屉关闭后焦点还原用）。
   * 缺席时回落默认「查看参数」按钮，其他挂载点行为不变。
   */
  trigger?: (api: {
    open: boolean;
    toggle: () => void;
    ref: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
}

/** 展示用的币数：整数原样，浮点去掉多余尾巴（与各卡同款）。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * 展开块的内容（宽屏手风琴与窄屏抽屉共用一份，转屏不换语言）：
 * 一行一个 key：value，key 用 `text-foreground/45`，value 退到灰字——
 * 与预览的展开块逐字同形（key：value 行，不是两列参数表）。
 * 币数是这一块的最后一个 key（消耗：N 币），行内不再重复。
 *
 * 参数本身仍走 agent-tool-params 的解析器（唯一权威）：完整 JSON → 逐栏位；
 * 被网关截断 / 不是 JSON → 捞出 key: value；一个都捞不到就退回原文，
 * 不把半截 JSON 编成看起来完整的参数表。
 */
function ParamLines({ argsSummary, costCoins }: { argsSummary: string; costCoins?: number }) {
  const parsed = useMemo(() => parseToolParams(argsSummary), [argsSummary]);
  const params = parsed?.params ?? [];
  const raw = params.length === 0 ? parsed?.raw : undefined;
  return (
    <>
      {params.map((param) => (
        <p
          key={param.key}
          className="text-ios-footnote leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]"
        >
          <span className="text-foreground/45">{param.label}：</span>
          {param.value}
        </p>
      ))}
      {raw !== undefined && (
        <p className="whitespace-pre-wrap font-mono text-ios-caption1 leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]">
          {raw}
        </p>
      )}
      {costCoins !== undefined && (
        <p className="text-ios-footnote leading-[1.5] text-muted-foreground tabular-nums">
          <span className="text-foreground/45">消耗：</span>
          {formatCoins(costCoins)} 币
        </p>
      )}
      {/* 上游截断过就说出来，不让人以为这就是全部参数。 */}
      {parsed?.truncated && (
        <p className="text-ios-caption1 leading-[1.5] text-foreground/45">
          上游只回传了参数摘要，可能不完整
        </p>
      )}
    </>
  );
}

export function AgentParamDisclosure({ argsSummary, idPrefix, toolName, costCoins, trigger }: AgentParamDisclosureProps) {
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
      {trigger ? (
        trigger({ open, toggle, ref: triggerRef })
      ) : (
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
      )}

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
              <div className="agent-param-drawer-body space-y-1">
                <ParamLines argsSummary={argsSummary} costCoins={costCoins} />
              </div>
            </div>
          </div>
        )
      ) : (
        <div id={`${idPrefix}-params`} className={cn("agent-args", open && "is-open")}>
          {/* 全聊天流只许有一层滚动（最外侧讯息流）。展开内容超过 60dvh
              直接截断（.agent-args-inner 的 overflow:hidden），不设内部卷轴——
              卡内滚动手势一律冒泡给外层，否则巨型参数卡会吞掉整屏滚动。 */}
          <div className="agent-args-inner max-h-[60dvh]" style={{ overflow: "clip" }}>
            {/* 展开块＝lg-float（Emu Liquid Glass 保留在展开态，2026-09-20 裁定：
                收起时是无底色细行，展开才浮出玻璃面）。缩排 ml-[22px] 对齐行内
                标题起始，收合动画（agent-args 网格）照旧。 */}
            {everOpened && (
              <div className="lg-float mb-1 ml-[22px] space-y-1 rounded-[10px] px-2.5 py-2">
                {/* F2：原始函数名与完整参数只在展开后挂载（默认渲染不含 raw JSON）。 */}
                {toolName !== undefined && (
                  <p className="px-0.5 pb-1.5 font-mono text-ios-caption1 text-foreground/45">{toolName}</p>
                )}
                <ParamLines argsSummary={argsSummary} costCoins={costCoins} />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
