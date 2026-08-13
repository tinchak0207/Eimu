"use client";

// 畫布工具列：標題 + 撤銷/重做/背景/視口/匯入匯出/清空 + 儲存狀態 + 預算橫條。

import { useEffect, useRef, useState } from "react";
import { Download, Grid3x3, Map, Maximize2, Redo2, Trash2, Undo2, Upload } from "lucide-react";
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
  budget: { usedCoins: number; remainingCoins: number } | null;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  projectTitle: string;
  onProjectTitleChange: (title: string) => void;
  className?: string;
}

const ICON_BUTTON =
  "h-8 w-8 inline-flex items-center justify-center rounded-full transition-colors hover:bg-[rgba(0,0,0,0.06)] disabled:opacity-35 disabled:cursor-not-allowed";
const ICON = "h-4 w-4";

const SAVE_STATE_TEXT: Record<CanvasToolbarProps["saveState"], { text: string; className: string }> = {
  idle: { text: "", className: "" },
  saving: { text: "保存中…", className: "text-[rgba(0,0,0,0.5)]" },
  saved: { text: "已保存", className: "text-[rgba(0,0,0,0.45)]" },
  error: { text: "保存失败", className: "text-[#FF3B30]" },
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
  budget,
  saveState,
  projectTitle,
  onProjectTitleChange,
  className,
}: CanvasToolbarProps) {
  const [confirmingClear, setConfirmingClear] = useState(false);
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

  return (
    <div className={cn("lg-bar flex h-12 items-center gap-1.5 rounded-none border-x-0 px-3", className)}>
      <input
        aria-label="画布标题"
        value={projectTitle}
        onChange={(e) => onProjectTitleChange(e.target.value)}
        spellCheck={false}
        className="w-44 bg-transparent text-[15px] font-medium text-[rgba(0,0,0,0.85)] focus:outline-none"
      />
      <span className="mx-1 h-5 w-px shrink-0 bg-[rgba(0,0,0,0.08)]" aria-hidden="true" />

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
        className={cn(ICON_BUTTON, minimapVisible && "bg-[rgba(0,122,255,0.12)] text-[#007AFF]")}
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

      {confirmingClear ? (
        <button
          type="button"
          onClick={() => {
            setConfirmingClear(false);
            onClear();
          }}
          title="确认清空？"
          aria-label="确认清空？"
          className="inline-flex h-8 items-center justify-center rounded-full bg-[#FF3B30] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#E03126]"
        >
          确认清空？
        </button>
      ) : (
        <button type="button" onClick={() => setConfirmingClear(true)} title="清空画布" aria-label="清空画布" className={ICON_BUTTON}>
          <Trash2 className={ICON} aria-hidden="true" />
        </button>
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

      <div className="ml-auto flex items-center gap-2">
        {saveState !== "idle" && saveIndicator.text !== "" && (
          <span className={cn("text-[12px] whitespace-nowrap", saveIndicator.className)}>{saveIndicator.text}</span>
        )}
        <CanvasBudgetBar budget={budget} />
      </div>
    </div>
  );
}
