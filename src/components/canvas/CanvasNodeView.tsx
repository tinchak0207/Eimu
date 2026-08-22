"use client";

// 畫布單一節點：拖動 / 縮放 / 依類型渲染內文。
// 螢幕位移 → 世界位移：dx / scale。
// 互動元素（按鈕、縮放手柄、影片控制）帶 data-canvas-interactive，讓 InfiniteCanvas 平移忽略它們。
// 行動端：
//   - 內容捲動區（文本/配置長文）用 .canvas-node-scroll + touch-pan-y：可手指捲動，
//     點擊仍選取節點，但不會誤觸拖動。
//   - 拖動有 5px 死區：輕點 = 選取，明確移動才開始拖節點，避免 tap 與拖動衝突。
//   - 刪除按鈕 / 縮放手柄在 <768px 放大到 ≥44px 觸控熱區。

import { useCallback, useEffect, useRef, useState } from "react";
import { X, RefreshCw, Edit2, ChevronDown, ChevronUp, Image as ImageIcon, Download } from "lucide-react";
import { CanvasNodeHoverToolbar } from "./CanvasNodeHoverToolbar";
import { CanvasNodePromptPanel } from "./CanvasNodePromptPanel";
import { cn } from "@/lib/utils";
import { CanvasNodeType, type CanvasNode, type CanvasNodeStatus } from "@/lib/canvas/types";
import { REFERENCE_IMAGE_ROLES } from "../pro-workstation/workstation-constants";
import { toReferenceImageRole } from "@/lib/image-types";
import type { ReferenceImageRole } from "@/lib/image-types";

export interface CanvasNodeViewProps {
  node: CanvasNode;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  /** 拖動真正開始（越過死區）時觸發（供整合層推一格撤銷快照） */
  onInteractionStart?: () => void;
  onMove: (nodeId: string, position: { x: number; y: number }) => void;
  onResize?: (nodeId: string, width: number, height: number) => void;
  onDelete?: (nodeId: string) => void;
  /** P1-1: 重新生成節點 */
  onRerun?: (nodeId: string) => void;
  /** P1-2: 編輯節點參數 */
  onEdit?: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 當前縮放，拖動時要把螢幕位移換算成世界位移 */
  scale: number;
  /** 首次進場的延遲（ms）：同一批節點依序淡入，營造 agent 逐顆建構的節奏 */
  enterDelay?: number;
  /** 批次相關 */
  batchExpanded?: boolean;
  batchChildCount?: number;
  onToggleBatch?: (nodeId: string) => void;
  /** 編輯面板（prompt 面板） */
  onEditPrompt: (nodeId: string) => void;
  promptPanelOpen: boolean;
  onClosePromptPanel: () => void;
  onGenerateFromNode: (nodeId: string, prompt: string, options: { model?: string; size?: string; quality?: string; count?: number }) => void;
  isGenerating: boolean;
  /** hover 工具列 */
  onAddToAssetLibrary?: (nodeId: string) => void;
  onStartConnect?: (nodeId: string) => void;
  /** 圖片動作（有 URL 的圖片節點才由宿主傳入） */
  onDownload?: (nodeId: string) => void;
  onEditImage?: (nodeId: string) => void;
  onUpscale?: (nodeId: string) => void;
  upscaling?: boolean;
  /** 批次子節點：設為主圖 */
  onSetPrimary?: (nodeId: string) => void;
  /** 批次父節點：下載全部子圖（zip） */
  onDownloadAll?: (nodeId: string) => void;
  /** 收起態封面：主圖子節點的圖片 URL（宿主從 batchPrimaryImageId 解出） */
  batchPrimaryImageUrl?: string;
  /** 節點右鍵選單（座標 = viewport client 座標，由宿主轉容器座標） */
  onNodeContextMenu?: (nodeId: string, clientX: number, clientY: number) => void;
  /** @引用（透傳給內嵌 prompt 面板） */
  referenceCandidates?: { nodeId: string; title: string; previewUrl: string }[];
  selectedReferenceIds?: string[];
  onToggleReference?: (referenceNodeId: string) => void;
  /** A1：port 拖線起點（節點左右緣圓點按下）。 */
  onStartPortDrag?: (nodeId: string, side: "left" | "right", clientX: number, clientY: number) => void;
  /** A7：hover 上報（宿主做鄰接高亮）。 */
  onHoverChange?: (nodeId: string, hovered: boolean) => void;
  /** A7：與 hover/選中節點相鄰 → 淡藍 ring。 */
  adjacent?: boolean;
  /** A10：標題就地重命名（雙擊標題觸發）。 */
  onRename?: (nodeId: string, title: string) => void;
  /** A11：文本節點就地編輯提交（雙擊正文觸發）。 */
  onUpdateText?: (nodeId: string, text: string) => void;
  /** reference 節點角色切換（復用 ReferenceImageRole 枚舉）。 */
  onUpdateReferenceRole?: (nodeId: string, role: ReferenceImageRole) => void;
  /** A12：失敗節點就地重試（沿用保存的生成參數）。 */
  onRetry?: (nodeId: string) => void;
  /** A2：乾淨點擊（選取且未拖動）——宿主用它「點選即開面板」。 */
  onNodeClick?: (nodeId: string) => void;
  /** 內嵌 prompt 面板的透傳（W2 新增能力） */
  onStopGenerate?: () => void;
  onOpenPromptLibrary?: () => void;
}

