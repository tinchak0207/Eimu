"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentImageItem } from "@/lib/agent-chat-types";
import { agentHistoryEntryForMedia, saveAgentMediaToHistory } from "@/lib/agent-media-history";
import { createShareLink } from "@/lib/agent-image-share";
import { firstShareableIndex } from "@/lib/share-remix";
import { canHistoryEntryRerun } from "@/lib/history-rerun";

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
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

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

interface LightboxGesture {
  pointers: Map<number, { x: number; y: number }>;
  pinchDist: number;
  scale: number;
  tx: number;
  ty: number;
  dragging: boolean;
  moved: boolean;
  dragStart: { x: number; y: number; tx: number; ty: number };
  pressTime: number;
  suppressClick: boolean;
  pinch: boolean;
}

/** 全屏图片查看器：轻点关闭、下滑关闭、双击 / 双指 / 滚轮缩放、放大后拖动平移。
 *  手势全部自己消化，不依赖 hover；触控区 touch-action:none，浏览器不抢手势。 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const gesture = useRef<LightboxGesture>({
    pointers: new Map(),
    pinchDist: 0,
    scale: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    moved: false,
    dragStart: { x: 0, y: 0, tx: 0, ty: 0 },
    pressTime: 0,
    suppressClick: false,
    pinch: false,
  });
  const lastTapRef = useRef(0);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const applyTransform = useCallback((animated: boolean) => {
    const el = imgRef.current;
    if (!el) return;
    const g = gesture.current;
    el.style.transition = animated ? "transform 0.24s cubic-bezier(0.4, 0, 0.2, 1)" : "none";
    el.style.transform = `translate3d(${g.tx}px, ${g.ty}px, 0) scale(${g.scale})`;
  }, []);

  const clampPan = useCallback((g: LightboxGesture) => {
    const maxTx = Math.max(0, ((g.scale - 1) * window.innerWidth) / 2 + 48);
    const maxTy = Math.max(0, ((g.scale - 1) * window.innerHeight) / 2 + 48);
    g.tx = clamp(g.tx, -maxTx, maxTx);
    g.ty = clamp(g.ty, -maxTy, maxTy);
  }, []);

  // 打开期间锁背景滚动（存原值，关闭时还原）；焦点进关闭按钮。
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      cancelClose();
    };
  }, [cancelClose]);

  // Esc 关闭 + Android 返回键关闭（history 弹层惯例，与 ImageDisplay 一致）。
  useEffect(() => {
    window.history.pushState({ agentImageLightbox: true }, "");
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

  // 桌面滚轮 / 触控板捏合缩放（非 passive，否则 preventDefault 无效）。
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const g = gesture.current;
      g.scale = clamp(g.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 4);
      if (g.scale <= 1.01) {
        g.scale = 1;
        g.tx = 0;
        g.ty = 0;
      } else {
        clampPan(g);
      }
      applyTransform(false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTransform, clampPan]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const g = gesture.current;
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (g.pointers.size === 1) {
      g.dragging = true;
      g.moved = false;
      g.pressTime = Date.now();
      g.dragStart = { x: event.clientX, y: event.clientY, tx: g.tx, ty: g.ty };
    } else if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      g.dragging = false;
      g.pinch = true;
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = g.pinchDist > 0 ? dist / g.pinchDist : 1;
      g.pinchDist = dist;
      const next = clamp(g.scale * ratio, 1, 4);
      if (next <= 1.01) {
        g.scale = 1;
        g.tx = 0;
        g.ty = 0;
      } else {
        g.scale = next;
      }
      applyTransform(false);
    } else if (g.pointers.size === 1 && g.dragging) {
      const dx = event.clientX - g.dragStart.x;
      const dy = event.clientY - g.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 8) g.moved = true;
      if (g.scale > 1.01) {
        g.tx = g.dragStart.tx + dx;
        g.ty = g.dragStart.ty + dy;
        clampPan(g);
        applyTransform(false);
      } else {
        g.tx = 0;
        g.ty = dy;
        applyTransform(false);
      }
    }
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    g.pointers.delete(event.pointerId);
    if (g.pointers.size > 0) return;
    g.dragging = false;
    // 长按（唤起系统菜单）松手后不当作点击：不误关查看器。
    if (Date.now() - g.pressTime > 400) g.suppressClick = true;
    // 捏合结束后浏览器可能补发一个 click：不当作轻点关闭。
    if (g.pinch) {
      g.suppressClick = true;
      g.pinch = false;
    }
    if (g.scale <= 1.01) {
      if (g.ty > 90) {
        cancelClose();
        onClose();
        return;
      }
      if (g.moved) g.suppressClick = true;
      g.tx = 0;
      g.ty = 0;
      applyTransform(true);
    } else if (g.moved) {
      g.suppressClick = true;
      clampPan(g);
      applyTransform(true);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    g.pointers.delete(event.pointerId);
    if (g.pointers.size > 0) return;
    g.dragging = false;
    g.pinch = false;
    if (g.scale <= 1.01) {
      g.tx = 0;
      g.ty = 0;
      applyTransform(true);
    }
  };

  // 单击关闭延迟 320ms，窗口内第二下进来则取消并切换缩放——双击不会误关。
  const scheduleClose = () => {
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 320);
  };

  const handleScrimTap = () => {
    const g = gesture.current;
    if (g.suppressClick) {
      g.suppressClick = false;
      return;
    }
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      lastTapRef.current = 0;
      return;
    }
    lastTapRef.current = now;
    scheduleClose();
  };

  const handleImgTap = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    const g = gesture.current;
    if (g.suppressClick) {
      g.suppressClick = false;
      return;
    }
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      lastTapRef.current = 0;
      cancelClose();
      if (g.scale > 1.01) {
        g.scale = 1;
        g.tx = 0;
        g.ty = 0;
      } else {
        g.scale = 2.5;
        g.tx = 0;
        g.ty = 0;
      }
      applyTransform(true);
      return;
    }
    lastTapRef.current = now;
    // 放大中单击图片不关闭，避免误触；缩小状态轻点即关。
    if (g.scale <= 1.01) scheduleClose();
  };

  return createPortal(
    <div
      ref={scrimRef}
      role="dialog"
      aria-modal="true"
      aria-label="图片查看器"
      className="agent-chat-surface fixed inset-0 z-[95] flex min-h-[100dvh] cursor-zoom-out select-none items-center justify-center bg-[rgba(18,20,28,0.86)] backdrop-blur-xl [touch-action:none] [-webkit-tap-highlight-color:transparent] motion-safe:animate-lg-appear motion-reduce:animate-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerCancel}
      onClick={handleScrimTap}
    >
      <button
        ref={closeBtnRef}
        type="button"
        aria-label="关闭"
        onClick={(event) => {
          event.stopPropagation();
          cancelClose();
          onClose();
        }}
        className="absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.14] text-white backdrop-blur-md transition-colors duration-200 hover:bg-white/[0.24] focus:outline-none focus:ring-2 focus:ring-white/50 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-center">
        <div className="rounded-full bg-white/[0.12] px-3.5 py-1.5 text-ios-footnote text-white/80 backdrop-blur-md">
          轻点关闭 · 双指缩放
        </div>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- 灯箱原图双指缩放（blob:/proxy 来源），next/image 无法优化且固定宽高推导会绑死缩放自由度 */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => setReady(true)}
        onDragStart={(event) => event.preventDefault()}
        onClick={handleImgTap}
        className={cn(
          "max-h-[82dvh] max-w-[92vw] rounded-[1.5rem] object-contain will-change-transform",
          ready ? "opacity-100" : "opacity-0",
          "transition-opacity duration-200 motion-reduce:transition-none",
        )}
        style={{ transform: "translate3d(0px, 0px, 0) scale(1)" }}
      />
    </div>,
    document.body,
  );
}

