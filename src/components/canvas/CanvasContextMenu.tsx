"use client";

// CanvasContextMenu —— 畫布通用右鍵選單殼（空白處與節點右鍵共用）。
//
// 誰負責什麼：選單只管「開在哪、怎麼關、長什麼樣」；items 的語義（複製 / 對齊 /
// 刪除…）由呼叫端組裝。根節點帶 data-canvas-interactive，InfiniteCanvas 的手勢層
// 才會放行選單內的指針事件（否則點選單 = 平移畫布）。
//
// 定位：position = 相對畫布容器左上的座標；useLayoutEffect 量測實際尺寸後，
// 超出容器右 / 下緣就翻轉到游標另一側 —— 在 paint 前完成，首幀即最終位置不閃跳。
// 關閉：Escape / 點選單外（window pointerdown capture，比畫布手勢更早收到）。
// 子選單：hover 展開、僅一層；離開後延遲收合，游標斜切過縫隙不會誤關。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CanvasMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 紅字（刪除類破壞性操作） */
  danger?: boolean;
  disabled?: boolean;
  /** 右側灰字快捷鍵提示，如 "Ctrl+C" */
  shortcut?: string;
  /** 二級子選單（hover 展開，僅一層） */
  children?: CanvasMenuItem[];
  onSelect?: () => void;
}

export interface CanvasContextMenuProps {
  open: boolean;
  /** 相對定位容器（畫布容器）的座標 */
  position: { x: number; y: number };
  items: (CanvasMenuItem | "separator")[];
  onClose: () => void;
}

/** 子選單收合延遲：游標離開後在此時間內移回（跨過父項與子選單的縫隙）不收合。 */
const SUBMENU_CLOSE_DELAY_MS = 200;

/** 主選單與子選單同一套面板皮膚（iOS 質感：白玻璃 + 大圓角 + 柔影）。 */
const PANEL_CLASS = "rounded-2xl bg-white/95 p-1 shadow-[0_8px_32px_rgba(0,0,0,0.16)] backdrop-blur";

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

  // 重新打開 / 換位置 = 全新一次選單：子選單狀態歸零。
  useEffect(() => {
    setOpenSubId(null);
    cancelSubClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, position.x, position.y]);

  // 卸載時清掉延遲收合計時器，避免對已卸載元件 setState。
  useEffect(
    () => () => {
      if (subCloseTimerRef.current !== null) window.clearTimeout(subCloseTimerRef.current);
    },
    [],
  );

  // 翻轉定位：量測實際尺寸（items 變動也重量），超出容器右 / 下緣就翻到另一側。
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

  // Escape / 點選單外關閉。capture 讓關閉先於畫布手勢與其他面板收到事件。
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
    // 沒有 onSelect 但有子選單：點擊也能展開（無 hover 環境如觸控筆的後路）。
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
        "flex min-h-[36px] w-full items-center gap-2 rounded-xl px-3 text-left text-[13px] transition-colors",
        item.danger ? "text-[#FF3B30]" : "text-[#1d1d1f]",
        item.disabled ? "cursor-default opacity-40" : "hover:bg-[rgba(0,0,0,0.05)]",
      )}
      onClick={() => handleSelect(item)}
    >
      {item.icon ? <span className="flex h-4 w-4 shrink-0 items-center justify-center">{item.icon}</span> : null}
      <span className="flex-1 truncate">{item.label}</span>
      {item.shortcut ? <span className="shrink-0 text-[11px] text-[rgba(0,0,0,0.35)]">{item.shortcut}</span> : null}
      {!inSubmenu && item.children?.length ? (
        <svg className="shrink-0" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M3.5 1.5 7 5 3.5 8.5" stroke="rgba(0,0,0,0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
          return <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-[rgba(0,0,0,0.06)]" />;
        }
        const hasChildren = Boolean(item.children?.length);
        return (
          <div
            key={item.id}
            className="relative"
            onPointerEnter={() => {
              cancelSubClose();
              if (hasChildren && !item.disabled) setOpenSubId(item.id);
              else scheduleSubClose(); // 滑到別的項目：延遲收掉已開的子選單
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
