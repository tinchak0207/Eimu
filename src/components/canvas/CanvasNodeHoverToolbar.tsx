"use client";

// CanvasNodeHoverToolbar —— 節點 hover 時右上角的快速工具條。
//
// 只放高頻動作（編輯/重跑/連線/下載/編輯圖片/超分/主圖/刪除），低頻與批次
// 動作進右鍵選單。回呼未提供 = 按鈕不渲染——工具條永遠只長出真的能用的按鈕
// （誠實原則：不擺沒接線的裝飾按鈕）。

import { useCallback } from "react";
import { Crop, Download, Edit2, Link2, RefreshCw, Sparkles, Star, Trash2 } from "lucide-react";

export interface CanvasNodeHoverToolbarProps {
  nodeId: string;
  scale: number;
  isSelected: boolean;
  onEdit?: (nodeId: string) => void;
  onRerun?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  onAddToAssetLibrary?: (nodeId: string) => void;
  onConnect?: (nodeId: string) => void;
  /** 圖片節點：下載原圖 */
  onDownload?: (nodeId: string) => void;
  /** 圖片節點：打開編輯器（裁剪/切图/抠除/旋转） */
  onEditImage?: (nodeId: string) => void;
  /** 圖片節點：高清放大（僅 https URL 圖） */
  onUpscale?: (nodeId: string) => void;
  /** 超分處理中：按鈕轉圈防重複觸發 */
  upscaling?: boolean;
  /** 批次子節點：設為主圖 */
  onSetPrimary?: (nodeId: string) => void;
}

const BUTTON_CLASS = "flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-black/10 active:bg-black/10 disabled:cursor-not-allowed disabled:opacity-40";

export function CanvasNodeHoverToolbar({
  nodeId,
  scale,
  isSelected: _isSelected,
  onEdit,
  onRerun,
  onDelete,
  onAddToAssetLibrary,
  onConnect,
  onDownload,
  onEditImage,
  onUpscale,
  upscaling = false,
  onSetPrimary,
}: CanvasNodeHoverToolbarProps) {
  // 阻止事件冒泡到畫布（避免觸發平移/選擇）
  const stopPropagation = useCallback((e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <div
      data-canvas-interactive
      className="absolute right-1 top-1 z-40 flex items-center gap-0.5 rounded-lg lg-float px-1 py-0.5"
      style={{ transform: `scale(${Math.min(1, 1 / scale)})`, transformOrigin: "top right" }}
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
      onPointerDown={stopPropagation}
      onClick={stopPropagation}
    >
      {onEdit && (
        <button className={BUTTON_CLASS} onClick={() => onEdit(nodeId)} title="编辑提示词">
          <Edit2 className="h-3.5 w-3.5" />
        </button>
      )}
      {onRerun && (
        <button className={BUTTON_CLASS} onClick={() => onRerun(nodeId)} title="重新生成">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
      {onConnect && (
        <button className={BUTTON_CLASS} onClick={() => onConnect(nodeId)} title="连线到其他节点">
          <Link2 className="h-3.5 w-3.5" />
        </button>
      )}
      {onDownload && (
        <button className={BUTTON_CLASS} onClick={() => onDownload(nodeId)} title="下载图片">
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
      {onEditImage && (
        <button className={BUTTON_CLASS} onClick={() => onEditImage(nodeId)} title="编辑图片（裁剪/切图/抠除/旋转）">
          <Crop className="h-3.5 w-3.5" />
        </button>
      )}
      {onUpscale && (
        <button className={BUTTON_CLASS} onClick={() => onUpscale(nodeId)} disabled={upscaling} title="高清放大">
          {upscaling ? (
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      {onSetPrimary && (
        <button className={BUTTON_CLASS} onClick={() => onSetPrimary(nodeId)} title="设为主图">
          <Star className="h-3.5 w-3.5" />
        </button>
      )}
      {onAddToAssetLibrary && (
        <button className={BUTTON_CLASS} onClick={() => onAddToAssetLibrary(nodeId)} title="存入素材库">
          <Star className="h-3.5 w-3.5" />
        </button>
      )}
      {onDelete && (
        <>
          <div className="mx-0.5 h-4 w-px bg-black/10" />
          <button className={BUTTON_CLASS} onClick={() => onDelete(nodeId)} title="删除节点">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
