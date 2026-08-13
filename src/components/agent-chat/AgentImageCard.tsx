"use client";

import { memo, type ReactNode } from "react";
import { Coins, Download, ImagePlus, Library, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentImageItem } from "@/lib/agent-chat-types";

export interface AgentImageCardProps {
  item: AgentImageItem;
  /** 存图库。尚未接线时为 undefined → 按钮保持 disabled，绝不伪造行为。 */
  onSaveToLibrary?: (item: AgentImageItem) => void;
  onEdit?: (item: AgentImageItem) => void;
  onUpscale?: (item: AgentImageItem) => void;
  onDownload?: (item: AgentImageItem) => void;
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 出图卡上的动作按钮：回调缺席时保持 disabled，等 wiring 阶段补上 handler。 */
function ImageAction({
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
        "flex h-8 items-center gap-1.5 rounded-full px-3 text-ios-caption1 font-medium transition-all duration-200",
        "bg-[rgba(255,255,255,0.78)] text-[rgba(0,0,0,0.72)] backdrop-blur-[22px]",
        "hover:bg-[rgba(255,255,255,0.94)] focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.30)]",
        "disabled:cursor-not-allowed disabled:text-[rgba(0,0,0,0.28)] disabled:hover:bg-[rgba(255,255,255,0.78)]",
      )}
    >
      {children}
      {label}
    </button>
  );
}

function AgentImageCardComponent({
  item,
  onSaveToLibrary,
  onEdit,
  onUpscale,
  onDownload,
}: AgentImageCardProps) {
  return (
    <figure className="agent-rise lg-card overflow-hidden rounded-ios-2xl">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.url}
        alt="智能体生成的图片"
        loading="lazy"
        decoding="async"
        className="w-full bg-[rgba(0,0,0,0.03)] object-contain"
      />
      {item.costCoins !== undefined && (
        <figcaption className="flex items-center gap-1 px-3.5 pt-2 text-ios-caption1 text-[rgba(120,90,20,0.85)]">
          <Coins className="h-3 w-3" aria-hidden="true" />
          消耗 {formatCoins(item.costCoins)} 金币
        </figcaption>
      )}
      <div className="flex flex-wrap gap-2 px-3.5 pb-3 pt-2">
        <ImageAction label="存图库" disabled={!onSaveToLibrary} onClick={() => onSaveToLibrary?.(item)}>
          <Library className="h-3.5 w-3.5" aria-hidden="true" />
        </ImageAction>
        <ImageAction label="改图" disabled={!onEdit} onClick={() => onEdit?.(item)}>
          <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
        </ImageAction>
        <ImageAction label="放大" disabled={!onUpscale} onClick={() => onUpscale?.(item)}>
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </ImageAction>
        <ImageAction label="下载" disabled={!onDownload} onClick={() => onDownload?.(item)}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </ImageAction>
      </div>
    </figure>
  );
}

export const AgentImageCard = memo(AgentImageCardComponent);
