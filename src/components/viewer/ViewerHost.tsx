"use client";

// 赏阅的壳：Provider + 全屏 portal + 舞台（ViewerStage）。
//
// 分工：Surface（适配器）只管「渲染这一种成品 + 发布 capture/reveal」；本档管一切跨种类的东西——
// 顶栏、集合成员切换、动作栏（下载/存图库/再来N组/微调）、来历、标记面板入口、快捷键帮助、焦点陷阱、滚动锁。
// ViewerStage 同时是独立分享页 /view 的页面形态（mode="page"），所以全屏弹层与整页是同一份实现。
//
// 键盘分工（与 docs/architecture/viewer.md 一致）：
//   适配器：空格、←/→（种类内语义）、F、[ ]、L、0–9
//   壳：Esc（先收面板/帮助，再关闭）、PageUp/PageDown 或 K/J 切换集合成员、?

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CopyPlus,
  Download,
  Flag,
  Info,
  Library,
  Loader2,
  RotateCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { viewKindLabel } from "@/lib/viewer/from-items";
import { HISTORY_RERUN_COUNT_OPTIONS } from "@/lib/history-rerun";
import type {
  Locator,
  ViewAsset,
  ViewerActions,
  ViewerController,
  ViewerSurfaceProps,
} from "@/lib/viewer/types";
import { VIEWER_SURFACES } from "./adapters";
import { ReviewSheet, useAnnotations } from "./ReviewSheet";

/* ---------- 小工具 ---------- */

export { viewKindLabel };

function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** 存图库「已存」本次会话持续（切到别的件再切回来仍是已存）。 */
const savedIds = new Set<string>();

/* ---------- 适配器槽（带错误边界） ---------- */

interface BoundaryProps {
  children: ReactNode;
  onReset(): void;
}
class SurfaceBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-3 p-4 text-center text-white">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-red-300">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>
        <p className="text-[14px] text-white/80">这件成品暂时打不开</p>
        <button
          type="button"
          onClick={() => {
            this.setState({ failed: false });
            this.props.onReset();
          }}
          className="flex min-h-11 items-center gap-1.5 rounded-full bg-white/15 px-5 text-[14px] font-medium hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation]"
        >
          <RotateCw className="h-4 w-4" aria-hidden="true" />
          重试
        </button>
      </div>
    );
  }
}

/** 渲染 VIEWER_SURFACES[asset.kind]；适配器崩了只影响这一格，壳与评审层照常。 */
export function SurfaceSlot(props: ViewerSurfaceProps) {
  const [attempt, setAttempt] = useState(0);
  const Surface = VIEWER_SURFACES[props.asset.kind];
  return (
    <SurfaceBoundary onReset={() => setAttempt((n) => n + 1)}>
      <Surface key={attempt} {...props} />
    </SurfaceBoundary>
  );
}

/* ---------- 动作栏 ---------- */

function ActionButton({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors",
        danger ? "text-red-300" : "text-white/80",
        "enabled:hover:bg-white/10 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-white/35",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
      )}
    >
      {children}
      {label}
    </button>
  );
}

