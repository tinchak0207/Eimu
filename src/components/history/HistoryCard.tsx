"use client";

import { memo, useCallback, useState } from "react";
import { AlertTriangle, Bot, Check, Coins, Download, FileQuestion, RotateCcw, Star, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCoins, formatModelLabel, formatRelativeTime, primaryModelId } from "@/lib/history-types";
import type { HistoryEntry } from "@/lib/history-types";

export interface HistoryCardProps {
  entry: HistoryEntry;
  /** 多选模式下显示勾选框，点击卡片变为选中而非打开灯箱。 */
  selectionMode: boolean;
  selected: boolean;
  onOpen: (entry: HistoryEntry) => void;
  onToggleSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
  onDownload: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  /** 以这条记录的参数回到工作站继续做图。 */
  onReuse?: (entry: HistoryEntry) => void;
  /**
   * D-18：交给 AI 助理继续做。只有「有可用内容」的卡才挂这颗按钮——
   * 纯信息卡不挂。这里的判据是这条记录得有 prompt 可以交接过去，
   * 没有 prompt 就没东西可说，按钮不出现。
   */
  onOpenAgent?: (entry: HistoryEntry) => void;
}

/** 卡片上的小图标按钮。统一 32px 命中区、统一焦点环。 */
function CardAction({
  label,
  active,
  tone = "neutral",
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  tone?: "neutral" | "danger" | "gold";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={(event) => {
        // 卡片本身可点击（打开灯箱），操作按钮不能把点击冒泡上去。
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full",
        // /72 and /92 aren't on Tailwind's default opacity scale (multiples of
        // 5 only), so the slash-modifier form silently generated no rule at
        // all — these action icons were floating on the thumbnail with no
        // backing chip whatsoever. rgba() bracket values always compile.
        "bg-[rgba(255,255,255,0.72)] backdrop-blur-[22px] transition-all duration-200",
        "hover:bg-[rgba(255,255,255,0.92)] hover:-translate-y-[1px] active:scale-[0.94]",
        "focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]",
        tone === "danger" && "text-[#FF3B30]",
        tone === "gold" && active && "text-[#FFB300]",
        tone === "neutral" && "text-[rgba(0,0,0,0.55)]",
      )}
    >
      {children}
    </button>
  );
}

