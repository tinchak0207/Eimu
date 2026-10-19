"use client";

// CanvasContextMenu —— 画布通用右键选单壳（空白处与节点右键共用）。
//
// 谁负责什么：选单只管「开在哪、怎么关、长什么样」；items 的语义（复制 / 对齐 /
// 删除…）由呼叫端组装。根节点带 data-canvas-interactive，InfiniteCanvas 的手势层
// 才会放行选单内的指针事件（否则点选单 = 平移画布）。
//
// 定位：position = 相对画布容器左上的座标；useLayoutEffect 量测实际尺寸后，
// 超出容器右 / 下缘就翻转到游标另一侧 —— 在 paint 前完成，首帧即最终位置不闪跳。
// 关闭：Escape / 点选单外（window pointerdown capture，比画布手势更早收到）。
// 子选单：hover 展开、仅一层；离开后延迟收合，游标斜切过缝隙不会误关。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CanvasMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 红字（删除类破坏性操作） */
  danger?: boolean;
  disabled?: boolean;
  /** 右侧灰字快捷键提示，如 "Ctrl+C" */
  shortcut?: string;
  /** 二级子选单（hover 展开，仅一层） */
  children?: CanvasMenuItem[];
  onSelect?: () => void;
}

export interface CanvasContextMenuProps {
  open: boolean;
  /** 相对定位容器（画布容器）的座标 */
  position: { x: number; y: number };
  items: (CanvasMenuItem | "separator")[];
  onClose: () => void;
}

/** 子选单收合延迟：游标离开后在此时间内移回（跨过父项与子选单的缝隙）不收合。 */
const SUBMENU_CLOSE_DELAY_MS = 200;

/** 主选单与子选单同一套面板皮肤（iOS 质感：lg-sheet 白玻璃 + 大圆角）。 */
const PANEL_CLASS = "rounded-2xl lg-sheet p-1";

function CanvasContextMenu({ open, position, items, onClose }: CanvasContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [adjusted, setAdjusted] = useState(position);
  const [openSubId, setOpenSubId] = useState<string | null>(null);
  const subCloseTimerRef = useRef<number | null>(null);

  const cancelSubClose = () => {
    if (subCloseTimerRef.current !== null) {
      window.clearTimeout(subCloseTimerRef.current);
      subCloseTimerRef.current = null;
    }
  };
  const scheduleSubClose = () => {
    cancelSubClose();
    subCloseTimerRef.current = window.setTimeout(() => {
      subCloseTimerRef.current = null;
      setOpenSubId(null);
    }, SUBMENU_CLOSE_DELAY_MS);
  };

  // 重新打开 / 换位置 = 全新一次选单：子选单状态归零。
  useEffect(() => {
    setOpenSubId(null);
    cancelSubClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position.x, position.y]);

  // 卸载时清掉延迟收合计时器，避免对已卸载元件 setState。
  useEffect(
    () => () => {
      if (subCloseTimerRef.current !== null) window.clearTimeout(subCloseTimerRef.current);
    },
    [],
  );

  // 翻转定位：量测实际尺寸（items 变动也重量），超出容器右 / 下缘就翻到另一侧。
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const pw = parent ? parent.clientWidth : window.innerWidth;
    const ph = parent ? parent.clientHeight : window.innerHeight;
    let x = position.x;
    let y = position.y;
    if (x + el.offsetWidth > pw) x = Math.max(0, x - el.offsetWidth);
    if (y + el.offsetHeight > ph) y = Math.max(0, y - el.offsetHeight);
    setAdjusted((prev) => (prev.x === x && prev.y === y ? prev : { x, y }));
  }, [open, position.x, position.y, items]);

  // Escape / 点选单外关闭。capture 让关闭先于画布手势与其他面板收到事件。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSelect = (item: CanvasMenuItem) => {
    if (item.disabled) return;
    if (item.onSelect) {
      item.onSelect();
      onClose();
      return;
    }
    // 没有 onSelect 但有子选单：点击也能展开（无 hover 环境如触控笔的后路）。
    if (item.children?.length) {
      cancelSubClose();
      setOpenSubId((prev) => (prev === item.id ? null : item.id));
    }
  };

  const renderButton = (item: CanvasMenuItem, inSubmenu: boolean) => (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      className={cn(
        "flex min-h-[36px] w-full items-center gap-2 rounded-xl px-3 text-left text-ios-footnote transition-colors",
        item.danger ? "text-destructive" : "text-foreground",
        item.disabled ? "cursor-default opacity-40" : "hover:bg-black/5",
      )}
      onClick={() => handleSelect(item)}
    >
      {item.icon ? <span className="flex h-4 w-4 shrink-0 items-center justify-center">{item.icon}</span> : null}
      <span className="flex-1 truncate">{item.label}</span>
      {item.shortcut ? <span className="shrink-0 text-ios-caption2 text-foreground/45">{item.shortcut}</span> : null}
      {!inSubmenu && item.children?.length ? (
        <svg className="shrink-0 text-foreground/45" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M3.5 1.5 7 5 3.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );

  return (
    <div
      ref={menuRef}
      data-canvas-interactive
      role="menu"
      className={cn("absolute z-50 max-h-[60vh] min-w-[180px] select-none overflow-y-auto", PANEL_CLASS)}
      style={{ left: adjusted.x, top: adjusted.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === "separator") {
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-black/5" />;
        }
        const hasChildren = Boolean(item.children?.length);
        return (
          <div
            key={item.id}
            className="relative"
            onPointerEnter={() => {
              cancelSubClose();
              if (hasChildren && !item.disabled) setOpenSubId(item.id);
              else scheduleSubClose(); // 滑到别的项目：延迟收掉已开的子选单
            }}
            onPointerLeave={() => {
              if (hasChildren) scheduleSubClose();
            }}
          >
            {renderButton(item, false)}
            {hasChildren && openSubId === item.id ? (
              <div
                role="menu"
                className={cn("absolute left-full top-0 z-50 ml-1 min-w-[160px]", PANEL_CLASS)}
                onPointerEnter={cancelSubClose}
                onPointerLeave={scheduleSubClose}
              >
                {item.children?.map((child) => (
                  <div key={child.id}>{renderButton(child, true)}</div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export { CanvasContextMenu };
export default CanvasContextMenu;
