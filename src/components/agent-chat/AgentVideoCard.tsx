"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Coins, Download, Library, RotateCw, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentVideoItem } from "@/lib/agent-chat-types";
import { AgentRerunMenu } from "./AgentRerunMenu";

export interface AgentVideoCardProps {
  item: AgentVideoItem;
  /** 存图库：由 AgentChatSurface 的 videoActions 接线（影片落 mediaUrl）。
   *  回调缺席时仍保持 disabled，绝不伪造行为。 */
  onSaveToLibrary?: (item: AgentVideoItem) => void;
  onDownload?: (item: AgentVideoItem) => void;
  /**
   * 「再来 N 组」：會話級——把「再來 N 組」翻成一句話丟回對話，由助理重新決定參數
   * 並走既有計費鏈。影片按秒計費，payload 級重跑的估價口徑不同
   * （history-rerun.ts:53 註釋），所以不走 /api/generation-jobs 那條。
   */
  onRerun?: (item: AgentVideoItem, count: number) => void;
  /** 「微调」：只把半句話預填進輸入框（不自動送出＝不替使用者開一輪扣費）。 */
  onVariant?: (item: AgentVideoItem) => void;
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 出片卡上的动作按钮：回调缺席时保持 disabled，沿用图片卡的 ImageAction 惯例。
 *  触控目标 44px（h-11），加 manipulation / 去高亮，避免 iOS 双击缩放与长按闪烁。 */
function VideoAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote text-muted-foreground transition-colors",
        "enabled:hover:bg-white/60 enabled:hover:text-foreground/70",
        "disabled:cursor-not-allowed disabled:text-foreground/45",
        "focus:outline-none focus:ring-2 focus:ring-ios-blue/30",
        "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
      )}
    >
      {children}
      {label}
    </button>
  );
}

/** 全屏影片播放器：黑底置中、原生 controls 播放、右上关闭、底部下载。
 *  关闭走三条路：点背景 / Esc / Android 返回键（history pushState + popstate，
 *  与图片 Lightbox 同惯例）。影片不做捏合缩放/拖动平移——对播放中的影片无意义。 */
function VideoLightbox({
  src,
  onClose,
  onDownload,
}: {
  src: string;
  onClose: () => void;
  onDownload?: () => void;
}) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // 打开期间锁背景滚动（存原值，关闭时还原）；焦点进关闭按钮。
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Esc 关闭 + Android 返回键关闭（history 弹层惯例，与图片查看器一致）。
  useEffect(() => {
    window.history.pushState({ agentVideoLightbox: true }, "");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPop = () => onClose();
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="影片查看器"
      className="fixed inset-0 z-[95] flex min-h-[100dvh] select-none items-center justify-center bg-[rgba(18,20,28,0.92)] backdrop-blur-xl [-webkit-tap-highlight-color:transparent] motion-safe:animate-lg-appear motion-reduce:animate-none"
      onClick={onClose}
    >
      <button
        ref={closeBtnRef}
        type="button"
        aria-label="关闭"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.14] text-white backdrop-blur-md transition-colors duration-200 hover:bg-white/[0.24] focus:outline-none focus:ring-2 focus:ring-white/50 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
      {/* 点击影片/控制列不冒泡到背景，不误关查看器。 */}
      <div
        className="flex max-h-full max-w-full items-center justify-center"
        onClick={(event) => event.stopPropagation()}
      >
        <video
          src={src}
          controls
          autoPlay
          playsInline
          className="max-h-[82dvh] max-w-[92vw] rounded-[1.5rem] bg-black object-contain"
        />
      </div>
      <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-center">
        <button
          type="button"
          aria-label="下载"
          title="下载"
          disabled={!onDownload}
          onClick={(event) => {
            event.stopPropagation();
            onDownload?.();
          }}
          className={cn(
            "flex h-11 items-center gap-1.5 rounded-full bg-white/[0.14] px-4 text-ios-subhead font-medium text-white backdrop-blur-md transition-colors duration-200",
            "enabled:hover:bg-white/[0.24] active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-white/50",
            "disabled:cursor-not-allowed disabled:text-white/40",
            "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
          )}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          下载
        </button>
      </div>
    </div>,
    document.body,
  );
}

