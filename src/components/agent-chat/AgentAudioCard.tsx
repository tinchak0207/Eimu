"use client";

import { memo, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Coins, Download, Library, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAudioItem } from "@/lib/agent-chat-types";

export interface AgentAudioCardProps {
  item: AgentAudioItem;
  /** 存图库。尚未接线时为 undefined → 按钮保持 disabled，绝不伪造行为。 */
  onSaveToLibrary?: (item: AgentAudioItem) => void;
  onDownload?: (item: AgentAudioItem) => void;
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
        "flex h-11 items-center gap-1.5 rounded-full px-3.5 text-ios-subhead font-medium transition-all duration-200",
        "lg-float text-muted-foreground",
        "enabled:hover:bg-white/[0.94] active:scale-[0.97] focus:outline-none focus:ring-2 focus:ring-ios-blue/30",
        "disabled:cursor-not-allowed disabled:text-foreground/45",
        "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
      )}
    >
      {children}
      {label}
    </button>
  );
}

function AgentAudioCardComponent({ item, onSaveToLibrary, onDownload }: AgentAudioCardProps) {
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // item.url 變化（同實例換曲）時重置加載態，避免舊曲的 failed 串台。
  useEffect(() => {
    setFailed(false);
  }, [item.url]);

  const handleRetry = () => {
    setFailed(false);
    setRetryKey((k) => k + 1);
  };

  return (
    <figure className="agent-rise overflow-hidden rounded-[18px] bg-[rgba(120,120,128,0.06)]">
      {/* media_kind 徽章：music=成曲、其余（含缺省）=音频。 */}
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <span className="rounded-full bg-ios-blue/10 px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue">
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
        <figcaption className="flex items-center gap-1 px-3.5 pt-2.5 text-ios-footnote text-[rgba(120,90,20,0.85)]">
          <Coins className="h-3.5 w-3.5" aria-hidden="true" />
          消耗 {formatCoins(item.costCoins)} 金币
        </figcaption>
      )}
      <div className="flex flex-wrap gap-2 px-3.5 pb-3 pt-2.5">
        <AudioAction label="存图库" disabled={!onSaveToLibrary} onClick={() => onSaveToLibrary?.(item)}>
          <Library className="h-4 w-4" aria-hidden="true" />
        </AudioAction>
        <AudioAction label="下载" disabled={!onDownload} onClick={() => onDownload?.(item)}>
          <Download className="h-4 w-4" aria-hidden="true" />
        </AudioAction>
      </div>
    </figure>
  );
}

export const AgentAudioCard = memo(AgentAudioCardComponent);
