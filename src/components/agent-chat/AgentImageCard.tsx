"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Coins,
  Download,
  Expand,
  ImagePlus,
  Layers,
  Library,
  Loader2,
  RotateCw,
  Share2,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentImageItem } from "@/lib/agent-chat-types";
import { agentHistoryEntryForMedia, saveAgentMediaToHistory } from "@/lib/agent-media-history";
import { createShareLink } from "@/lib/agent-image-share";
import { firstShareableIndex } from "@/lib/share-remix";
import { canHistoryEntryRerun } from "@/lib/history-rerun";
import type { AgentMediaItem } from "./agent-artifacts-context";
import { useAgentMediaViewerOpen } from "./agent-viewer";

export interface AgentImageCardProps {
  item: AgentImageItem;
  /** 存图库：true＝已存入／本来就在；false＝失败（卡片显示短暂「未存入」）。尚未接线时 undefined → disabled。 */
  onSaveToLibrary?: (item: AgentImageItem) => Promise<boolean>;
  /** 改图：把图抓回并加进输入框附件（true＝已交付附件）。false/抛错＝显示短暂「失败」。 */
  onEdit?: (item: AgentImageItem) => Promise<boolean>;
  /** 下载：true＝已触发下载；false/抛错＝按钮短暂「失败」。 */
  onDownload?: (item: AgentImageItem) => Promise<boolean>;
  /**
   * 「再来 N 组」：开 payload 级重跑对话框（RerunDialog 走 /api/generation-jobs，
   * 每个任务独立帐本预检，明码计价）。图有完整配方（prompt/model/size）才放行。
   */
  onRerun?: (item: AgentImageItem) => void;
  /** 「微调变体」：同一条 payload 级路径，可改提示词/模型/尺寸。 */
  onRerunVariant?: (item: AgentImageItem) => void;
  /** 所在合集（OpenUI 图集/专辑/对比）：赏阅打开整个合集并停在本张，可在全屏里切成员。缺省＝只看本张。 */
  viewerSet?: readonly AgentMediaItem[];
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 出图卡上的动作按钮：回调缺席时保持 disabled，等 wiring 阶段补上 handler。
 *  触控目标 44px（h-11），加 manipulation / 去高亮，避免 iOS 双击缩放与长按闪烁。 */
function ImageAction({
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
  /** "danger"：失败瞬时态（未存入／失败）走红字，与常态灰字分开。 */
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

function AgentImageCardComponent({
  item,
  onSaveToLibrary,
  onEdit,
  onDownload,
  onRerun,
  onRerunVariant,
  viewerSet,
}: AgentImageCardProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // 每颗动作钮各自的瞬时态：idle → loading →（成功定案／失败短暂闪字后回 idle）。
  // 「已存」本次会话内持续（不自动回落）；失败态由 2s 计时器收回 idle。
  const [saveState, setSaveState] = useState<"idle" | "loading" | "saved" | "failed">("idle");
  const [editState, setEditState] = useState<"idle" | "loading" | "failed">("idle");
  const [downState, setDownState] = useState<"idle" | "loading" | "failed">("idle");
  const [shareState, setShareState] = useState<"idle" | "loading" | "copied" | "needLogin" | "failed">("idle");
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // 上一次按压的时长（毫秒）。click 由它判定是否「长按唤菜单后松手」。
  const pressRef = useRef<{ dt: number; t: number } | null>(null);
  // 「再来 N 组／微调变体」只在配方完整（有 prompt + 可计价图像模型）时渲染：
  // payload 级重跑需要真实模型才推得出单价，推不出价格就不摆一颗按了会开空对话框的钮。
  const rerunnable = canHistoryEntryRerun(agentHistoryEntryForMedia(item));

  // 点图/放大 → 站内赏阅（全屏壳自带缩放/返回键关闭/标记→助理）；Provider 缺席时退回新标签打开。
  const openMedia = useAgentMediaViewerOpen({
    image: { onSaveToLibrary, onDownload, onRerun, onRerunVariant },
  });
  const openViewer = () => openMedia(item, viewerSet);

  // 失败闪字计时器：卸载时清掉，别让 setTimeout 攥著已卸载元件。
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

  // item.url 变化（同实例换图）时重置加载态，避免旧图的 loaded/failed 串台。
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [item.url]);

  const handleRetry = () => {
    setFailed(false);
    setLoaded(false);
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

  // 改图＝把图抓回加进输入框附件（不发任何讯息）；输入框出现 chip 就是回馈。
  const handleEdit = useCallback(async () => {
    if (!onEdit || editState === "loading") return;
    setEditState("loading");
    let ok = false;
    try {
      ok = await onEdit(item);
    } catch {
      ok = false;
    }
    if (ok) {
      setEditState("idle");
      return;
    }
    flash(() => setEditState("failed"), () => setEditState((s) => (s === "failed" ? "idle" : s)), 2000);
  }, [item, onEdit, editState, flash]);

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

  // 分享＝建立／取回历史 entry 的公开连结并复制；不弹任何遮挡层。
  const handleShare = useCallback(async () => {
    if (shareState === "loading") return;
    setShareState("loading");
    const entry = agentHistoryEntryForMedia(item);
    // 分享只认历史 entry：先补写（未登入＝false，下面的 createShareLink 会给人话原因）。
    await saveAgentMediaToHistory(entry);
    const result = await createShareLink(entry, { resultIndex: firstShareableIndex(entry) });
    if (result.ok) {
      try {
        await navigator.clipboard.writeText(result.url);
        flash(() => setShareState("copied"), () => setShareState("idle"), 1600);
      } catch {
        flash(() => setShareState("failed"), () => setShareState("idle"), 2000);
      }
      return;
    }
    if (result.message.includes("请先登录")) {
      flash(() => setShareState("needLogin"), () => setShareState("idle"), 2000);
      return;
    }
    flash(() => setShareState("failed"), () => setShareState("idle"), 2000);
  }, [item, shareState, flash]);


  return (
    <figure className="agent-rise">
      {/* 灰底只刷在媒体面这一层（预览 ImageResultCard：媒体 `overflow-hidden
          rounded-[18px] bg-black/[0.03]`，动作条落在页面白底上）。之前 figure 与
          媒体层各刷一层同款灰，圆角内被叠成两层色；灰底收回媒体层。 */}
      <div
        role="button"
        tabIndex={0}
        aria-label="查看大图"
        className="group relative aspect-square max-h-[min(420px,52dvh)] w-full cursor-zoom-in select-none overflow-hidden rounded-[18px] bg-black/[0.03] [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
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
          // 长按会唤起系统菜单（存图等），松手后的 click 不该把查看器也打开。
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
            <p className="text-ios-subhead font-medium text-muted-foreground">图片加载失败</p>
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
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={retryKey}
            src={/^https:\/\/store\.tinchak0207\.xyz\/image-data\/files\//.test(item.url)
              ? `/_next/image?url=${encodeURIComponent(item.url)}&w=640&q=75`
              : item.url}
            alt="智能体生成的图片"
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            onDragStart={(event) => event.preventDefault()}
            className={cn(
              "absolute inset-0 h-full w-full object-contain transition-opacity duration-300 motion-reduce:transition-none",
              loaded ? "opacity-100" : "opacity-0",
            )}
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
        {/* 存图库三态：idle「存图库」／loading 转圈／已存（Check＋「已存」，本次会话持续）／
            失败（2s 红字「未存入」）。回调缺席＝disabled，绝不伪造行为。 */}
        <ImageAction
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
        </ImageAction>
        {/* 改图＝加进输入框附件（不送 prompt）；抓取中转圈、失败短暂「失败」。 */}
        <ImageAction
          label={editState === "failed" ? "失败" : "改图"}
          disabled={!onEdit || editState === "loading"}
          tone={editState === "failed" ? "danger" : undefined}
          onClick={() => void handleEdit()}
        >
          {editState === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </ImageAction>
        {/* 放大＝开站内赏阅全屏查看器（不是 AI 放大语义）。 */}
        <ImageAction label="放大" disabled={failed} onClick={() => !failed && openViewer()}>
          <Expand className="h-3.5 w-3.5" aria-hidden="true" />
        </ImageAction>
        {/* 下载＝真下载（同源代理 → blob → <a download>）；失败短暂「失败」。 */}
        <ImageAction
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
        </ImageAction>
        {/* 分享＝建立／取回公开连结并复制（不弹遮挡层）；成功「已复制」1.6s。 */}
        <ImageAction
          label={
            shareState === "copied"
              ? "已复制"
              : shareState === "needLogin"
                ? "请先登录"
                : shareState === "failed"
                  ? "失败"
                  : "分享"
          }
          disabled={shareState === "loading"}
          tone={shareState === "failed" ? "danger" : undefined}
          onClick={() => void handleShare()}
        >
          {shareState === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : shareState === "copied" ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </ImageAction>
        {/* 图走 payload 级重跑（RerunDialog → /api/generation-jobs，逐任务帐本预检、
            明码计价）；影片／音频按秒计费、payload 级不开放，改走会话级（见两张卡的注释）。
            配方可重跑才渲染；回调缺席＝disabled，绝不伪造行为。 */}
        {rerunnable && (
          <>
            <ImageAction label="再来 N 组" disabled={!onRerun} onClick={() => onRerun?.(item)}>
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </ImageAction>
            <ImageAction
              label="微调变体"
              disabled={!onRerunVariant}
              onClick={() => onRerunVariant?.(item)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </ImageAction>
          </>
        )}
      </div>
    </figure>
  );
}

export const AgentImageCard = memo(AgentImageCardComponent);