const MIN_WIDTH = 120;
const MIN_HEIGHT = 90;
/** 螢幕 px 死區：低於此距離視為點選而非拖動 */
const MOVE_THRESHOLD_PX = 5;

const STATUS_COLOR: Record<CanvasNodeStatus, string> = {
  idle: "bg-black/20",
  success: "bg-ios-green",
  loading: "bg-ios-blue",
  error: "bg-destructive",
};

const STATUS_LABEL: Record<CanvasNodeStatus, string> = {
  idle: "待处理",
  loading: "生成中…",
  success: "已完成",
  error: "失败",
};

const TYPE_LABEL: Record<CanvasNodeType, string> = {
  [CanvasNodeType.Image]: "图片",
  [CanvasNodeType.Text]: "文本",
  [CanvasNodeType.Config]: "生成配置",
  [CanvasNodeType.Video]: "视频",
  [CanvasNodeType.Group]: "组",
  [CanvasNodeType.CharacterCard]: "角色卡",
  [CanvasNodeType.SceneCard]: "场景卡",
  [CanvasNodeType.Audio]: "音频",
  [CanvasNodeType.Prompt]: "提示词",
  [CanvasNodeType.Reference]: "参考图",
};

function isUrl(value: string): boolean {
  return value.startsWith("http") || value.startsWith("data:");
}

/** B3：縮略圖降採樣——小尺寸顯示時走 next/image 優化器（僅 Blob 存儲域，
 *  next.config 已放行），省流量提幀率；其餘 URL 原樣。競品沒有這條。 */
function thumbUrl(url: string, displayWidth: number): string {
  if (!url.startsWith("https://") || displayWidth >= 300) return url;
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith(".public.blob.vercel-storage.com")) return url;
  } catch {
    return url;
  }
  const w = displayWidth < 150 ? 256 : 384;
  return `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=70`;
}

/** 直链加载失败后的同源代理兜底（上游 CDN 可能要登录/过期/CORS，代理 302 拉回）。 */
function proxySrc(url: string): string {
  return `/api/canvas/image-proxy?url=${encodeURIComponent(url)}`;
}

/** 破图占位：给出明确失败提示 + 重新加载入口（网络抖动/临时签名过期可一键恢复）。
 * 因为图片其实可能只是临时加载失败，绝不把它伪装成生成失败。 */
function renderBrokenImage(onRetry: () => void): React.ReactNode {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3">
      <ImageIcon className="h-8 w-8 text-foreground/45" />
      <span className="text-ios-footnote font-medium text-muted-foreground">图片加载失败</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-ios-blue/10 px-3 py-1.5 text-ios-caption1 font-medium text-ios-blue transition-colors duration-150 hover:bg-ios-blue/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        重新加载
      </button>
    </div>
  );
}

function formatProgress(progress: number): string {
  const pct = progress <= 1 ? Math.round(progress * 100) : Math.round(progress);
  return `${pct}%`;
}

interface ResizeCfg {
  moveX: boolean;
  moveY: boolean;
}

const RESIZE_HANDLES: { id: string; pos: React.CSSProperties; cfg: ResizeCfg }[] = [
  { id: "nw", pos: { left: 0, top: 0, cursor: "nwse-resize" }, cfg: { moveX: true, moveY: true } },
  { id: "ne", pos: { right: 0, top: 0, cursor: "nesw-resize" }, cfg: { moveX: false, moveY: true } },
  { id: "sw", pos: { left: 0, bottom: 0, cursor: "nesw-resize" }, cfg: { moveX: true, moveY: false } },
  { id: "se", pos: { right: 0, bottom: 0, cursor: "nwse-resize" }, cfg: { moveX: false, moveY: false } },
];