function RerunMenu({ disabled, onPick }: { disabled: boolean; onPick(count: number): void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    };
    // Esc 同样在 window capture 阶段吞掉：先关菜单，不让壳（或底下的 Radix 层）把这次 Esc 当成关壳。
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative" data-viewer-esc-layer={open ? "" : undefined}>
      <ActionButton label="再来 N 组" disabled={disabled} onClick={() => setOpen((v) => !v)}>
        <CopyPlus className="h-4 w-4" aria-hidden="true" />
      </ActionButton>
      {open && !disabled && (
        <div
          role="menu"
          aria-label="再来 N 组"
          className="absolute bottom-full left-0 z-20 mb-1 flex gap-1 rounded-xl bg-[rgba(30,33,44,0.98)] p-1 shadow-[0_8px_28px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
        >
          {HISTORY_RERUN_COUNT_OPTIONS.map((count) => (
            <button
              key={count}
              type="button"
              role="menuitem"
              aria-label={`再来 ${count} 组`}
              onClick={() => {
                setOpen(false);
                onPick(count);
              }}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-[14px] font-medium text-white/85 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation]"
            >
              {count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 动作状态机迁移自 AgentAudioCard：存图库 idle→loading→saved／failed(2s)；下载 idle→loading→idle／failed(2s)。 */
function ActionBar({
  asset,
  actions,
  extraActions,
}: {
  asset: ViewAsset;
  actions?: ViewerActions;
  extraActions?: readonly ViewerExtraAction[];
}) {
  const [saveState, setSaveState] = useState<"idle" | "loading" | "saved" | "failed">(
    savedIds.has(asset.id) ? "saved" : "idle",
  );
  const [downState, setDownState] = useState<"idle" | "loading" | "failed">("idle");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(clearTimeout);
  }, []);
  const flash = (apply: () => void, revert: () => void) => {
    apply();
    timers.current.push(setTimeout(revert, 2000));
  };

  const { onSaveToLibrary, onDownload, onRerun, onVariant } = actions ?? {};

  const handleSave = async () => {
    if (!onSaveToLibrary || saveState === "loading" || saveState === "saved") return;
    setSaveState("loading");
    let ok = false;
    try {
      ok = await onSaveToLibrary(asset);
    } catch {
      ok = false;
    }
    if (ok) {
      savedIds.add(asset.id);
      setSaveState("saved");
      return;
    }
    flash(() => setSaveState("failed"), () => setSaveState((s) => (s === "failed" ? "idle" : s)));
  };

  const handleDownload = async () => {
    if (!onDownload || downState === "loading") return;
    setDownState("loading");
    let ok = false;
    try {
      ok = await onDownload(asset);
    } catch {
      ok = false;
    }
    if (ok) {
      setDownState("idle");
      return;
    }
    flash(() => setDownState("failed"), () => setDownState((s) => (s === "failed" ? "idle" : s)));
  };

  return (
    <div
      role="toolbar"
      aria-label="成品操作"
      className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1"
    >
      {actions && (
        <>
          <ActionButton
            label={saveState === "saved" ? "已存" : saveState === "failed" ? "未存入" : "存图库"}
            disabled={!onSaveToLibrary || saveState === "loading" || saveState === "saved"}
            danger={saveState === "failed"}
            onClick={() => void handleSave()}
          >
            {saveState === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : saveState === "saved" ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Library className="h-4 w-4" aria-hidden="true" />
            )}
          </ActionButton>
          <ActionButton
            label={downState === "failed" ? "失败" : "下载"}
            disabled={!onDownload || downState === "loading"}
            danger={downState === "failed"}
            onClick={() => void handleDownload()}
          >
            {downState === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
          </ActionButton>
          <RerunMenu disabled={!onRerun} onPick={(count) => onRerun?.(asset, count)} />
          <ActionButton label="微调" disabled={!onVariant} onClick={() => onVariant?.(asset)}>
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
          </ActionButton>
        </>
      )}
      {extraActions
        ?.filter((a) => !a.visible || a.visible(asset))
        .map((a) => (
          <ActionButton
            key={a.id}
            label={typeof a.label === "function" ? a.label(asset) : a.label}
            disabled={false}
            danger={a.danger}
            onClick={() => a.onClick(asset)}
          >
            {a.icon}
          </ActionButton>
        ))}
    </div>
  );
}

/* ---------- 来历 / 帮助 ---------- */

function provenanceRows(asset: ViewAsset): { label: string; value: string; long?: boolean }[] {
  const p = asset.provenance;
  if (!p) return [];
  const rows: { label: string; value: string; long?: boolean }[] = [];
  if (p.prompt) rows.push({ label: "提示词", value: p.prompt, long: true });
  if (p.model) rows.push({ label: "模型", value: p.model });
  if (p.take != null) rows.push({ label: "候选", value: `第 ${p.take} 个` });
  if (p.costCoins != null) rows.push({ label: "花费", value: `${formatCoins(p.costCoins)} 金币` });
  if (p.createdAt != null) rows.push({ label: "生成时间", value: new Date(p.createdAt).toLocaleString("zh-CN", { hour12: false }) });
  if (p.taskId) rows.push({ label: "任务编号", value: p.taskId });
  return rows;
}

function SidePanel({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
      className={cn(
        "absolute z-30 flex flex-col border-white/10 bg-[rgba(16,18,26,0.97)] text-white shadow-[0_-12px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl",
        "inset-x-0 bottom-0 max-h-[70dvh] rounded-t-2xl border-t",
        "md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[380px] md:rounded-none md:border-l md:border-t-0",
      )}
    >
      <header className="flex items-center justify-between px-4 pt-2 md:pt-3">
        <h2 className="text-[15px] font-semibold">{label}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={`收起${label}`}
          className="flex h-11 w-11 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] [overscroll-behavior:contain]">
        {children}
      </div>
    </aside>
  );
}

const HELP_ROWS: [string, string][] = [
  ["空格", "播放 / 暂停"],
  ["← / →", "后退 / 前进（Shift 加大步长；文档为翻页）"],
  ["F", "标记当前位置"],
  ["[  ]", "调慢 / 调快倍速"],
  ["L", "循环当前一段（A-B）"],
  ["0 – 9", "跳到 0% – 90%"],
  ["PageUp / K", "上一件（合集内）"],
  ["PageDown / J", "下一件（合集内）"],
  ["Esc", "收起面板，再按关闭"],
  ["?", "显示 / 隐藏本帮助"],
];

function HelpDialog({ onClose }: { onClose(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Tab") return;
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "?") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快捷键"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] rounded-2xl border border-white/10 bg-[rgba(24,26,36,0.98)] p-5 text-white"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">快捷键</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="关闭快捷键帮助"
            className="flex h-11 w-11 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-[13px]">
          {HELP_ROWS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="justify-self-start rounded-md bg-white/10 px-2 py-0.5 font-mono text-white">{k}</dt>
              <dd className="text-white/65">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-white/45">快捷键按种类生效；不适用的种类按了没有反应。</p>
      </div>
    </div>
  );
}

/* ---------- 舞台 ---------- */

export interface ViewerStageProps {
  /** 成员列表；单件传 [asset]。 */
  set: readonly ViewAsset[];
  index?: number;
  actions?: ViewerActions;
  /** 缺省＝页面形态（无关闭钮，Esc 只收面板）。 */
  onClose?(): void;
  mode: "overlay" | "page";
  /** 一进来就打开标记面板（inline 的 F 键放大后接力）。 */
  openReview?: boolean;
  /** 一进来跳到的位置（分享链接的 t=）；只对首件、只执行一次。 */
  initialLocator?: Locator;
  /** 页面形态顶栏最左的自定义内容（如回首页的品牌链接）。 */
  leading?: ReactNode;
  /** 顶栏标题旁的短说明（如「参考图 2/6」）。 */
  caption?: string;
  /** 成品下方、动作栏上方的自定义区；函数形态按当前成员渲染。 */
  extraFooter?: ViewerExtraFooter;
  /** 追加到动作栏的调用方专属动作。 */
  extraActions?: readonly ViewerExtraAction[];
  /** 顶层集合内切换成员时回报下标（进入合集成员的下钻不回报）。 */
  onIndexChange?(index: number): void;
}

/** 调用方专属动作（历史页的删除/收藏/溯源等壳无法映射的动作）。 */
export interface ViewerExtraAction {
  id: string;
  label: string | ((asset: ViewAsset) => string);
  onClick(asset: ViewAsset): void;
  danger?: boolean;
  icon?: ReactNode;
  /** 按当前成员决定是否出现（如「配方完整才挂再来 N 组」）；缺省＝总是出现。 */
  visible?(asset: ViewAsset): boolean;
}

export type ViewerExtraFooter = ReactNode | ((asset: ViewAsset) => ReactNode);

interface Nav {
  set: readonly ViewAsset[];
  index: number;
}

export function ViewerStage({
  set,
  index = 0,
  actions,
  onClose,
  mode,
  openReview,
  initialLocator,
  leading,
  caption,
  extraFooter,
  extraActions,
  onIndexChange,
}: ViewerStageProps) {
  const [nav, setNav] = useState<Nav>({ set, index: Math.min(Math.max(0, index), Math.max(0, set.length - 1)) });
  const [trail, setTrail] = useState<Nav[]>([]);
  const [panel, setPanel] = useState<null | "review" | "provenance">(openReview ? "review" : null);
  const [recapture, setRecapture] = useState(0);
  const [help, setHelp] = useState(false);
  const controllerRef = useRef<ViewerController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ x: number; y: number; ok: boolean } | null>(null);

  const current: ViewAsset | undefined = nav.set[nav.index];
  const assetId = current?.id ?? "";
  const review = useAnnotations(assetId);
  const count = nav.set.length;

  const go = useCallback((delta: number) => {
    setNav((n) => {
      const next = Math.min(Math.max(0, n.index + delta), n.set.length - 1);
      return next === n.index ? n : { ...n, index: next };
    });
  }, []);

  const openChild = useCallback(
    (child: ViewAsset) => {
      const siblings = current?.children;
      const at = siblings ? siblings.findIndex((c) => c === child || c.id === child.id) : -1;
      setTrail((t) => [...t, nav]);
      setNav(siblings && at >= 0 ? { set: siblings, index: at } : { set: [child], index: 0 });
    },
    [current, nav],
  );
  const back = useCallback(() => {
    const prev = trail[trail.length - 1];
    if (!prev) return;
    setNav(prev);
    setTrail(trail.slice(0, -1));
  }, [trail]);

  const onIndexChangeRef = useRef(onIndexChange);
  useEffect(() => {
    onIndexChangeRef.current = onIndexChange;
  });
  const topIndex = trail.length === 0 ? nav.index : null;
  useEffect(() => {
    if (topIndex !== null) onIndexChangeRef.current?.(topIndex);
  }, [topIndex]);

  const requestMark = useCallback(() => {
    if (panel === "review") setRecapture((n) => n + 1);
    setPanel("review");
  }, [panel]);

  // 换件：旧件的控制柄作废（适配器卸载时也会置 null，这里兜底）；面板跟随新件。
  useEffect(() => {
    return () => {
      controllerRef.current = null;
    };
  }, [assetId]);

  // 首件跳到指定位置：控制柄是适配器懒加载后才发布的，轮询到它出现（最多 10 秒）。
  const initialRef = useRef({ locator: initialLocator, id: assetId });
  useEffect(() => {
    const { locator, id } = initialRef.current;
    if (!locator || !id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const c = controllerRef.current;
      if (c) {
        clearInterval(timer);
        try {
          c.reveal(locator);
        } catch {
          /* 适配器还没准备好就算了，不影响查看 */
        }
      } else if (++tries > 100) {
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // 全局快捷键（只管壳的那几个；种类内语义留给适配器）。
  // 必须在 window 的 capture 阶段监听：Radix Dialog/Popover 的 Esc 监听挂在 document 的 capture 上，
  // 若壳还在冒泡阶段，底下的 Radix 弹层会先吃掉第一次 Esc，壳关不掉。window capture 先于 document capture，
  // 所以壳处理了的键一律 stopImmediatePropagation，不再往下漏给底下的页面层。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const root = rootRef.current;
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === "Escape") {
        // 壳内有自己处理 Esc 的临时层（如「再来 N 组」菜单）：让它先关，它自己在 capture 阶段吞掉事件。
        if (root?.querySelector("[data-viewer-esc-layer]")) return;
        if (help) setHelp(false);
        else if (panel) setPanel(null);
        else if (onClose) onClose();
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (isTyping(e.target)) return;
      // 标记面板/帮助等子层里的按键只在子层内处理（与此前冒泡阶段被子层 stopPropagation 的语义一致）。
      const sub = target?.closest('[role="dialog"]');
      if (sub && sub !== root) return;
      let handled = false;
      if (e.key === "?") {
        setHelp((v) => !v);
        handled = true;
      } else if (e.key === "PageDown" || e.key === "j" || e.key === "J") {
        if (count > 1) {
          go(1);
          handled = true;
        }
      } else if (e.key === "PageUp" || e.key === "k" || e.key === "K") {
        if (count > 1) {
          go(-1);
          handled = true;
        }
      }
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [help, panel, onClose, count, go]);

  // 全屏层：进来把焦点放进来，出去还给原处。
  useEffect(() => {
    if (mode !== "overlay") return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, [mode]);

  // 面板关闭后焦点若掉到 body，收回舞台（保持键盘可用）。
  useEffect(() => {
    if (panel === null && !help && (document.activeElement === document.body || !document.activeElement)) {
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [panel, help]);

  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || mode !== "overlay") return;
    const nodes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );
    if (nodes.length === 0) {
      e.preventDefault();
      rootRef.current?.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === rootRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1 || count < 2) {
      swipeRef.current = null;
      return;
    }
    const t = e.touches[0];
    const target = e.target instanceof Element ? e.target : null;
    // 画布/滑杆/输入框以及适配器标了 data-no-swipe 的区域（拖选区、缩放、拖进度）里的横滑不是切换成员。
    swipeRef.current = {
      x: t.clientX,
      y: t.clientY,
      ok: !target?.closest('canvas,input,textarea,select,[role="slider"],[data-no-swipe]'),
    };
  };
  const onTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || !s.ok) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 72 && Math.abs(dy) < 48 && Math.abs(dx) > Math.abs(dy) * 2) go(dx < 0 ? 1 : -1);
  };

  const rows = useMemo(() => (current ? provenanceRows(current) : []), [current]);

  if (!current) return null;
  const footerNode = typeof extraFooter === "function" ? extraFooter(current) : extraFooter;
  const kindLabel = viewKindLabel(current.kind);
  const title = current.title?.trim() || "";
  const iconBtn =
    "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]";

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role={mode === "overlay" ? "dialog" : "region"}
      aria-modal={mode === "overlay" ? true : undefined}
      aria-label={`${kindLabel}赏阅${title ? `：${title}` : ""}`}
      onKeyDown={onRootKeyDown}
      className="relative flex h-full w-full flex-col overflow-hidden bg-[#0d0f14] text-white outline-none"
    >
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.25rem,env(safe-area-inset-top))]">
        {leading}
        {trail.length > 0 && (
          <button type="button" onClick={back} aria-label="返回上一级" className={iconBtn}>
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-0.5 text-[13px] font-medium text-white/80">{kindLabel}</span>
          {title && (
            <h1 className="min-w-0 truncate text-[15px] font-semibold" title={title}>
              {title}
            </h1>
          )}
          {caption && <span className="shrink-0 truncate text-[13px] text-white/60">{caption}</span>}
          {count > 1 && (
            <span className="shrink-0 text-[13px] tabular-nums text-white/60" aria-label={`第 ${nav.index + 1} 件，共 ${count} 件`}>
              {nav.index + 1}/{count}
            </span>
          )}
        </div>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => setPanel((p) => (p === "provenance" ? null : "provenance"))}
            aria-label="来历"
            aria-pressed={panel === "provenance"}
            className={cn(iconBtn, panel === "provenance" && "bg-white/15 text-white")}
          >
            <Info className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setPanel((p) => (p === "review" ? null : "review"))}
          aria-label="标记"
          aria-pressed={panel === "review"}
          className={cn(iconBtn, panel === "review" && "bg-white/15 text-white")}
        >
          <Flag className="h-5 w-5" aria-hidden="true" />
          {review.annotations.length > 0 && (
            <span className="absolute right-1 top-1 min-w-[1.1rem] rounded-full bg-ios-blue px-1 text-center text-[11px] leading-[1.1rem] text-white">
              {review.annotations.length}
            </span>
          )}
        </button>
        <button type="button" onClick={() => setHelp(true)} aria-label="快捷键帮助" className={cn(iconBtn, "max-sm:hidden")}>
          <CircleHelp className="h-5 w-5" aria-hidden="true" />
        </button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="关闭" className={iconBtn}>
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* 成品 */}
      <div className="relative min-h-0 flex-1" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <SurfaceSlot
          key={`${trail.length}:${current.id}`}
          asset={current}
          density="full"
          annotations={review.annotations}
          controllerRef={controllerRef}
          onRequestMark={requestMark}
          active
          onOpenChild={openChild}
        />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={nav.index === 0}
              aria-label="上一件"
              className="absolute left-2 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-30 [touch-action:manipulation]"
            >
              <ChevronLeft className="h-6 w-6" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={nav.index === count - 1}
              aria-label="下一件"
              className="absolute right-2 top-1/2 z-20 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-30 [touch-action:manipulation]"
            >
              <ChevronRight className="h-6 w-6" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* 动作栏：没传 actions 就整条不出现；传了就四钮齐全，缺的 disabled（与媒体卡同惯例）。 */}
      {footerNode ? (
        <div className="flex max-h-[30dvh] shrink-0 justify-center overflow-y-auto px-2 pb-1">{footerNode}</div>
      ) : null}
      {(actions || (extraActions && extraActions.length > 0)) && (
        <ActionBar key={current.id} asset={current} actions={actions} extraActions={extraActions} />
      )}

      {panel === "provenance" && rows.length > 0 && (
        <SidePanel label="来历" onClose={() => setPanel(null)}>
          <dl className="mt-2 flex flex-col gap-3 text-[13px]">
            {rows.map((r) => (
              <div key={r.label}>
                <dt className="text-white/50">{r.label}</dt>
                <dd className={cn("mt-0.5 text-white/90", r.long ? "whitespace-pre-wrap break-words leading-relaxed" : "break-all")}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </SidePanel>
      )}
      <ReviewSheet
        asset={current}
        review={review}
        controllerRef={controllerRef}
        actions={actions}
        open={panel === "review"}
        onClose={() => setPanel(null)}
        recaptureKey={recapture}
      />
      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}

/* ---------- Provider / 全屏层 ---------- */

export interface ViewerOpenOptions {
  index?: number;
  actions?: ViewerActions;
  /** 打开即展开标记面板。 */
  review?: boolean;
  /** 打开即跳到的位置。 */
  initialLocator?: Locator;
  /** 与 ViewerStageProps 同名同义（旧 ImageLightbox 的 caption/footer、历史页专属动作）。 */
  caption?: string;
  extraFooter?: ViewerExtraFooter;
  extraActions?: readonly ViewerExtraAction[];
  onIndexChange?(index: number): void;
  /** 用户真正关闭时回调（被新的 open() 替换不算关闭）。 */
  onClose?(): void;
}

/** 会话进行中可原位更新（不重挂载舞台）的字段。 */
export type ViewerSessionPatch = Pick<ViewerOpenOptions, "caption" | "extraFooter" | "extraActions">;

export interface ViewerApi {
  /** 打开全屏；同一时刻只有一个，再次调用＝替换。 */
  open(assetOrSet: ViewAsset | readonly ViewAsset[], opts?: ViewerOpenOptions): void;
  close(): void;
  /** 原位更新当前会话的 caption/extraFooter/extraActions（footer 带状态的调用方用）；无会话时空操作。 */
  update(patch: ViewerSessionPatch): void;
  isOpen: boolean;
  /** 上下文里确有 Provider（否则 open 是空操作）。 */
  available: boolean;
}

const NOOP_API: ViewerApi = {
  open: () => undefined,
  close: () => undefined,
  update: () => undefined,
  isOpen: false,
  available: false,
};
const ViewerContext = createContext<ViewerApi | null>(null);

export function useViewer(): ViewerApi {
  return useContext(ViewerContext) ?? NOOP_API;
}

interface Session {
  token: number;
  set: readonly ViewAsset[];
  index: number;
  actions?: ViewerActions;
  review?: boolean;
  initialLocator?: Locator;
  caption?: string;
  extraFooter?: ViewerExtraFooter;
  extraActions?: readonly ViewerExtraAction[];
  onIndexChange?(index: number): void;
  onClose?(): void;
}

function isAssetList(v: ViewAsset | readonly ViewAsset[]): v is readonly ViewAsset[] {
  return Array.isArray(v);
}

/** 记录已挂载的全屏层数：StrictMode 的「挂载→卸载→挂载」不能被误判成真关闭。 */
let mountedLayers = 0;

function FullscreenLayer({ session, onClose }: { session: Session; onClose(): void }) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 返回键（手机物理返回/浏览器后退）＝关闭：与 ImageLightbox 同惯例，进场压一条历史。
  useEffect(() => {
    mountedLayers += 1;
    const hasOurs = () => (window.history.state as { eimuViewer?: boolean } | null)?.eimuViewer === true;
    if (!hasOurs()) window.history.pushState({ eimuViewer: true }, "");
    const onPop = () => onCloseRef.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      mountedLayers -= 1;
      // 用户点关闭（不是后退）时把我们压的那条历史退掉，免得留一次「按返回没反应」。
      setTimeout(() => {
        if (mountedLayers === 0 && hasOurs()) window.history.back();
      }, 0);
    };
  }, []);

  // 锁 body 滚动。
  useEffect(() => {
    const body = document.body;
    const root = document.documentElement;
    const prevBody = body.style.overflow;
    const prevRoot = root.style.overflow;
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    return () => {
      body.style.overflow = prevBody;
      root.style.overflow = prevRoot;
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[100] min-h-[100dvh] bg-[#0d0f14]">
      <ViewerStage
        key={session.token}
        mode="overlay"
        set={session.set}
        index={session.index}
        actions={session.actions}
        openReview={session.review}
        initialLocator={session.initialLocator}
        caption={session.caption}
        extraFooter={session.extraFooter}
        extraActions={session.extraActions}
        onIndexChange={session.onIndexChange}
        onClose={onClose}
      />
    </div>,
    document.body,
  );
}

export function ViewerProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const tokenRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);

  const open = useCallback<ViewerApi["open"]>((assetOrSet, opts) => {
    const set = isAssetList(assetOrSet) ? assetOrSet : [assetOrSet];
    if (set.length === 0) return;
    tokenRef.current += 1;
    const next: Session = {
      token: tokenRef.current,
      set,
      index: opts?.index ?? 0,
      actions: opts?.actions,
      review: opts?.review,
      initialLocator: opts?.initialLocator,
      caption: opts?.caption,
      extraFooter: opts?.extraFooter,
      extraActions: opts?.extraActions,
      onIndexChange: opts?.onIndexChange,
      onClose: opts?.onClose,
    };
    sessionRef.current = next;
    setSession(next);
  }, []);
  const close = useCallback(() => {
    const ended = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    ended?.onClose?.();
  }, []);
  const update = useCallback<ViewerApi["update"]>((patch) => {
    const cur = sessionRef.current;
    if (!cur) return;
    const next: Session = { ...cur, ...patch };
    sessionRef.current = next;
    setSession(next);
  }, []);

  const api = useMemo<ViewerApi>(
    () => ({ open, close, update, isOpen: session !== null, available: true }),
    [open, close, update, session],
  );

  return (
    <ViewerContext.Provider value={api}>
      {children}
      {session && <FullscreenLayer session={session} onClose={close} />}
    </ViewerContext.Provider>
  );
}
