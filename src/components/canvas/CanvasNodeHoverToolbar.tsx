"use client";

// CanvasNodeHoverToolbar —— 节点 hover 时右上角的快速工具条。
//
// 只放高频动作（编辑/重跑/连线/下载/编辑图片/超分/主图/删除），低频与批次
// 动作进右键选单。回呼未提供 = 按钮不渲染——工具条永远只长出真的能用的按钮
// （诚实原则：不摆没接线的装饰按钮）。
//
// 触控：桌面精点维持 h-7 w-7；窄屏（max-sm）或粗指针（pointer:coarse）抬到
// 44×44，选中态常驻时桌面略增到 h-8 w-8，避免手机上一格点不中。

import { useCallback } from "react";
import { Crop, Download, Edit2, Link2, RefreshCw, Sparkles, Star, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CanvasNodeHoverToolbarProps {
  nodeId: string;
  scale: number;
  isSelected: boolean;
  onEdit?: (nodeId: string) => void;
  onRerun?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
  onAddToAssetLibrary?: (nodeId: string) => void;
  onConnect?: (nodeId: string) => void;
  /** 图片节点：下载原图 */
  onDownload?: (nodeId: string) => void;
  /** 图片节点：打开编辑器（裁剪/切图/抠除/旋转） */
  onEditImage?: (nodeId: string) => void;
  /** 图片节点：高清放大（仅 https URL 图） */
  onUpscale?: (nodeId: string) => void;
  /** 超分处理中：按钮转圈防重复触发 */
  upscaling?: boolean;
  /** 批次子节点：设为主图 */
  onSetPrimary?: (nodeId: string) => void;
}

const BUTTON_BASE =
  "flex items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-black/10 active:bg-black/10 disabled:cursor-not-allowed disabled:opacity-40 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]";

const ICON_CLASS = "h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px] [@media(pointer:coarse)]:h-[18px] [@media(pointer:coarse)]:w-[18px]";

export function CanvasNodeHoverToolbar({
  nodeId,
  scale,
  isSelected,
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
  // 阻止事件冒泡到画布（避免触发平移/选择）
  const stopPropagation = useCallback((e: React.MouseEvent | React.TouchEvent | React.PointerEvent) => {
    e.stopPropagation();
  }, []);

  const buttonClass = cn(
    BUTTON_BASE,
    // 桌面精点 28×28；选中态略增
    isSelected ? "h-8 w-8" : "h-7 w-7",
    // 窄屏或粗指针：苹果 HIG 最小 44×44
    "max-sm:h-11 max-sm:w-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
  );

  return (
    <div
      data-canvas-interactive
      className={cn(
        "absolute right-1 top-1 z-40 flex items-center gap-0.5 rounded-lg lg-float px-1 py-0.5",
        "max-sm:gap-1 max-sm:px-1.5 max-sm:py-1 [@media(pointer:coarse)]:gap-1 [@media(pointer:coarse)]:px-1.5 [@media(pointer:coarse)]:py-1",
      )}
      style={{ transform: `scale(${Math.min(1, 1 / scale)})`, transformOrigin: "top right" }}
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
      onPointerDown={stopPropagation}
      onClick={stopPropagation}
    >
      {onEdit && (
        <button type="button" className={buttonClass} onClick={() => onEdit(nodeId)} title="编辑提示词">
          <Edit2 className={ICON_CLASS} />
        </button>
      )}
      {onRerun && (
        <button type="button" className={buttonClass} onClick={() => onRerun(nodeId)} title="重新生成">
          <RefreshCw className={ICON_CLASS} />
        </button>
      )}
      {onConnect && (
        <button type="button" className={buttonClass} onClick={() => onConnect(nodeId)} title="连线到其他节点">
          <Link2 className={ICON_CLASS} />
        </button>
      )}
      {onDownload && (
        <button type="button" className={buttonClass} onClick={() => onDownload(nodeId)} title="下载图片">
          <Download className={ICON_CLASS} />
        </button>
      )}
      {onEditImage && (
        <button type="button" className={buttonClass} onClick={() => onEditImage(nodeId)} title="编辑图片（裁剪/切图/抠除/旋转）">
          <Crop className={ICON_CLASS} />
        </button>
      )}
      {onUpscale && (
        <button type="button" className={buttonClass} onClick={() => onUpscale(nodeId)} disabled={upscaling} title="高清放大">
          {upscaling ? (
            <span className="h-3 w-3 max-sm:h-4 max-sm:w-4 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
          ) : (
            <Sparkles className={ICON_CLASS} />
          )}
        </button>
      )}
      {onSetPrimary && (
        <button type="button" className={buttonClass} onClick={() => onSetPrimary(nodeId)} title="设为主图">
          <Star className={ICON_CLASS} />
        </button>
      )}
      {onAddToAssetLibrary && (
        <button type="button" className={buttonClass} onClick={() => onAddToAssetLibrary(nodeId)} title="存入素材库">
          <Star className={ICON_CLASS} />
        </button>
      )}
      {onDelete && (
        <>
          <div className="mx-0.5 h-4 w-px bg-black/10 max-sm:h-5 [@media(pointer:coarse)]:h-5" />
          <button type="button" className={buttonClass} onClick={() => onDelete(nodeId)} title="删除节点">
            <Trash2 className={ICON_CLASS} />
          </button>
        </>
      )}
    </div>
  );
}
