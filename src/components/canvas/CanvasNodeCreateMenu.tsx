"use client";

// CanvasNodeCreateMenu —— 新建節點小型 popover（雙擊空白 / 拉線到空白處彈出）。
//
// 只管「開在哪、怎麼關、三個入口」：文本節點、空白圖片節點、上傳圖片
// （內藏 hidden file input，選檔後回調 onUploadFiles 並自動關閉）；
// 建立語義由呼叫端接手。標題列可換文案（如「连接到新节点」）。
//
// 定位：position = 相對畫布容器左上的座標；useLayoutEffect 量測實際尺寸
// 後，超出容器右 / 下緣就翻轉到另一側 —— paint 前完成，首幀即最終位置。
// 關閉：Escape / 點選單外（window pointerdown capture，先於畫布手勢）。
// 根節點帶 data-canvas-interactive，InfiniteCanvas 手勢層放行選單內事件。

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { ImageIcon, Type, Upload } from "lucide-react";

export interface CanvasNodeCreateMenuProps {
  open: boolean;
  /** 相對畫布容器的座標 */
  position: { x: number; y: number };
  onClose: () => void;
  /** type: "text" | "image"（空節點） */
  onCreate: (type: "text" | "image") => void;
  /** 用戶選了本地圖片檔 */
  onUploadFiles: (files: File[]) => void;
  /** 標題列說明（如「新建节点」/「连接到新节点」），預設「新建节点」 */
  title?: string;
}

/** 選單項目統一皮膚（≥36px 熱區 + hover 態）。 */
const ITEM_CLASS =
  "flex min-h-[36px] w-full items-center gap-2 rounded-lg px-3 text-left text-[13px] text-[#1d1d1f] transition-colors hover:bg-[rgba(0,0,0,0.05)]";

function CanvasNodeCreateMenu({
  open,
  position,
  onClose,
  onCreate,
  onUploadFiles,
  title = "新建节点",
}: CanvasNodeCreateMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [adjusted, setAdjusted] = useState(position);

  // 翻轉定位：量測實際尺寸，超出畫布容器右 / 下緣就翻到游標另一側。
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
  }, [open, position.x, position.y]);

  // Escape / 點選單外關閉。capture 讓關閉先於畫布手勢收到事件。
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

  const handleCreate = (type: "text" | "image") => {
    onCreate(type);
    onClose();
  };

  // 選檔後回調並關閉；清空 value 讓下次選同一批檔案仍會觸發 change。
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    onUploadFiles(files);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      data-canvas-interactive
      role="menu"
      aria-label={title}
      className="absolute z-50 w-[200px] select-none rounded-xl bg-white/95 p-1 shadow-[0_8px_32px_rgba(0,0,0,0.16)] backdrop-blur"
      style={{ left: adjusted.x, top: adjusted.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 標題列 */}
      <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-[rgba(0,0,0,0.4)]">{title}</p>

      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => handleCreate("text")}>
        <Type className="h-4 w-4 shrink-0 text-[rgba(0,0,0,0.55)]" />
        <span className="flex-1 truncate">文本节点</span>
      </button>

      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => handleCreate("image")}>
        <ImageIcon className="h-4 w-4 shrink-0 text-[rgba(0,0,0,0.55)]" />
        <span className="flex-1 truncate">空白图片节点</span>
      </button>

      <button type="button" role="menuitem" className={ITEM_CLASS} onClick={() => fileInputRef.current?.click()}>
        <Upload className="h-4 w-4 shrink-0 text-[rgba(0,0,0,0.55)]" />
        <span className="flex-1 truncate">上传图片…</span>
      </button>

      {/* 隱藏檔案選擇器：點「上传图片…」代為觸發 */}
      <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={handleFileChange} />
    </div>
  );
}

export { CanvasNodeCreateMenu };
export default CanvasNodeCreateMenu;
