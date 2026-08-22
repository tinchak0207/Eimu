"use client";

// 畫布工具列：標題 + 撤銷/重做/背景/視口/匯入匯出/清空 + 儲存狀態 + 預算橫條。
//
// 桌面：一條 h-12 頂欄（維持原樣）。
// 行動端（<768px）：變成底部動作列 —— 固定貼底、兩列（第一列 標題+狀態+預算+收合開關，
// 第二列 動作按鈕橫向捲動）、可收合（只留標題列）、所有按鈕 ≥44px、標題輸入 ≥16px
// （避免 iOS focus 自動放大頁面）、安全區 bottom padding、data-canvas-interactive
// 標記整列以免與畫布平移衝突。

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FilePlus2,
  Grid3x3,
  Map,
  Maximize2,
  Redo2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CanvasBudgetBar } from "./CanvasBudgetBar";

export interface CanvasToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  minimapVisible: boolean;
  onToggleMinimap: () => void;
  backgroundMode: "dots" | "lines" | "blank";
  onCycleBackground: () => void;
  onFitView: () => void;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onClear: () => void;
  onClearCanvas?: () => void;
  budget: { usedCoins: number; remainingCoins: number } | null;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  projectTitle: string;
  onProjectTitleChange: (title: string) => void;
  className?: string;
}

const ICON_BUTTON =
  "h-8 w-8 inline-flex shrink-0 items-center justify-center rounded-full transition-colors " +
  "touch-manipulation [-webkit-tap-highlight-color:transparent] " +
  "hover:bg-black/5 active:bg-black/10 disabled:opacity-35 disabled:cursor-not-allowed " +
  // 行動端：≥44px 觸控目標，關掉 sticky hover，改用按下回饋
  "max-sm:h-11 max-sm:w-11 max-sm:hover:bg-transparent max-sm:active:bg-black/10";
const ICON = "h-4 w-4 max-sm:h-5 max-sm:w-5";

const SAVE_STATE_TEXT: Record<CanvasToolbarProps["saveState"], { text: string; className: string }> = {
  idle: { text: "", className: "" },
  saving: { text: "保存中…", className: "text-muted-foreground" },
  saved: { text: "已保存", className: "text-foreground/45" },
  error: { text: "保存失败", className: "text-destructive" },
  offline: { text: "未登录，仅本地", className: "text-[#B76E00]" },
};

