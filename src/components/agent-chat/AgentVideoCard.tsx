"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Coins, Download, Library, Loader2, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentVideoItem } from "@/lib/agent-chat-types";
import { viewAssetFromVideoItem } from "@/lib/viewer/from-items";
import { Viewer } from "@/components/viewer/Viewer";
import { AgentRerunMenu } from "./AgentRerunMenu";
import type { AgentMediaItem } from "./agent-artifacts-context";
import { useAgentMediaActions, useAgentMediaViewerOpen } from "./agent-viewer";

export interface AgentVideoCardProps {
  item: AgentVideoItem;
  /** 存图库：true＝已存入／本来就在；false＝失败（卡片显示短暂「未存入」）。回调缺席＝disabled。 */
  onSaveToLibrary?: (item: AgentVideoItem) => Promise<boolean>;
  /** 下载：true＝已触发下载；false/抛错＝按钮短暂「失败」。 */
  onDownload?: (item: AgentVideoItem) => Promise<boolean>;
  /**
   * 「再来 N 组」：会话级——把「再来 N 组」翻成一句话丢回对话，由助理重新决定参数
   * 并走既有计费链。影片按秒计费，payload 级重跑的估价口径不同
   * （history-rerun.ts:53 注释），所以不走 /api/generation-jobs 那条。
   */
  onRerun?: (item: AgentVideoItem, count: number) => void;
  /** 「微调」：只把半句话预填进输入框（不自动送出＝不替使用者开一轮扣费）。 */
  onVariant?: (item: AgentVideoItem) => void;
  /** 所在合集（OpenUI 图集/专辑/对比）：「放大」打开整个合集并停在本条。缺省＝只看本条。 */
  viewerSet?: readonly AgentMediaItem[];
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
  tone,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  tone?: "danger";
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
        tone === "danger" && "text-destructive enabled:hover:text-destructive enabled:hover:bg-destructive/10",
        "focus:outline-none focus:ring-2 focus:ring-ios-blue/30",
        "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
      )}
    >
      {children}
      {label}
    </button>
  );
}

function AgentVideoCardComponent({ item, onSaveToLibrary, onDownload, onRerun, onVariant, viewerSet }: AgentVideoCardProps) {
  const [saveState, setSaveState] = useState<"idle" | "loading" | "saved" | "failed">("idle");
  const [downState, setDownState] = useState<"idle" | "loading" | "failed">("idle");
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // 内联播放与全屏同源（赏阅 Viewer）：标记/倍速/逐帧、加载失败与重试都由 Surface 自带；
  // 动作沿用本卡 props 的回调（含「发给助理」预填），点「放大」进站内全屏赏阅。
  const asset = useMemo(() => viewAssetFromVideoItem(item), [item]);
  const videoSources = { video: { onSaveToLibrary, onDownload, onRerun, onVariant } };
  const actionsFor = useAgentMediaActions(videoSources);
  const viewerActions = actionsFor([item]);
  const openMedia = useAgentMediaViewerOpen(videoSources);

  const flash = useCallback((apply: () => void, revert: () => void, delayMs: number) => {
    apply();
    timersRef.current.push(setTimeout(revert, delayMs));
  }, []);
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
    };
  }, []);

  const handleSave = useCallback(async () => {
    if (!onSaveToLibrary || saveState === "loading" || saveState === "saved") return;
    setSaveState("loading");
    let ok = false;
    try {
      ok = await onSaveToLibrary(item);
    } catch {
      ok = false;
    }
    if (ok) {
      setSaveState("saved");
      return;
    }
    flash(() => setSaveState("failed"), () => setSaveState((s) => (s === "failed" ? "idle" : s)), 2000);
  }, [item, onSaveToLibrary, saveState, flash]);

  const handleDownload = useCallback(async () => {
    if (!onDownload || downState === "loading") return;
    setDownState("loading");
    let ok = false;
    try {
      ok = await onDownload(item);
    } catch {
      ok = false;
    }
    if (ok) {
      setDownState("idle");
      return;
    }
    flash(() => setDownState("failed"), () => setDownState((s) => (s === "failed" ? "idle" : s)), 2000);
  }, [item, onDownload, downState, flash]);

  return (
    <figure className="agent-rise">
      {/* 媒体面＝赏阅 inline；media_kind 徽章（film=成片、其余含缺省=影片）叠在左上。 */}
      <div className="relative">
        <Viewer
          asset={asset}
          density="inline"
          actions={viewerActions}
          // 在合集里时「放大」进整个合集（可切成员）；单条走 Viewer 默认路径。
          onOpenFull={viewerSet ? () => openMedia(item, viewerSet) : undefined}
          className="max-h-[min(420px,52dvh)]"
        />
        <span className="pointer-events-none absolute left-2.5 top-2.5 z-10 rounded-full bg-black/55 px-2 py-0.5 text-ios-caption1 font-medium text-white/90 backdrop-blur-md">
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
        <VideoAction
          label={saveState === "saved" ? "已存" : saveState === "failed" ? "未存入" : "存图库"}
          disabled={!onSaveToLibrary || saveState === "loading" || saveState === "saved"}
          tone={saveState === "failed" ? "danger" : undefined}
          onClick={() => void handleSave()}
        >
          {saveState === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : saveState === "saved" ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Library className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </VideoAction>
        <VideoAction
          label={downState === "failed" ? "失败" : "下载"}
          disabled={!onDownload || downState === "loading"}
          tone={downState === "failed" ? "danger" : undefined}
          onClick={() => void handleDownload()}
        >
          {downState === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </VideoAction>
        {/* 影片走会话级重跑（见 props 注释）：N 组档位与历史卡同源；回调缺席＝disabled。
            选单本体是触发钮的兄弟（AgentRerunMenu 内部自有 relative 容器），不嵌套 button。 */}
        <AgentRerunMenu
          label="再来 N 组"
          disabled={!onRerun}
          onPick={(count) => onRerun?.(item, count)}
        />
        <VideoAction label="微调" disabled={!onVariant} onClick={() => onVariant?.(item)}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </VideoAction>
      </div>
    </figure>
  );
}

export const AgentVideoCard = memo(AgentVideoCardComponent);
