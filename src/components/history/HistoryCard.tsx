"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { AlertTriangle, AudioLines, Bot, Boxes, Check, Coins, CopyPlus, Download, FileQuestion, GitBranch, Loader2, Play, RotateCcw, Share2, SlidersHorizontal, Star, Trash2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { ParticleSeaWaiting } from "@/components/ParticleSeaWaiting";
import { ShareDialog } from "@/components/history/ShareDialog";
import { formatCoins, formatModelLabel, formatRelativeTime, inferEntryKind, primaryModelId } from "@/lib/history-types";
import { deliverableKindLabel } from "@/lib/deliverable-kind";
import { canHistoryEntryRerun } from "@/lib/history-rerun";
import { assetPackPayloadFromHistoryEntry } from "@/lib/history-card-anchor";
import { workflowDagThumbnailUrl } from "@/lib/history-workflow-view";
import { firstShareableIndex } from "@/lib/share-remix";
import type { HistoryEntry } from "@/lib/history-types";

export interface HistoryCardProps {
  entry: HistoryEntry;
  /** 多选模式下显示勾选框，点击卡片变为选中而非打开灯箱。 */
  selectionMode: boolean;
  selected: boolean;
  onOpen: (entry: HistoryEntry) => void;
  onToggleSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
  onDownload: (entry: HistoryEntry) => void | Promise<void>;
  onDelete: (id: string) => void;
  /** 以这条记录的参数回到工作站继续做图。 */
  onReuse?: (entry: HistoryEntry) => void;
  /** 再来 N 组：按这条的原配方 payload 直接批量重跑（走 /api/generation-jobs）。 */
  onRerun?: (entry: HistoryEntry) => void;
  /** 微调变体：改提示词/模型/尺寸后再批量重跑。 */
  onRerunVariant?: (entry: HistoryEntry) => void;
  /** REQ-D1：打开这条记录的「溯源」抽屉（血统链，只给人看）。缺席时不挂入口。 */
  onShowLineage?: (entry: HistoryEntry) => void;
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
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  tone?: "neutral" | "danger" | "gold";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      title={label}
      onClick={(event) => {
        // 卡片本身可点击（打开灯箱），操作按钮不能把点击冒泡上去。
        event.stopPropagation();
        if (!disabled) onClick();
      }}
      className={cn(
        "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full",
        // /72 and /92 aren't on Tailwind's default opacity scale (multiples of
        // 5 only), so the slash-modifier form silently generated no rule at
        // all — these action icons were floating on the thumbnail with no
        // backing chip whatsoever. rgba() bracket values always compile.
        "bg-[rgba(255,255,255,0.72)] backdrop-blur-[22px] transition-all duration-200",
        "hover:bg-[rgba(255,255,255,0.92)] hover:-translate-y-[1px] active:scale-[0.94]",
        "focus:outline-none focus:ring-2 focus:ring-ring/20",
        disabled && "cursor-default opacity-60 hover:translate-y-0 hover:bg-[rgba(255,255,255,0.72)] active:scale-100",
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
  onRerun,
  onRerunVariant,
  onShowLineage,
}: HistoryCardProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  /** 「存为资产」状态：saved = 已存入 /api/assets（幂等，按钮打勾不可再点）。 */
  const [assetSaved, setAssetSaved] = useState(false);
  const [assetSaving, setAssetSaving] = useState(false);
  /** 下载要等整图 fetch 成 blob，期间下载钮转圈防重复点击。 */
  const [downloadBusy, setDownloadBusy] = useState(false);
  /** 「分享」对话框：打开＝就地建/取回公开链接（默认不公开，只有点过才有链接）。 */
  const [shareOpen, setShareOpen] = useState(false);
  /** 卡片里有自己的成品时的索引（视频/无图回 -1）：分享入口只对它出现。 */
  const shareableIndex = useMemo(() => firstShareableIndex(entry), [entry]);

  const handleDownload = useCallback(async () => {
    if (downloadBusy) return;
    setDownloadBusy(true);
    try {
      await onDownload(entry);
    } finally {
      setDownloadBusy(false);
    }
  }, [downloadBusy, onDownload, entry]);

  const kind = inferEntryKind(entry);
  /**
   * 缩略图选择：工作流卡用后端渲染好的 DAG 图（不在这里画 DAG——那是后端
   * Phase 2/4 的事）；其它卡按 image → imageUrl → videoUrl 依次取第一个命中。
   * 原来只找 image/imageUrl，纯视频记录（结果里只有 videoUrl）在历史里
   * 一律显示「没有留存图片」，是既有缺口。
   */
  const dagThumbnailUrl = workflowDagThumbnailUrl(entry);
  // 音频记录的结果里只有 audioUrl（无 image/imageUrl 也无 videoUrl），也必须被
  // find 命中；否则卡片落回「没有留存图片」占位，音乐记录在历史里是一张死卡。
  const result = entry.results.find((item) => item.image || item.imageUrl || item.videoUrl || item.audioUrl);
  const isVideo = !dagThumbnailUrl && !(result?.image || result?.imageUrl) && Boolean(result?.videoUrl);
  /** 音频態：有 audioUrl 且没有任何可当 <img> 的媒体（图像/视频）。 */
  const isAudio = !dagThumbnailUrl && !(result?.image || result?.imageUrl) && !result?.videoUrl && Boolean(result?.audioUrl);
  // audioUrl 不进 src（src 只喂 <img>）；它走下面独立的可播放面分支，
  // 这样 imageFailed 的破图判定不会被音频误触发。
  const src = dagThumbnailUrl
    ?? (result?.image ? `data:image/png;base64,${result.image}` : result?.imageUrl ?? result?.videoUrl ?? null);
  const model = primaryModelId(entry);
  const promptText = entry.prompt.trim();
  const rerunnable = canHistoryEntryRerun(entry);
  /** 生成中（排队/在跑）的 job 也会进历史：媒体区换粒子海动画、不挂操作条、不开灯箱。 */
  const inProgress = entry.taskStatus === "queued" || entry.taskStatus === "running";

  /** 构造资产包 payload；无 id / 无内容（无 prompt 也无图）时为 null，按钮不出现。 */
  const assetPayload = useMemo(() => assetPackPayloadFromHistoryEntry(entry), [entry]);

  /** 存为资产：PUT /api/assets（upsert by 确定性 id `history-${entry.id}`），幂等。 */
  const handleSaveAsset = useCallback(async (): Promise<void> => {
    if (assetSaved || assetSaving || !assetPayload) return;
    setAssetSaving(true);
    try {
      const res = await fetch("/api/assets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: `history-${entry.id}`,
          title: assetPayload.title,
          items: assetPayload.items,
          tags: [],
        }),
      });
      if (res.ok) setAssetSaved(true);
    } catch {
      // 静默失败：不打断页面，按钮可重试。
    } finally {
      setAssetSaving(false);
    }
  }, [assetSaved, assetSaving, assetPayload, entry.id]);

  const handleActivate = useCallback(() => {
    if (inProgress) return;
    if (selectionMode) onToggleSelect(entry.id);
    else onOpen(entry);
  }, [inProgress, selectionMode, onToggleSelect, onOpen, entry]);

  return (
    <article
      className={cn("hist-card hist-masonry-item group", selected && "is-selected")}
      aria-label={promptText || model || "生成记录"}
    >
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
        aria-label={inProgress ? "生成中" : selectionMode ? (selected ? "取消选中" : "选中这张") : isAudio ? "打开音频" : "查看大图"}
        className={cn(
          "block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/20",
          inProgress ? "cursor-default" : src && !imageFailed ? "cursor-zoom-in" : "cursor-pointer",
        )}
      >
        {inProgress ? (
          /* 生成中：粒子海进度动画铺满媒体区（ParticleSeaWaiting 是 absolute，
             父层必须 relative + 固定高度）。落地/失败后自动走下面正常分支。 */
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-none">
            <ParticleSeaWaiting visible startedAt={entry.generatedAt} />
          </div>
        ) : isAudio ? (
          /* 音频態媒體面：icon + 曲目標題 + 原生播放器。點播放器不冒泡到卡片
             （否則會同時開燈箱）；鍵盤同理，保住播放器的原生空白鍵行為。 */
          <div className="hist-card-media flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 px-4">
            <span
              className="lg-float flex h-12 w-12 items-center justify-center rounded-full text-[rgba(0,0,0,0.62)]"
              aria-hidden="true"
            >
              <AudioLines className="h-5 w-5" />
            </span>
            <p className="line-clamp-2 text-center text-ios-caption1 leading-[1.35] text-[rgba(0,0,0,0.72)]">
              {promptText || "未命名音频"}
            </p>
            {result?.audioUrl && (
              <audio
                src={result.audioUrl}
                controls
                preload="metadata"
                aria-label="播放音频"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className="w-full max-w-[240px]"
              />
            )}
          </div>
        ) : src && !imageFailed ? (
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
            {/*
              视频记录的缩略图是静态首帧，没有任何东西告诉用户「这能播」。
              角标用 lg-float 二级材质（design-system/MASTER.md 的材料层级），
              和操作条上的 32px 圆钮同族，压在缩略图左上角不挡操作条。
            */}
            {isVideo && (
              <span className="lg-float pointer-events-none absolute bottom-3 left-3 flex h-7 w-7 items-center justify-center rounded-full text-[rgba(0,0,0,0.72)]">
                <Play className="h-3.5 w-3.5" fill="currentColor" />
              </span>
            )}
          </div>
        ) : (
          <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 border-b border-dashed border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.015)]">
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

      {/* 悬停淡入的信息浮层（Civitai/Pinterest 式纯画廊卡片）：prompt/模型/时间
          默认隐藏，hover 或键盘 focus 时淡入；触摸设备上元数据由灯箱承担。 */}
      <div className="hist-card-info">
        <p className="line-clamp-2 text-ios-caption1 leading-[1.35] text-white/90">
          {promptText || <span className="text-white/60">没有提示词</span>}
        </p>
        <div className="mt-1 flex items-center gap-1.5 text-ios-caption1 text-white/70">
          <span className="truncate">{model ? formatModelLabel(model) : "未知模型"}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(entry.generatedAt).toISOString()} className="shrink-0">
            {formatRelativeTime(entry.generatedAt)}
          </time>
          {entry.quota !== undefined && entry.quota > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[#FFCE73]">
                <Coins className="h-2.5 w-2.5" />
                {formatCoins(entry.quota)}
              </span>
            </>
          )}
          {entry.source === "local" && (
            <>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 text-white/60">本地缓存</span>
            </>
          )}
        </div>
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
            "transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring/20",
            selected
              ? "bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.32)]"
              : "bg-[rgba(255,255,255,0.78)] text-transparent backdrop-blur-[22px] hover:bg-[rgba(255,255,255,0.92)]",
          )}
        >
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </button>
      )}

      {/* 工作流徽章：卡片右下角。用 lg-float 二级材质，不用实心色——工作流不是
          状态（成功/失败各有颜色），只是这条记录的类型标签，与视频播放角标同族。
          左上角是多选勾选框、右上角是操作条，两个角都被占了，所以放右下。 */}
      {kind === "workflow" && (
        <span className="lg-float pointer-events-none absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full px-2 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">
          <Workflow className="h-3 w-3" />
          工作流
        </span>
      )}

      {/* 音乐徽章：与工作流徽章同族（lg-float 二级材质、右下角），说明这是音频
          记录而非图片。音频记录不会是工作流，两个徽章不会冲突。 */}
      {isAudio && (
        <span className="lg-float pointer-events-none absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full px-2 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]">
          <AudioLines className="h-3 w-3" />
          {deliverableKindLabel("audio")}
        </span>
      )}

      {/* 悬停浮出的操作条（生成中不渲染：图还没出来，任何动作都无从谈起） */}
      {!inProgress && (
      <div className="hist-card-actions absolute right-3 top-3 z-20 flex gap-1.5">
        <CardAction
          label={entry.starred ? "取消收藏" : "收藏"}
          active={Boolean(entry.starred)}
          tone="gold"
          onClick={() => onToggleStar(entry.id)}
        >
          <Star className="h-3.5 w-3.5" fill={entry.starred ? "currentColor" : "none"} />
        </CardAction>
        {((src && !imageFailed) || isAudio) && (
          <CardAction label="下载" disabled={downloadBusy} onClick={handleDownload}>
            {downloadBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </CardAction>
        )}
        {onReuse && entry.workflow && (
          <CardAction label="用这套参数继续做图" onClick={() => onReuse(entry)}>
            <RotateCcw className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {/* payload 级重跑两连：原样再来 N 组 / 微调后再批量。配方不完整
            （无 prompt 或非图像模型）时不可重跑——挂一颗按下去只会失败的
            按钮比不挂更糟。 */}
        {onRerun && rerunnable && (
          <CardAction label="再来 N 组" onClick={() => onRerun(entry)}>
            <CopyPlus className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {onRerunVariant && rerunnable && (
          <CardAction label="微调变体" onClick={() => onRerunVariant(entry)}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {/* 存为资产：有可提取内容（prompt 或图）才出现；存成功置 disabled + 打勾（幂等）。 */}
        {assetPayload && (
          <CardAction
            label={assetSaved ? "已存为资产" : "存为资产"}
            active={assetSaved}
            disabled={assetSaved || assetSaving}
            onClick={() => void handleSaveAsset()}
          >
            {assetSaved ? <Check className="h-3.5 w-3.5" /> : <Boxes className="h-3.5 w-3.5" />}
          </CardAction>
        )}
        {/* D-18：有 prompt 才有东西交接给助理；没有就不挂这颗按钮。 */}
        {onOpenAgent && promptText.length > 0 && (
          <CardAction label="交给 AI 助理继续做" onClick={() => onOpenAgent(entry)}>
            <Bot className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {/* REQ-D1 溯源抽屉入口：所有历史卡都挂（来源不明的记录也要能进来看到
            「来源不明」这四个字，藏起来才是骗人）。 */}
        {onShowLineage && (
          <CardAction label="溯源" onClick={() => onShowLineage(entry)}>
            <GitBranch className="h-3.5 w-3.5" />
          </CardAction>
        )}
        {/* 分享：有自己的成品才出现（视频/无图不挂）。默认不公开——点开对话框
            才建立记录，撤销即删记录。 */}
        {shareableIndex >= 0 && (
          <CardAction label="分享" onClick={() => setShareOpen(true)}>
            <Share2 className="h-3.5 w-3.5" />
          </CardAction>
        )}
        <CardAction label="删除" tone="danger" onClick={() => onDelete(entry.id)}>
          <Trash2 className="h-3.5 w-3.5" />
        </CardAction>
      </div>
      )}
      {shareOpen && <ShareDialog entry={entry} onClose={() => setShareOpen(false)} />}
    </article>
  );
}

/**
 * 卡片会在网格里成百上千地出现，而收藏、删除、多选都会让父组件重新渲染。
 * memo 之后只有真正变化的那几张才会重绘。
 */
export const HistoryCard = memo(HistoryCardComponent);
