"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Coins,
  Download,
  Library,
  Loader2,
  Mic2,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAudioItem } from "@/lib/agent-chat-types";
import { viewAssetFromAudioItem } from "@/lib/viewer/from-items";
import { Viewer } from "@/components/viewer/Viewer";
import { AgentRerunMenu } from "./AgentRerunMenu";
import type { AgentMediaItem } from "./agent-artifacts-context";
import { useAgentMediaActions, useAgentMediaViewerOpen } from "./agent-viewer";

export interface AgentAudioCardProps {
  item: AgentAudioItem;
  /** 存图库：true＝已存入／本来就在；false＝失败（卡片显示短暂「未存入」）。回调缺席＝disabled。 */
  onSaveToLibrary?: (item: AgentAudioItem) => Promise<boolean>;
  /** 下载：true＝已触发下载；false/抛错＝按钮短暂「失败」。 */
  onDownload?: (item: AgentAudioItem) => Promise<boolean>;
  /**
   * 「再来 N 组」：会话级——音乐/音频同样按延迟出稿计费，payload 级重跑不开放
   * （history-rerun.ts:53 注释），只把「再来 N 组」翻成一句话丢回对话，
   * 由助理重新决定参数并走既有计费链。
   */
  onRerun?: (item: AgentAudioItem, count: number) => void;
  /** 「微调」：只把半句话预填进输入框（不自动送出＝不替使用者开一轮扣费）。 */
  onVariant?: (item: AgentAudioItem) => void;
  /** 所在合集（OpenUI 专辑/图集）：「在播放器中打开」进整个合集并停在本首。缺省＝只看本首。 */
  viewerSet?: readonly AgentMediaItem[];
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 出音频卡上的动作按钮：回调缺席时保持 disabled，沿用图片/影片卡的 Action 惯例。
 *  触控目标 44px（h-11），加 manipulation / 去高亮，避免 iOS 双击缩放与长按闪烁。 */
function AudioAction({
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

function AgentAudioCardComponent({ item, onSaveToLibrary, onDownload, onRerun, onVariant, viewerSet }: AgentAudioCardProps) {
  const [saveState, setSaveState] = useState<"idle" | "loading" | "saved" | "failed">("idle");
  const [downState, setDownState] = useState<"idle" | "loading" | "failed">("idle");
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

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

  // 主按钮与内联播放同源（赏阅）：动作沿用本卡 props 的回调（含「发给助理」预填），
  // 全屏在站内打开，不再跳外部 store 播放器。加载失败/重试由赏阅 Surface 自带。
  const asset = useMemo(() => viewAssetFromAudioItem(item), [item]);
  const audioSources = { audio: { onSaveToLibrary, onDownload, onRerun, onVariant } };
  const actionsFor = useAgentMediaActions(audioSources);
  const viewerActions = actionsFor([item]);
  const openMedia = useAgentMediaViewerOpen(audioSources);

  const title = item.title?.trim() ?? "";
  const cover = item.cover?.trim() ?? "";

  return (
    <figure className="agent-rise">
      {/* 抬头：有真封面才显示缩略图（绝不用默认图占位）；有真歌名才显示标题
          （缺省不摆「音频 #N」这类编号占位）。徽章说类别，两者互不冒充。 */}
      <div className="flex items-center gap-2.5 px-3.5 pt-3">
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element -- 上游封面 URL（store 来源），无需 next/image 优化
          <img
            src={cover}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-11 w-11 shrink-0 rounded-[10px] bg-black/[0.05] object-cover"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          {title && (
            <p
              className="max-w-full truncate text-ios-subhead font-semibold text-foreground"
              title={title}
            >
              {title}
            </p>
          )}
          <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-ios-caption1 font-medium text-muted-foreground">
            {item.mediaKind === "music" ? "音乐" : "音频"}
          </span>
        </div>
      </div>
      <div className="px-3.5 pt-2.5">
        <div className="flex flex-col gap-2.5">
          {/* 主操作：站内全屏赏阅（滚动歌词、A-B 循环、标记→助理）。 */}
          <button
            type="button"
            onClick={() => openMedia(item, viewerSet)}
            className={cn(
              "flex min-h-12 w-full items-center justify-center gap-2 rounded-[14px]",
              "bg-ios-blue text-white text-ios-subhead font-semibold",
              "shadow-[0_1px_0_rgba(255,255,255,0.18)_inset] transition-colors duration-200",
              "hover:bg-ios-blue/90 active:scale-[0.98]",
              "focus:outline-none focus:ring-2 focus:ring-ios-blue/30",
              "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
            )}
          >
            <Mic2 className="h-4.5 w-4.5" aria-hidden="true" />
            在播放器中打开
          </button>
          {/* 次要：内联赏阅，不离开对话即可试听/标记。 */}
          <Viewer
            asset={asset}
            density="inline"
            actions={viewerActions}
            onOpenFull={viewerSet ? () => openMedia(item, viewerSet) : undefined}
          />
        </div>
      </div>
      {item.lyricStatus === "aligning" && (
        <p className="flex items-center gap-1.5 px-3.5 pt-2 text-ios-caption1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          歌词对齐中，完成后自动更新
        </p>
      )}
      {item.costCoins !== undefined && (
        <figcaption className="flex items-center gap-1 px-3.5 pt-2.5 text-ios-footnote text-muted-foreground">
          <Coins className="h-3.5 w-3.5" aria-hidden="true" />
          消耗 {formatCoins(item.costCoins)} 金币
        </figcaption>
      )}
      <div className="mt-1 flex flex-wrap gap-1 px-3.5 pb-3">
        <AudioAction
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
        </AudioAction>
        <AudioAction
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
        </AudioAction>
        {/* 音频走会话级重跑（见 props 注释）：N 组档位与历史卡同源；回调缺席＝disabled。
            选单本体是触发钮的兄弟（AgentRerunMenu 内部自有 relative 容器），不嵌套 button。 */}
        <AgentRerunMenu
          label="再来 N 组"
          disabled={!onRerun}
          onPick={(count) => onRerun?.(item, count)}
        />
        <AudioAction label="微调" disabled={!onVariant} onClick={() => onVariant?.(item)}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </AudioAction>
      </div>
    </figure>
  );
}

export const AgentAudioCard = memo(AgentAudioCardComponent);