export function CanvasNodeView({
  node,
  selected,
  onSelect,
  onInteractionStart,
  onMove,
  onResize,
  onDelete,
  onRerun,
  onEdit,
  scale,
  enterDelay = 0,
  batchExpanded,
  batchChildCount,
  onToggleBatch,
  onEditPrompt,
  promptPanelOpen,
  onClosePromptPanel,
  onGenerateFromNode,
  isGenerating,
  onAddToAssetLibrary,
  onStartConnect,
  onDownload,
  onEditImage,
  onUpscale,
  upscaling,
  onSetPrimary,
  onDownloadAll,
  batchPrimaryImageUrl,
  onNodeContextMenu,
  referenceCandidates,
  selectedReferenceIds,
  onToggleReference,
  onStartPortDrag,
  onHoverChange,
  adjacent,
  onRename,
  onUpdateText,
  onUpdateReferenceRole,
  onRetry,
  onNodeClick,
  onStopGenerate,
  onOpenPromptLibrary,
}: CanvasNodeViewProps) {
  const [mounted, setMounted] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [imgError, setImgError] = useState(false);
  /** 是否已试过同源代理兜底（直链失败后切代理；代理也失败才落 imgError）。 */
  const [useProxy, setUseProxy] = useState(false);
  // A10/A11：就地編輯態（null = 未在編輯）
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    cfg: ResizeCfg;
  } | null>(null);
  // 內容捲動（行動端）：InfiniteCanvas 在容器上設 touch-action:none，
  // 瀏覽器原生觸控捲動會被祖先攔截，這裡用 Pointer Events 自己捲。
  const scrollDragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 圖片 URL 變更時重置錯誤狀態，重新走「直鏈 → 代理 → 破圖」鏈路
  useEffect(() => {
    setImgError(false);
    setUseProxy(false);
  }, [node.metadata?.content]);

  /** 圖片加載失敗：先切到同源代理試一次，代理也失敗才宣告破圖。 */
  const handleImgError = useCallback(() => {
    setUseProxy((prev) => {
      if (!prev) return true; // 首次失敗 → 切代理
      setImgError(true); // 代理也失敗 → 破圖
      return prev;
    });
  }, []);

  /** 破圖後手動重試：清掉錯誤標記，重新從直鏈開始加載。 */
  const handleRetryImage = useCallback(() => {
    setImgError(false);
    setUseProxy(false);
  }, []);

  const handleScrollAreaDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    // 內容沒溢出就不劫持手勢（讓根節點的選取/拖動照常）。
    if (el.scrollHeight <= el.clientHeight + 1) return;
    scrollDragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startScrollTop: el.scrollTop,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer 已結束時 capture 會拋錯，忽略 */
    }
  };

  const handleScrollAreaMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = scrollDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dy = d.startY - e.clientY;
    if (!d.moved && Math.abs(dy) < 4) return;
    d.moved = true;
    const el = e.currentTarget;
    const k = scale > 0 ? scale : 1;
    el.scrollTop = d.startScrollTop + dy / k;
  };

  const handleScrollAreaEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = scrollDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    scrollDragRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  const status: CanvasNodeStatus = node.metadata?.status ?? "idle";
  const statusColor = STATUS_COLOR[status];
  const statusLabel = STATUS_LABEL[status];
  const typeLabel = TYPE_LABEL[node.type];

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-canvas-interactive]")) return;
    onSelect(node.id);
    // 內容捲動區：內容有溢出時只選取、不啟用拖動（交給內容自己的捲動手勢）；
    // 沒溢出則照常可拖動節點。
    const scroller = target.closest<HTMLElement>(".canvas-node-scroll");
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) return;
    const existing = dragRef.current;
    if (existing && existing.pointerId === e.pointerId) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: node.position.x,
      startY: node.position.y,
      started: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (!drag.started) {
      const dist = Math.hypot(e.clientX - drag.startPointerX, e.clientY - drag.startPointerY);
      if (dist < MOVE_THRESHOLD_PX) return;
      drag.started = true;
      onInteractionStart?.();
    }
    const dx = (e.clientX - drag.startPointerX) / scale;
    const dy = (e.clientY - drag.startPointerY) / scale;
    onMove(node.id, { x: drag.startX + dx, y: drag.startY + dy });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === e.pointerId) {
      // A2：乾淨點擊（未越過拖動死區、非取消）→ 上報 click，宿主用它開節點面板。
      const wasCleanClick = !drag.started && e.type === "pointerup";
      dragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (wasCleanClick) onNodeClick?.(node.id);
    }
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>, cfg: ResizeCfg) => {
    e.stopPropagation();
    onSelect(node.id);
    onInteractionStart?.();
    resizeRef.current = {
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: node.position.x,
      startY: node.position.y,
      startWidth: node.width,
      startHeight: node.height,
      cfg,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const handleResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    const dx = (e.clientX - r.startPointerX) / scale;
    const dy = (e.clientY - r.startPointerY) / scale;
    const width = Math.max(MIN_WIDTH, r.startWidth + (r.cfg.moveX ? -dx : dx));
    const height = Math.max(MIN_HEIGHT, r.startHeight + (r.cfg.moveY ? -dy : dy));
    const x = r.cfg.moveX ? r.startX + (r.startWidth - width) : r.startX;
    const y = r.cfg.moveY ? r.startY + (r.startHeight - height) : r.startY;
    onMove(node.id, { x, y });
    onResize?.(node.id, width, height);
  };

  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) {
      resizeRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(node.id);
    }
  };

  const renderPlaceholder = (statusValue: CanvasNodeStatus, metadata: CanvasNode["metadata"]) => {
    if (statusValue === "loading") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3">
          <div
            className="h-5 w-5 animate-spin rounded-full border-2 border-black/15 border-t-ios-blue motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="text-ios-subhead text-muted-foreground">生成中…</span>
          {typeof metadata?.progress === "number" && (
            <span className="text-ios-footnote tabular-nums text-foreground/45">{formatProgress(metadata.progress)}</span>
          )}
        </div>
      );
    }
    if (statusValue === "error") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-3">
          <span className="text-ios-subhead font-medium text-destructive">失败</span>
          {metadata?.errorDetails ? (
            <span className="max-sm:text-ios-footnote break-words text-center text-ios-caption1 leading-snug text-destructive">
              {metadata.errorDetails}
            </span>
          ) : null}
          {onRetry && (
            <button
              type="button"
              data-canvas-interactive
              onClick={(e) => {
                e.stopPropagation();
                onRetry(node.id);
              }}
              className="mt-1 flex items-center gap-1 rounded-full bg-destructive/10 px-3 py-1 text-ios-caption1 font-medium text-destructive hover:bg-destructive/15"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              重试
            </button>
          )}
        </div>
      );
    }
    // reference 節點空態：等待填入圖片（agent 建的空殼或數據異常）。
    if (node.type === CanvasNodeType.Reference && statusValue === "idle") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
          <ImageIcon className="h-7 w-7 text-foreground/45" aria-hidden="true" />
          <span className="text-ios-caption1 text-muted-foreground">参考图 · 等待填入图片</span>
        </div>
      );
    }
    // A4：空圖片節點是生成落地位——給一個顯眼入口，點開面板就地生成回填。
    if (node.type === CanvasNodeType.Image && statusValue === "idle") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
          <ImageIcon className="h-7 w-7 text-foreground/45" aria-hidden="true" />
          <button
            type="button"
            data-canvas-interactive
            onClick={(e) => {
              e.stopPropagation();
              onEditPrompt(node.id);
            }}
            className="rounded-full bg-primary px-3.5 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-85"
          >
            生成图片
          </button>
          <span className="text-[11.5px] text-muted-foreground">结果将直接填入此节点</span>
        </div>
      );
    }
    // idle：骨架屏取代死白 —— 卡片一出生就有結構感，不是一塊「待处理」空白。
    return (
      <div className="flex flex-1 flex-col justify-center gap-2.5 p-4" aria-label={statusLabel}>
        <div className="h-3 w-3/4 animate-pulse rounded-full bg-black/5 motion-reduce:animate-none" />
        <div className="h-3 w-1/2 animate-pulse rounded-full bg-black/5 [animation-delay:120ms] motion-reduce:animate-none" />
        <div className="h-3 w-2/3 animate-pulse rounded-full bg-black/5 [animation-delay:240ms] motion-reduce:animate-none" />
        <span className="mt-1 text-ios-caption1 text-muted-foreground">{statusLabel} · 等待 agent 填充</span>
      </div>
    );
  };

  const renderBody = () => {
    const metadata = node.metadata;
    // 批次收起態封面：主圖頂上，本體內容讓位（展開一鍵可回）。
    // 只在節點自己沒有圖片內容時接管，避免蓋掉圖生圖來源圖。
    const ownImage =
      (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) && metadata?.content && isUrl(metadata.content);
    if (batchPrimaryImageUrl && batchExpanded === false && !ownImage) {
      if (imgError) {
        return renderBrokenImage(handleRetryImage);
      }
      return (
        <img
          src={useProxy && batchPrimaryImageUrl.startsWith("http") ? proxySrc(batchPrimaryImageUrl) : batchPrimaryImageUrl}
          alt={`${node.title} 主图`}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover"
          onError={handleImgError}
        />
      );
    }
    switch (node.type) {
      case CanvasNodeType.Image:
      case CanvasNodeType.Reference:
      case CanvasNodeType.Video: {
        const content = metadata?.content;
        if (content && isUrl(content)) {
          if (node.type === CanvasNodeType.Video) {
            return <video src={content} controls className="h-full w-full object-cover" data-canvas-interactive />;
          }
          if (imgError) {
            return renderBrokenImage(handleRetryImage);
          }
          const rawContent = content.startsWith("data:") ? content : thumbUrl(content, node.width * scale);
          return (
            <img
              src={useProxy && content.startsWith("http") ? proxySrc(content) : rawContent}
              alt={node.title}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="h-full w-full object-cover"
              onError={handleImgError}
            />
          );
        }
        return renderPlaceholder(status, metadata);
      }
      case CanvasNodeType.Audio: {
        const content = metadata?.content;
        if (content && isUrl(content)) {
          return (
            <div className="flex flex-1 items-center justify-center p-3">
              <audio src={content} controls className="w-full" data-canvas-interactive />
            </div>
          );
        }
        return renderPlaceholder(status, metadata);
      }
      case CanvasNodeType.CharacterCard:
      case CanvasNodeType.SceneCard: {
        const description = metadata?.description ?? metadata?.content ?? "";
        const features = metadata?.key_features ?? [];
        return (
          <div
            onPointerDown={handleScrollAreaDown}
            onPointerMove={handleScrollAreaMove}
            onPointerUp={handleScrollAreaEnd}
            onPointerCancel={handleScrollAreaEnd}
            className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-2 overflow-auto p-3"
          >
            {metadata?.locked && (
              <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-ios-caption2 font-medium text-muted-foreground">
                已锁定 · 结果不再重生成
              </span>
            )}
            {description.trim() ? (
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-muted-foreground">{description}</p>
            ) : (
              <span className="text-ios-caption1 text-muted-foreground">（未填写描述）</span>
            )}
            {features.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {features.map((f) => (
                  <span key={f} className="rounded-full bg-ios-blue/10 px-2 py-0.5 text-[11.5px] text-ios-blue">
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      }
      case CanvasNodeType.Text:
      case CanvasNodeType.Prompt: {
        const text = metadata?.content ?? metadata?.prompt;
        const fontSize = typeof metadata?.fontSize === "number" ? metadata.fontSize : 14.5;
        // prompt 節點 = 提示詞備忘：雙擊直編（與文本節點同款交互），文案不同。
        const emptyHint = node.type === CanvasNodeType.Prompt ? "（未填写提示词，双击编辑）" : "（未填写内容，双击编辑）";
        // A11：雙擊直編。textarea 蓋滿正文區，blur/Ctrl+Enter 提交、Esc 取消。
        if (editingText !== null) {
          return (
            <textarea
              data-canvas-interactive
              autoFocus
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  setEditingText(null);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  if (editingText !== (text ?? "")) onUpdateText?.(node.id, editingText);
                  setEditingText(null);
                }
              }}
              onBlur={() => {
                if (editingText !== (text ?? "")) onUpdateText?.(node.id, editingText);
                setEditingText(null);
              }}
              className="flex-1 resize-none whitespace-pre-wrap break-words border-0 bg-ios-blue/5 p-3 leading-relaxed text-foreground outline-none"
              style={{ fontSize }}
              aria-label="编辑文本内容"
            />
          );
        }
        return (
          <div
            onPointerDown={handleScrollAreaDown}
            onPointerMove={handleScrollAreaMove}
            onPointerUp={handleScrollAreaEnd}
            onPointerCancel={handleScrollAreaEnd}
            onDoubleClick={(e) => {
              if (!onUpdateText) return;
              e.stopPropagation();
              setEditingText(text ?? "");
            }}
            title={onUpdateText ? "双击编辑文字" : undefined}
            className="canvas-node-scroll touch-pan-y overscroll-contain overflow-auto whitespace-pre-wrap break-words p-3 leading-relaxed text-foreground"
            style={{ fontSize }}
          >
            {text?.trim() ? (
              text
            ) : (
              <span className="text-ios-caption1 text-muted-foreground">{emptyHint}</span>
            )}
          </div>
        );
      }
      case CanvasNodeType.Config: {
        const rows: { label: string; value: string }[] = [];
        if (metadata?.model) rows.push({ label: "模型", value: metadata.model });
        if (metadata?.size) rows.push({ label: "尺寸", value: metadata.size });
        if (metadata?.quality) rows.push({ label: "质量", value: metadata.quality });
        if (typeof metadata?.count === "number") rows.push({ label: "数量", value: String(metadata.count) });
        if (metadata?.kind) rows.push({ label: "类型", value: metadata.kind });
        if (metadata?.source_image) rows.push({ label: "参考图", value: metadata.source_image });
        if (rows.length === 0) {
          // 配置未到齊 = 讀取中的骨架，不是死掉的「（未配置）」。
          return renderPlaceholder(status, metadata);
        }
        return (
          <div
            onPointerDown={handleScrollAreaDown}
            onPointerMove={handleScrollAreaMove}
            onPointerUp={handleScrollAreaEnd}
            onPointerCancel={handleScrollAreaEnd}
            className="canvas-node-scroll touch-pan-y overscroll-contain flex-1 space-y-1 overflow-auto p-3"
          >
            {rows.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-[12.5px] font-medium text-muted-foreground">{row.label}</span>
                <span className="min-w-0 max-sm:text-ios-subhead truncate font-mono text-ios-footnote text-muted-foreground">
                  {row.value}
                </span>
              </div>
            ))}
          </div>
        );
      }
      case CanvasNodeType.Group:
        return (
          <div className="m-3 flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-black/10">
            <span className="px-3 text-center text-ios-footnote font-medium text-muted-foreground">{node.title}</span>
          </div>
        );
    }
  };

  const showCostBadge =
    (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) &&
    typeof node.metadata?.cost_coins === "number";

  return (
    <div
      data-canvas-node={node.id}
      role="button"
      tabIndex={0}
      aria-label={`画布节点：${node.title}，${statusLabel}`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => {
        setIsHovered(true);
        onHoverChange?.(node.id, true);
      }}
      onPointerLeave={() => {
        setIsHovered(false);
        onHoverChange?.(node.id, false);
      }}
      onContextMenu={(e) => {
        // 節點右鍵：交宿主開選單（統一擋掉瀏覽器原生選單）。
        e.preventDefault();
        e.stopPropagation();
        onNodeContextMenu?.(node.id, e.clientX, e.clientY);
      }}
      className={cn(
        "absolute touch-manipulation select-none transition-[opacity,transform] duration-300 ease-out",
        "[-webkit-tap-highlight-color:transparent]",
        "motion-reduce:translate-y-0 motion-reduce:transition-none",
        mounted ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: node.width,
        height: node.height,
        transitionDelay: `${enterDelay}ms`,
      }}
    >
      {/* 批次收起態：堆疊視覺（卡片後方兩張錯位幽靈卡） */}
      {typeof batchChildCount === "number" && batchChildCount > 0 && batchExpanded === false && (
        <>
          <div className="pointer-events-none absolute inset-0 -z-10 translate-x-[6px] translate-y-[6px] rounded-2xl bg-white/70 shadow-sm" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-0 -z-20 translate-x-[12px] translate-y-[12px] rounded-2xl bg-white/45 shadow-sm" aria-hidden="true" />
        </>
      )}
      <div
        className={cn(
          "lg-card relative flex h-full flex-col overflow-hidden rounded-2xl transition-shadow duration-150",
          selected && "ring-2 ring-ios-blue/50",
          !selected && adjacent && "ring-2 ring-ios-blue/20",
        )}
      >
        <div className={cn("h-[3px] w-full shrink-0", statusColor)} />
        <div className="flex items-center gap-2 px-3 py-2">
          {editingTitle !== null ? (
            <input
              data-canvas-interactive
              autoFocus
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  const t = editingTitle.trim();
                  if (t && t !== node.title) onRename?.(node.id, t);
                  setEditingTitle(null);
                } else if (e.key === "Escape") {
                  setEditingTitle(null);
                }
              }}
              onBlur={() => {
                const t = editingTitle.trim();
                if (t && t !== node.title) onRename?.(node.id, t);
                setEditingTitle(null);
              }}
              className="min-w-0 flex-1 rounded-md border border-ios-blue/40 bg-white px-1.5 py-0.5 text-ios-subhead font-semibold text-foreground outline-none"
              aria-label="重命名节点"
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground"
              onDoubleClick={(e) => {
                if (!onRename) return;
                e.stopPropagation();
                setEditingTitle(node.title);
              }}
              title={onRename ? "双击重命名" : undefined}
            >
              {node.title}
              {node.metadata?.role && (
                <span className="ml-2 text-ios-caption2 px-1.5 py-0.5 bg-ios-blue/15 text-ios-blue rounded">
                  {node.metadata.role}
                </span>
              )}
            </span>
          )}
          <span className="shrink-0 text-ios-caption1 text-muted-foreground">{typeLabel}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
              status === "idle" && "bg-black/5 text-muted-foreground",
              status === "success" && "bg-ios-green/15 text-[#248A3D]",
              status === "loading" && "bg-ios-blue/10 text-ios-blue",
              status === "error" && "bg-destructive/10 text-destructive",
            )}
          >
            {statusLabel}
          </span>
          {/* P1-1: 重新生成按鈕 */}
          {onRerun && (node.type === "image" || node.type === "video") && (status === "success" || status === "error") && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => onRerun(node.id)}
              title="重新生成"
              aria-label="重新生成此節點"
              className={cn(
                "shrink-0 rounded-full p-1 text-foreground/45 transition-colors",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "hover:bg-black/5 hover:text-muted-foreground",
                "max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/10",
              )}
            >
              <RefreshCw className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" aria-hidden="true" />
            </button>
          )}

          {/* P1-2: 編輯節點按鈕 */}
          {onEdit && (node.type === "image" || node.type === "video") && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => {
                const patch = {
                  prompt: node.metadata?.prompt || "",
                  model: node.metadata?.model,
                  size: node.metadata?.size,
                  shot_size: node.metadata?.shot_size || "中景",
                  camera_move: node.metadata?.camera_move || "固定",
                };
                onEdit(node.id, patch);
              }}
              title="編輯參數"
              aria-label="編輯節點參數"
              className={cn(
                "shrink-0 rounded-full p-1 text-foreground/45 transition-colors",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "hover:bg-black/5 hover:text-muted-foreground",
                "max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/10",
              )}
            >
              <Edit2 className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" aria-hidden="true" />
            </button>
          )}

          {onDelete && (
            <button
              type="button"
              data-canvas-interactive
              onClick={() => onDelete(node.id)}
              title="删除节点"
              aria-label="删除节点"
              className={cn(
                "shrink-0 rounded-full p-1 text-foreground/45 transition-colors",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "hover:bg-black/5 hover:text-muted-foreground",
                // 行動端：≥44px 觸控熱區 + 按壓回饋（行動端沒有 hover）
                "max-sm:-mr-1.5 max-sm:h-11 max-sm:w-11 max-sm:active:bg-black/10 max-sm:active:text-muted-foreground max-sm:hover:bg-transparent",
              )}
            >
              <X className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Hover 工具列 */}
        {(isHovered || selected) && !promptPanelOpen && (
          <CanvasNodeHoverToolbar
            nodeId={node.id}
            scale={scale}
            isSelected={selected}
            onEdit={onEditPrompt}
            onRerun={onRerun}
            onDelete={onDelete}
            onAddToAssetLibrary={onAddToAssetLibrary}
            onConnect={onStartConnect}
            onDownload={onDownload}
            onEditImage={onEditImage}
            onUpscale={onUpscale}
            upscaling={upscaling}
            onSetPrimary={onSetPrimary}
          />
        )}
        {/* reference 節點角色 badge：復用 REFERENCE_IMAGE_ROLES，切換即改生成請求裡的角色。 */}
        {node.type === CanvasNodeType.Reference && onUpdateReferenceRole && (
          <div
            data-canvas-interactive
            className="absolute bottom-2 left-2 z-10"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <select
              aria-label="参考图角色"
              title="参考图角色（连线生成时带入）"
              value={toReferenceImageRole(node.metadata?.referenceRole)}
              onChange={(e) => {
                e.stopPropagation();
                onUpdateReferenceRole(node.id, e.target.value as ReferenceImageRole);
              }}
              className="cursor-pointer rounded-full border-0 bg-black/60 px-2 py-0.5 text-ios-caption2 font-medium text-white outline-none"
            >
              {REFERENCE_IMAGE_ROLES.map((r) => (
                <option key={r.id} value={r.id} className="bg-white text-foreground">
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {/* 批次堆疊指示器 */}
        {typeof batchChildCount === "number" && batchChildCount > 0 && (
          <button
            data-canvas-interactive
            onClick={(e) => { e.stopPropagation(); onToggleBatch?.(node.id); }}
            className="absolute bottom-2 left-2 z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-ios-caption2 text-white"
          >
            <ImageIcon className="h-3 w-3" />
            <span>{batchChildCount}</span>
            {batchExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </button>
        )}
        <div className="relative min-h-0 flex-1">{renderBody()}</div>
        {showCostBadge && (
          <span className="pointer-events-none absolute right-2 bottom-2 rounded-full bg-black/60 px-2 py-0.5 text-[12.5px] font-medium text-white">
            {node.metadata?.cost_coins} 币
          </span>
        )}
      </div>
      {/* Prompt 面板 */}
      {promptPanelOpen && (
        <CanvasNodePromptPanel
          nodeId={node.id}
          initialPrompt={node.metadata?.prompt ?? ""}
          initialModel={node.metadata?.model}
          initialSize={node.metadata?.size ?? "1:1"}
          initialCount={node.metadata?.count ?? 1}
          isRunning={isGenerating}
          onClose={onClosePromptPanel}
          onGenerate={onGenerateFromNode}
          referenceCandidates={referenceCandidates}
          selectedReferenceIds={selectedReferenceIds}
          onToggleReference={onToggleReference}
          onStop={onStopGenerate}
          onOpenPromptLibrary={onOpenPromptLibrary}
        />
      )}
      {/* 批次子節點摘要列（展開時）：數量 + 下載全部 */}
      {batchExpanded && batchChildCount && batchChildCount > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 flex items-center justify-center gap-2 rounded-b-2xl bg-black/5 py-1"
          data-canvas-interactive
        >
          <span className="text-ios-caption2 text-foreground/45">
            {batchChildCount} 张结果
          </span>
          {onDownloadAll && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDownloadAll(node.id);
              }}
              className="flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-ios-caption2 font-medium text-ios-blue hover:bg-white"
            >
              <Download className="h-3 w-3" aria-hidden="true" />
              下载全部
            </button>
          )}
        </div>
      )}
      {/* A1：連線 port（左=入邊、右=出邊）。hover/選中時浮現，按下開始拖線。
          尺寸隨縮放反比，任何縮放級別都是 12px 視覺 + 32px 熱區。 */}
      {onStartPortDrag &&
        (isHovered || selected) &&
        (["left", "right"] as const).map((side) => (
          <div
            key={side}
            data-canvas-interactive
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onStartPortDrag(node.id, side, e.clientX, e.clientY);
            }}
            className="absolute z-20 flex cursor-crosshair items-center justify-center"
            style={{
              [side]: "calc(-16px * var(--canvas-inverse-scale, 1))",
              top: "50%",
              transform: "translateY(-50%)",
              width: "calc(32px * var(--canvas-inverse-scale, 1))",
              height: "calc(32px * var(--canvas-inverse-scale, 1))",
              touchAction: "none",
            }}
            title={side === "right" ? "拖出连线" : "拖入连线"}
            aria-label={side === "right" ? "从此节点拖出连线" : "拖入连线到此节点"}
          >
            <span
              className="rounded-full border-2 border-white bg-ios-blue shadow-sm transition-transform hover:scale-125"
              style={{
                width: "calc(12px * var(--canvas-inverse-scale, 1))",
                height: "calc(12px * var(--canvas-inverse-scale, 1))",
              }}
              aria-hidden="true"
            />
          </div>
        ))}
      {selected && onResize
        ? RESIZE_HANDLES.map((h) => (
            <div
              key={h.id}
              data-canvas-interactive
              onPointerDown={(e) => handleResizeStart(e, h.cfg)}
              onPointerMove={handleResizeMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className={cn(
                "z-10 flex touch-manipulation items-center justify-center rounded-[3px]",
                "border border-ios-blue/60 bg-ios-blue/20",
                // 行動端：44px 觸控熱區（外框隱形，靠中心小方塊提示），縮放保持世界座標不變
                "max-sm:rounded-lg max-sm:border-transparent max-sm:bg-transparent",
                "max-sm:!h-[calc(44px*var(--canvas-inverse-scale,1))] max-sm:!w-[calc(44px*var(--canvas-inverse-scale,1))]",
              )}
              style={{
                ...h.pos,
                position: "absolute",
                width: "calc(10px * var(--canvas-inverse-scale, 1))",
                height: "calc(10px * var(--canvas-inverse-scale, 1))",
              }}
            >
              <span
                className="hidden h-3 w-3 rounded-[2px] border border-ios-blue/70 bg-ios-blue/35 max-sm:block"
                aria-hidden="true"
              />
            </div>
          ))
        : null}
    </div>
  );
}
