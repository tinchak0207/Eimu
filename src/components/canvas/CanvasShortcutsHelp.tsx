"use client";

// CanvasShortcutsHelp —— 畫布快捷鍵幫助 modal。
//
// 置中白卡 + 半透明幕布，Escape / 點卡片外關閉（window capture，
// 先於畫布手勢與其他面板收到事件，關閉行為與 CanvasContextMenu 同款）。
// 內容為四組靜態表格（视图 / 选择 / 编辑 / 节点），按鍵與手勢一律以
// kbd 膠囊呈現；同一操作的多組按鍵以「或」相連。
// 根節點帶 data-canvas-interactive，畫布手勢層不會把 modal 內操作當平移。

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface CanvasShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

/** 一列快捷鍵：desc 操作說明；combos 一或多組按鍵（組內以 + 相連，組間以「或」相連）。 */
interface ShortcutRow {
  desc: string;
  combos: string[][];
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/** 靜態內容表：與畫布實際手勢 / 快捷鍵實作對齊，UI 文案簡體。 */
const GROUPS: ShortcutGroup[] = [
  {
    title: "视图",
    rows: [
      { desc: "平移画布", combos: [["拖动空白"]] },
      { desc: "缩放", combos: [["滚轮"]] },
      { desc: "缩放（移动端）", combos: [["双指捏合"]] },
      { desc: "新建节点", combos: [["双击空白"]] },
      { desc: "精确缩放", combos: [["缩放滑杆"]] },
    ],
  },
  {
    title: "选择",
    rows: [
      { desc: "框选", combos: [["Shift/Ctrl", "拖动"]] },
      { desc: "切换选中", combos: [["Ctrl/Cmd", "点击"]] },
      { desc: "追加选中", combos: [["Shift", "点击"]] },
      { desc: "全选", combos: [["Ctrl/Cmd", "A"]] },
      { desc: "清除选择", combos: [["Esc"]] },
    ],
  },
  {
    title: "编辑",
    rows: [
      { desc: "复制 / 粘贴", combos: [["Ctrl/Cmd", "C / V"]] },
      { desc: "创建副本", combos: [["Ctrl/Cmd", "D"]] },
      { desc: "删除节点或连线", combos: [["Delete"]] },
      { desc: "撤销", combos: [["Ctrl/Cmd", "Z"]] },
      { desc: "重做", combos: [["Ctrl/Cmd", "Shift", "Z"], ["Ctrl", "Y"]] },
    ],
  },
  {
    title: "节点",
    rows: [
      { desc: "重命名", combos: [["双击标题"]] },
      { desc: "编辑文字", combos: [["双击文本节点"]] },
      { desc: "连线", combos: [["拖动边缘圆点"]] },
      { desc: "上传图片", combos: [["拖图片文件入画布"]] },
    ],
  },
];

/** kbd 膠囊：按鍵與手勢共用一套皮膚。 */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="whitespace-nowrap rounded-md border border-[rgba(0,0,0,0.12)] bg-[rgba(0,0,0,0.04)] px-1.5 py-[3px] font-sans text-[11px] font-medium leading-none text-[rgba(0,0,0,0.65)]">
      {children}
    </kbd>
  );
}

function CanvasShortcutsHelp({ open, onClose }: CanvasShortcutsHelpProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Escape / 點卡片外關閉。capture 讓關閉先於畫布手勢收到事件。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const el = cardRef.current;
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

  return (
    <div
      data-canvas-interactive
      role="presentation"
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
    >
      {/* 半透明幕布（點擊由 window capture 統一處理關閉） */}
      <div className="absolute inset-0 bg-[rgba(0,0,0,0.32)] backdrop-blur-[2px]" aria-hidden />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        className="relative flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_24px_64px_rgba(0,0,0,0.24)]"
      >
        {/* 標題列 */}
        <div className="flex shrink-0 items-center justify-between border-b border-[rgba(0,0,0,0.06)] px-5 pb-3 pt-4">
          <h2 className="text-[15px] font-semibold text-[#1d1d1f]">键盘快捷键</h2>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-full text-[rgba(0,0,0,0.45)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[#1d1d1f]"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 四組表格（可捲動；寬螢幕兩欄） */}
        <div className="grid gap-x-8 gap-y-5 overflow-y-auto px-5 pb-5 pt-4 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1 text-[12px] font-semibold text-[rgba(0,0,0,0.4)]">{group.title}</h3>
              <div className="divide-y divide-[rgba(0,0,0,0.05)]">
                {group.rows.map((row) => (
                  <div key={row.desc} className="flex min-h-[34px] items-center justify-between gap-3 py-1.5">
                    <span className="text-[13px] text-[#1d1d1f]">{row.desc}</span>
                    <span className="flex flex-wrap items-center justify-end gap-1">
                      {row.combos.map((combo, comboIndex) => (
                        <span key={comboIndex} className="flex items-center gap-1">
                          {comboIndex > 0 ? (
                            <span className="text-[11px] text-[rgba(0,0,0,0.35)]">或</span>
                          ) : null}
                          {combo.map((key, keyIndex) => (
                            <span key={keyIndex} className="flex items-center gap-0.5">
                              {keyIndex > 0 ? (
                                <span className="text-[10px] text-[rgba(0,0,0,0.35)]">+</span>
                              ) : null}
                              <Kbd>{key}</Kbd>
                            </span>
                          ))}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export { CanvasShortcutsHelp };
export default CanvasShortcutsHelp;
