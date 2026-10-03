"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Coins, Download, Library, Loader2, RotateCw, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAudioItem } from "@/lib/agent-chat-types";
import { AgentRerunMenu } from "./AgentRerunMenu";

export interface AgentAudioCardProps {
  item: AgentAudioItem;
  /** 存图库：true＝已存入／本來就在；false＝失敗（卡片顯示短暫「未存入」）。回調缺席＝disabled。 */
  onSaveToLibrary?: (item: AgentAudioItem) => Promise<boolean>;
  /** 下载：true＝已觸發下載；false/拋錯＝按鈕短暫「失败」。 */
  onDownload?: (item: AgentAudioItem) => Promise<boolean>;
  /**
   * 「再来 N 组」：會話級——音樂/音頻同樣按延遲出稿計費，payload 級重跑不開放
   * （history-rerun.ts:53 註釋），只把「再來 N 組」翻成一句話丟回對話，
   * 由助理重新決定參數並走既有計費鏈。
   */
  onRerun?: (item: AgentAudioItem, count: number) => void;
  /** 「微调」：只把半句話預填進輸入框（不自動送出＝不替使用者開一輪扣費）。 */
  onVariant?: (item: AgentAudioItem) => void;
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 出音頻卡上的动作按钮：回调缺席时保持 disabled，沿用图片/影片卡的 Action 惯例。
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

  // item.url 變化（同實例換曲）時重置加載態，避免舊曲的 failed 串台。
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

  return (
    <figure className="agent-rise">
      {/* media_kind 徽章：music=成曲、其余（含缺省）=音频。 */}
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-ios-caption1 font-medium text-muted-foreground">
          {item.mediaKind === "music" ? "音乐" : "音频"}
        </span>
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
          <audio
            key={retryKey}
            src={item.url}
            aria-label="智能体生成的音频"
            controls
            preload="metadata"
            onError={() => setFailed(true)}
            className="w-full"
          />
        )}
      </div>
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
        {/* 音頻走會話級重跑（見 props 註釋）：N 組檔位與歷史卡同源；回調缺席＝disabled。
            選單本體是觸發鈕的兄弟（AgentRerunMenu 內部自有 relative 容器），不嵌套 button。 */}
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