export function CanvasToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  minimapVisible,
  onToggleMinimap,
  backgroundMode,
  onCycleBackground,
  onFitView,
  onExport,
  onImportFile,
  onClear,
  onClearCanvas,
  budget,
  saveState,
  projectTitle,
  onProjectTitleChange,
  className,
}: CanvasToolbarProps) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!confirmingClear) return;
    const timer = window.setTimeout(() => setConfirmingClear(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmingClear]);

  const handleImportChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImportFile(file);
    // 清空 value，讓再次選同一個檔案也能觸發 change。
    e.target.value = "";
  };

  const backgroundLabel = backgroundMode === "dots" ? "点阵" : backgroundMode === "lines" ? "网格" : "空白";
  const saveIndicator = SAVE_STATE_TEXT[saveState];
  const saveLabel =
    saveState !== "idle" && saveIndicator.text !== "" ? (
      <span className={cn("text-ios-caption1 whitespace-nowrap", saveIndicator.className)}>{saveIndicator.text}</span>
    ) : null;

  // 動作按鈕組：桌面與行動端各渲染一份（各自 hidden，同一時刻只有一份可見）。
  const actionButtons = (
    <>
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title="撤销"
        aria-label="撤销"
        className={ICON_BUTTON}
      >
        <Undo2 className={ICON} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title="重做"
        aria-label="重做"
        className={ICON_BUTTON}
      >
        <Redo2 className={ICON} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onToggleMinimap}
        aria-pressed={minimapVisible}
        title="缩略图"
        aria-label="缩略图"
        className={cn(ICON_BUTTON, minimapVisible && "lg-fill-active text-ios-blue")}
      >
        <Map className={ICON} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onCycleBackground}
        title={`背景：${backgroundLabel}`}
        aria-label={`背景：${backgroundLabel}`}
        className={ICON_BUTTON}
      >
        <Grid3x3 className={ICON} aria-hidden="true" />
      </button>
      <button type="button" onClick={onFitView} title="适应画布" aria-label="适应画布" className={ICON_BUTTON}>
        <Maximize2 className={ICON} aria-hidden="true" />
      </button>
      <button type="button" onClick={onExport} title="导出 JSON" aria-label="导出 JSON" className={ICON_BUTTON}>
        <Download className={ICON} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        title="导入 JSON"
        aria-label="导入 JSON"
        className={ICON_BUTTON}
      >
        <Upload className={ICON} aria-hidden="true" />
      </button>
      {onClearCanvas && (
        <button
          type="button"
          onClick={onClearCanvas}
          title="新建画布"
          aria-label="新建画布"
          className={ICON_BUTTON}
        >
          <FilePlus2 className={ICON} aria-hidden="true" />
        </button>
      )}
      {confirmingClear ? (
        <button
          type="button"
          onClick={() => {
            setConfirmingClear(false);
            onClear();
          }}
          title="确认清空？"
          aria-label="确认清空？"
          className="inline-flex h-8 touch-manipulation items-center justify-center rounded-full bg-destructive px-3 text-ios-caption1 font-medium text-white transition-colors hover:bg-destructive/90 max-sm:h-11 max-sm:px-4 max-sm:text-ios-footnote"
        >
          确认清空？
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmingClear(true)}
          title="清空画布"
          aria-label="清空画布"
          className={ICON_BUTTON}
        >
          <Trash2 className={ICON} aria-hidden="true" />
        </button>
      )}
    </>
  );

  return (
    <div
      data-canvas-interactive
      className={cn(
        "lg-bar flex h-12 items-center gap-1.5 rounded-none border-x-0 px-3",
        // 行動端：底部動作列（固定貼底、可收合、安全區）
        "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-40 max-sm:h-auto max-sm:flex-col max-sm:items-stretch max-sm:gap-0 max-sm:rounded-t-2xl max-sm:px-2 max-sm:pt-1 max-sm:pb-[max(env(safe-area-inset-bottom),0.5rem)]",
        className,
      )}
    >
      {/* ── 桌面單列：標題 + 動作 + 儲存/預算 ── */}
      <div className="hidden h-full min-w-0 flex-1 items-center gap-1.5 sm:flex">
        <input
          aria-label="画布标题"
          value={projectTitle}
          onChange={(e) => onProjectTitleChange(e.target.value)}
          spellCheck={false}
          className="w-44 bg-transparent text-[15px] font-medium text-foreground focus:outline-none"
        />
        <span className="mx-1 h-5 w-px shrink-0 bg-black/10" aria-hidden="true" />
        {actionButtons}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {saveLabel}
          <CanvasBudgetBar budget={budget} />
        </div>
      </div>

      {/* ── 行動端第一列：標題（≥16px）+ 儲存/預算 + 收合開關 ── */}
      <div className="hidden min-w-0 flex-1 items-center gap-2 max-sm:flex">
        <input
          aria-label="画布标题"
          value={projectTitle}
          onChange={(e) => onProjectTitleChange(e.target.value)}
          spellCheck={false}
          className="w-auto min-w-0 flex-1 bg-transparent text-base font-medium text-foreground focus:outline-none"
        />
        {!collapsed && saveLabel}
        {!collapsed && <CanvasBudgetBar budget={budget} />}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "展开工具栏" : "收起工具栏"}
          aria-expanded={!collapsed}
          className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/45 active:bg-black/10"
        >
          {collapsed ? (
            <ChevronUp className="h-5 w-5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* ── 行動端第二列：動作按鈕（橫向捲動） ── */}
      {!collapsed && (
        <div className="hidden min-w-0 touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain pb-0.5 max-sm:flex">
          {actionButtons}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportChange}
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  );
}
