"use client";

// CanvasShortcutsHelp —— 画布快捷键帮助 modal。
//
// 置中白卡 + 半透明幕布，Escape / 点卡片外关闭（window capture，
// 先于画布手势与其他面板收到事件，关闭行为与 CanvasContextMenu 同款）。
// 内容为四组静态表格（视图 / 选择 / 编辑 / 节点），按键与手势一律以
// kbd 胶囊呈现；同一操作的多组按键以「或」相连。
// 根节点带 data-canvas-interactive，画布手势层不会把 modal 内操作当平移。

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export interface CanvasShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

/** 一列快捷键：desc 操作说明；combos 一或多组按键（组内以 + 相连，组间以「或」相连）。 */
interface ShortcutRow {
  desc: string;
  combos: string[][];
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/** 静态内容表：与画布实际手势 / 快捷键实作对齐，UI 文案简体。 */
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

/** kbd 胶囊：按键与手势共用一套皮肤。 */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="whitespace-nowrap rounded-md border border-black/10 bg-black/5 px-1.5 py-[3px] font-sans text-ios-caption2 font-medium leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

function CanvasShortcutsHelp({ open, onClose }: CanvasShortcutsHelpProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Escape / 点卡片外关闭。capture 让关闭先于画布手势收到事件。
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
      {/* 半透明幕布（点击由 window capture 统一处理关闭） */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" aria-hidden />

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        className="relative flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl lg-sheet"
      >
        {/* 标题列 */}
        <div className="flex shrink-0 items-center justify-between border-b px-5 pb-3 pt-4">
          <h2 className="text-[15px] font-semibold text-foreground">键盘快捷键</h2>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-full text-foreground/45 transition-colors hover:bg-black/5 hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 四组表格（可卷动；宽萤幕两栏） */}
        <div className="grid gap-x-8 gap-y-5 overflow-y-auto px-5 pb-5 pt-4 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1 text-ios-caption1 font-semibold text-foreground/45">{group.title}</h3>
              <div className="divide-y divide-black/5">
                {group.rows.map((row) => (
                  <div key={row.desc} className="flex min-h-[34px] items-center justify-between gap-3 py-1.5">
                    <span className="text-ios-footnote text-foreground">{row.desc}</span>
                    <span className="flex flex-wrap items-center justify-end gap-1">
                      {row.combos.map((combo, comboIndex) => (
                        <span key={comboIndex} className="flex items-center gap-1">
                          {comboIndex > 0 ? (
                            <span className="text-ios-caption2 text-foreground/45">或</span>
                          ) : null}
                          {combo.map((key, keyIndex) => (
                            <span key={keyIndex} className="flex items-center gap-0.5">
                              {keyIndex > 0 ? (
                                <span className="text-ios-caption2 text-foreground/45">+</span>
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
