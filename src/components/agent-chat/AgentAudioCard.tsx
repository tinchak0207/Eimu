"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Coins,
  Download,
  Library,
  Loader2,
  Mic2,
  RotateCw,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAudioItem } from "@/lib/agent-chat-types";
import { guessAudioTitleFromUrl, openLyricPlayer } from "@/lib/lyric-player-url";
import { AgentRerunMenu } from "./AgentRerunMenu";

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

function AgentAudioCardComponent({ item, onSaveToLibrary, onDownload, onRerun, onVariant }: AgentAudioCardProps) {
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "loading" | "saved" | "failed">("idle");
  const [downState, setDownState] = useState<"idle" | "loading" | "failed">("idle");
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // item.url 变化（同实例换曲）时重置加载态，避免旧曲的 failed 串台。
  useEffect(() => {
    setFailed(false);
  }, [item.url]);

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

  const handleRetry = () => {
    setFailed(false);
    setRetryKey((k) => k + 1);
  };

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

  const handleOpenLyricPlayer = useCallback(() => {
    // 真歌名优先；没有就从 URL 猜一个可读档名；都没有则不传 title——
    // 播放器自会显示「未命名曲目」，绝不传「音频 #N」这类编号占位。
    const title = item.title?.trim() || guessAudioTitleFromUrl(item.url);
    openLyricPlayer({ url: item.url, title, trackId: item.id });
  }, [item.id, item.title, item.url]);

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
        {failed ? (
          <div className="flex flex-col items-center justify-center gap-3 bg-black/[0.03] p-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            </div>
            <p className="text-ios-subhead font-medium text-muted-foreground">音频加载失败</p>
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
          <div className="flex flex-col gap-2.5">
            {/* 主操作：打开已分好滚动歌词的 store 播放器（不再以浏览器默认 <audio> 为主体验）。 */}
            <button
              type="button"
              onClick={handleOpenLyricPlayer}
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
              打开滚动歌词播放器
            </button>
            {/* 次要：保留原生试听，方便不离开对话时快速确认音源。 */}
            <audio
              key={retryKey}
              src={item.url}
              aria-label="智能体生成的音频（次要试听）"
              controls
              preload="none"
              onError={() => setFailed(true)}
              className="w-full opacity-90"
            />
          </div>
        )}
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
