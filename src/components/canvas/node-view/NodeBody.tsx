"use client";

// node-view/NodeBody —— 節點正文渲染（原 CanvasNodeView renderBody + renderPlaceholder）。
// switch node.type：圖/視頻/音頻 → 媒體；文本/提示詞 → 雙擊直編；角色/場景卡/配置 → 長文捲動區。
// 圖片走「直鏈 → 同源代理 → 破圖」三段鏈路（imgError/useProxy 狀態隨正文走）。
// 手勢不在此檔：捲動區的 pointer 手勢由 use-node-gestures 提供、顯式 props 傳入
// （不引入 context，避免 memo 失效）。

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Image as ImageIcon } from "lucide-react";
import { CanvasNodeType, type CanvasNode, type CanvasNodeStatus } from "@/lib/canvas/types";
import { STATUS_LABEL } from "./constants";

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

export interface NodeBodyProps {
  node: CanvasNode;
  /** 當前縮放：決定縮圖降採樣檔位 */
  scale: number;
  /** 批次收起態封面：主圖子節點的圖片 URL（宿主從 batchPrimaryImageId 解出） */
  batchPrimaryImageUrl?: string;
  batchExpanded?: boolean;
  /** A12：失敗節點就地重試（沿用保存的生成參數）。 */
  onRetry?: (nodeId: string) => void;
  /** A4：空圖片節點「生成图片」入口。 */
  onEditPrompt: (nodeId: string) => void;
  /** A11：文本節點就地編輯提交（雙擊正文觸發）。 */
  onUpdateText?: (nodeId: string, text: string) => void;
  /** 內容捲動手勢（use-node-gestures 的 scrollDrag 三件套，綁在正文捲動區上）。 */
  onScrollAreaPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onScrollAreaPointerEnd: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function NodeBody({
  node,
  scale,
  batchPrimaryImageUrl,
  batchExpanded,
  onRetry,
  onEditPrompt,
  onUpdateText,
  onScrollAreaPointerDown,
  onScrollAreaPointerMove,
  onScrollAreaPointerEnd,
}: NodeBodyProps) {
  const [imgError, setImgError] = useState(false);
  /** 是否已试过同源代理兜底（直链失败后切代理；代理也失败才落 imgError）。 */
  const [useProxy, setUseProxy] = useState(false);
  // A11：就地編輯態（null = 未在編輯）
  const [editingText, setEditingText] = useState<string | null>(null);

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

  const status: CanvasNodeStatus = node.metadata?.status ?? "idle";
  const statusLabel = STATUS_LABEL[status];

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
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
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
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
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
            onPointerDown={onScrollAreaPointerDown}
            onPointerMove={onScrollAreaPointerMove}
            onPointerUp={onScrollAreaPointerEnd}
            onPointerCancel={onScrollAreaPointerEnd}
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

  return renderBody();
}