function AgentImageCardComponent({
  item,
  onSaveToLibrary,
  onEdit,
  onDownload,
  onRerun,
  onRerunVariant,
}: AgentImageCardProps) {
  const [viewerOpen, setViewerOpen] = useState(false);
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
  const triggerRef = useRef<HTMLDivElement>(null);
  // 上一次按压的时长（毫秒）。click 由它判定是否「长按唤菜单后松手」。
  const pressRef = useRef<{ dt: number; t: number } | null>(null);
  // 「再来 N 组／微调变体」只在配方完整（有 prompt + 可计价图像模型）时渲染：
  // payload 级重跑需要真实模型才推得出单价，推不出价格就不摆一颗按了会开空对话框的钮。
  const rerunnable = canHistoryEntryRerun(agentHistoryEntryForMedia(item));

  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    triggerRef.current?.focus();
  }, []);

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
        ref={triggerRef}
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
          setViewerOpen(true);
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !failed) {
            event.preventDefault();
            setViewerOpen(true);
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
            src={item.url}
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
        {/* 放大＝开卡片内既有的全屏查看器（不是 AI 放大语义）。 */}
        <ImageAction label="放大" disabled={failed} onClick={() => !failed && setViewerOpen(true)}>
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
      {viewerOpen &&
        createPortal(
          <ImageLightbox src={item.url} alt="智能体生成的图片" onClose={closeViewer} />,
          document.body,
        )}
    </figure>
  );
}

export const AgentImageCard = memo(AgentImageCardComponent);