function HistoryCardComponent({
  entry,
  selectionMode,
  selected,
  onOpen,
  onToggleSelect,
  onToggleStar,
  onDownload,
  onDelete,
  onReuse,
  onOpenAgent,
}: HistoryCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const result = entry.results.find((item) => item.image || item.imageUrl);
  const src = result?.image ? `data:image/png;base64,${result.image}` : result?.imageUrl ?? null;
  const model = primaryModelId(entry);
  const promptText = entry.prompt.trim();

  const handleActivate = useCallback(() => {
    if (selectionMode) onToggleSelect(entry.id);
    else onOpen(entry);
  }, [selectionMode, onToggleSelect, onOpen, entry]);

  return (
    <article
      className={cn("hist-card hist-masonry-item group", selected && "is-selected")}
      aria-label={promptText || model || "生成记录"}
    >
      {/* 玻璃卡片顶部的高光细线，与站内其他卡片保持一致 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70" />

      <div
        role="button"
        tabIndex={0}
        onClick={handleActivate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleActivate();
          }
        }}
        aria-label={selectionMode ? (selected ? "取消选中" : "选中这张") : "查看大图"}
        className={cn(
          "block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.20)]",
          src && !imageFailed ? "cursor-zoom-in" : "cursor-pointer",
        )}
      >
        {src && !imageFailed ? (
          <div className="hist-card-media">
            {!imageLoaded && <div className="hist-skeleton absolute inset-0" aria-hidden="true" />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={promptText ? `生成结果：${promptText.slice(0, 40)}` : "生成结果"}
              loading="lazy"
              decoding="async"
              className={cn(imageLoaded && "is-loaded")}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </div>
        ) : (
          <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-[rgba(0,0,0,0.03)]">
            {/*
              两种状态语义不同，图标必须区分开，否则「本地记录本来就没存图」看起来
              和「图片真的坏了」一样像故障——一整屏历史记录里前者数量往往远多于
              后者，全用错误图标会让整个页面显得像坏的。
              失效：琥珀警示三角，提示是可退化的真实错误。
              没留存：中性问号文档图标，提示这只是没有图片可看，而非故障。
            */}
            {imageFailed ? (
              // 复用本卡片删除按钮同一个 danger 色，而不是另起一个新的琥珀色。
              <AlertTriangle className="h-5 w-5 text-[#FF3B30]" />
            ) : (
              <FileQuestion className="h-5 w-5 text-[rgba(0,0,0,0.44)]" />
            )}
            <span className="text-ios-caption1 text-[rgba(0,0,0,0.58)]">
              {imageFailed ? "图片已失效" : "没有留存图片"}
            </span>
          </div>
        )}
      </div>

      {/* 多选勾选框 */}
      {selectionMode && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(entry.id);
          }}
          aria-label={selected ? "取消选中" : "选中这张"}
          aria-pressed={selected}
          className={cn(
            "absolute left-3 top-3 z-20 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full",
            "transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.20)]",
            selected
              ? "bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.32)]"
              : "bg-[rgba(255,255,255,0.78)] text-transparent backdrop-blur-[22px] hover:bg-[rgba(255,255,255,0.92)]",
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
      )}

      {/* 悬停浮出的操作条 */}
      <div className="hist-card-actions absolute right-3 top-3 z-20 flex gap-1.5">
        <CardAction
          label={entry.starred ? "取消收藏" : "收藏"}
          active={Boolean(entry.starred)}
          tone="gold"
          onClick={() => onToggleStar(entry.id)}
        >
          <Star className="h-3.5 w-3.5" fill={entry.starred ? "currentColor" : "none"} />
        </CardAction>
        {src && !imageFailed && (
          <CardAction label="下载" onClick={() => onDownload(entry)}>
            <Download className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {onReuse && entry.workflow && (
          <CardAction label="用这套参数继续做图" onClick={() => onReuse(entry)}>
            <RotateCcw className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {/* D-18：有 prompt 才有东西交接给助理；没有就不挂这颗按钮。 */}
        {onOpenAgent && promptText.length > 0 && (
          <CardAction label="交给 AI 助理继续做" onClick={() => onOpenAgent(entry)}>
            <Bot className="h-3.5 w-3.5" />
          </CardAction>
        )}
        <CardAction label="删除" tone="danger" onClick={() => onDelete(entry.id)}>
          <Trash2 className="h-3.5 w-3.5" />
        </CardAction>
      </div>

      {/* 信息区 */}
      <div className="px-3.5 pb-3 pt-2.5">
        <p className="line-clamp-2 text-ios-caption1 leading-[1.35] text-[rgba(0,0,0,0.72)]">
          {promptText || <span className="text-[rgba(0,0,0,0.58)]">没有提示词</span>}
        </p>
        {/* 模型、时间、消耗是每张卡都要扫一眼的元信息，11px 低于本站可读下限，用 12px。 */}
        <div className="mt-1.5 flex items-center gap-1.5 text-ios-caption1 text-[rgba(0,0,0,0.58)]">
          <span className="truncate">{model ? formatModelLabel(model) : "未知模型"}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(entry.generatedAt).toISOString()} className="shrink-0">
            {formatRelativeTime(entry.generatedAt)}
          </time>
          {/* 消耗只在能确定时才显示 —— 猜出来的数字比不显示更糟 */}
          {entry.quota !== undefined && entry.quota > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[rgba(120,90,20,0.85)]">
                <Coins className="h-2.5 w-2.5" />
                {formatCoins(entry.quota)}
              </span>
            </>
          )}
          {entry.source === "local" && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 text-[rgba(0,0,0,0.58)]">本地缓存</span>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

/**
 * 卡片会在网格里成百上千地出现，而收藏、删除、多选都会让父组件重新渲染。
 * memo 之后只有真正变化的那几张才会重绘。
 */
export const HistoryCard = memo(HistoryCardComponent);