function AgentVideoCardComponent({ item, onSaveToLibrary, onDownload, onRerun, onVariant }: AgentVideoCardProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const triggerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // 上一次按压的时长（毫秒）。click 由它判定是否「长按唤菜单后松手」。
  const pressRef = useRef<{ dt: number; t: number } | null>(null);

  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openViewer = useCallback(() => {
    // 内嵌的可能正在播：进全屏前先停掉，避免两处声音叠着放。
    videoRef.current?.pause();
    setViewerOpen(true);
  }, []);

  // item.url 变化（同实例换片）时重置加载态，避免旧片的 loaded/failed 串台。
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [item.url]);

  const handleRetry = () => {
    setFailed(false);
    setLoaded(false);
    setRetryKey((k) => k + 1);
  };

  return (
    <figure className="agent-rise">
      {/* 灰底只刷在媒体面这一层（与图片卡同惯例：媒体 `overflow-hidden
          rounded-[18px] bg-black/[0.03]`，动作条落在页面白底上），不再叠两层灰。 */}
      <div
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-label="查看影片"
        className="group relative aspect-video max-h-[min(420px,52dvh)] w-full cursor-zoom-in select-none overflow-hidden rounded-[18px] bg-black/[0.03] [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
        onPointerDown={() => {
          pressRef.current = { dt: 0, t: Date.now() };
        }}
        onPointerUp={() => {
          const p = pressRef.current;
          if (p) p.dt = Date.now() - p.t;
        }}
        onPointerCancel={() => {
          pressRef.current = null;
        }}
        onClick={() => {
          const p = pressRef.current;
          pressRef.current = null;
          if (!p || failed) return;
          // 长按会唤起系统菜单（存视频等），松手后的 click 不该把查看器也打开。
          if (p.dt > 400) return;
          openViewer();
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !failed) {
            event.preventDefault();
            openViewer();
          }
        }}
      >
        {!failed && !loaded && (
          <div className="skeleton absolute inset-0" aria-hidden="true" />
        )}
        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            </div>
            <p className="text-ios-subhead font-medium text-muted-foreground">视频加载失败</p>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleRetry();
              }}
              className="flex h-11 items-center gap-1.5 rounded-full bg-ios-blue/10 px-4 text-ios-subhead font-medium text-ios-blue backdrop-blur-[22px] transition-colors duration-200 hover:bg-ios-blue/[0.16] active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-ios-blue/30 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
            >
              <RotateCw className="h-4 w-4" aria-hidden="true" />
              重试
            </button>
          </div>
        ) : (
          <video
            key={retryKey}
            ref={videoRef}
            src={item.url}
            aria-label="智能体生成的影片"
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              "absolute inset-0 h-full w-full bg-black object-contain transition-opacity duration-300 motion-reduce:transition-none",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        )}
        {/* media_kind 徽章：film=成片、其余（含缺省）=影片。 */}
        <span
          className={cn(
            "pointer-events-none absolute left-2.5 top-2.5 rounded-full px-2 py-0.5 text-ios-caption1 font-medium backdrop-blur-md",
            failed ? "hidden" : "bg-black/55 text-white/90",
          )}
        >
          {item.mediaKind === "film" ? "成片" : "影片"}
        </span>
      </div>
      {item.costCoins !== undefined && (
        <figcaption className="flex items-center gap-1 px-3.5 pt-2.5 text-ios-footnote text-muted-foreground">
          <Coins className="h-3.5 w-3.5" aria-hidden="true" />
          消耗 {formatCoins(item.costCoins)} 金币
        </figcaption>
      )}
      <div className="mt-1 flex flex-wrap gap-1 px-3.5 pb-3">
        <VideoAction label="存图库" disabled={!onSaveToLibrary} onClick={() => onSaveToLibrary?.(item)}>
          <Library className="h-3.5 w-3.5" aria-hidden="true" />
        </VideoAction>
        <VideoAction label="下载" disabled={!onDownload} onClick={() => onDownload?.(item)}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </VideoAction>
        {/* 影片走會話級重跑（見 props 註釋）：N 組檔位與歷史卡同源；回調缺席＝disabled。
            選單本體是觸發鈕的兄弟（AgentRerunMenu 內部自有 relative 容器），不嵌套 button。 */}
        <AgentRerunMenu
          label="再来 N 组"
          disabled={!onRerun}
          onPick={(count) => onRerun?.(item, count)}
        />
        <VideoAction label="微调" disabled={!onVariant} onClick={() => onVariant?.(item)}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </VideoAction>
      </div>
      {viewerOpen &&
        createPortal(
          <VideoLightbox src={item.url} onClose={closeViewer} onDownload={onDownload ? () => onDownload(item) : undefined} />,
          document.body,
        )}
    </figure>
  );
}

export const AgentVideoCard = memo(AgentVideoCardComponent);
