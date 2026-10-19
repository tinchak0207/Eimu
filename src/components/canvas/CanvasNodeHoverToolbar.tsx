"use client";

// CanvasNodeHoverToolbar —— 节点 hover 时右上角的快速工具条。
//
// 只放高频动作（编辑/重跑/连线/下载/编辑图片/超分/主图/删除），低频与批次
// 动作进右键选单。回呼未提供 = 按钮不渲染——工具条永远只长出真的能用的按钮
// （诚实原则：不摆没接线的装饰按钮）。

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
  // 阻止事件冒泡到画布（避免触发平移/选择）
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
