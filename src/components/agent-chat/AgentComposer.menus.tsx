import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Brain, Check, ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AGENT_THINKING_LEVEL_HINTS,
  AGENT_THINKING_LEVEL_LABELS,
  AGENT_THINKING_LEVELS,
  agentThinkingLevelPatch,
  readCachedAgentSettings,
  resolveAgentThinkingLevel,
  saveAgentSettings,
  writeCachedAgentThinkingLevel,
  type AgentThinkingLevel,
} from "@/lib/agent-chat-client";

interface PanelCoords {
  top: number;
  left: number;
}

/**
 * 浮层锚定（共用件）：把面板定在触发钮**正下方**、左缘与钮左缘对齐，回传 portal
 * 用的 fixed 视窗座标。
 *
 * 用 portal + fixed 而非容器内 absolute 的原因：助理页 surface 根带
 * `overflow-hidden`、composer 根带 `backdrop-filter`（＝fixed 后代的 containing
 * block），留在树内的定位会被祖先裁掉/改锚。
 *
 * coords 为 null ＝ 首 frame 尚未量到尺寸（面板以 visibility:hidden 占位量完再入座，
 * 在 paint 前完成故不闪）；未展开时清回 null。下方装不下才翻到钮上方；四边内收 8px。
 */
export function useAnchoredPanel(
  open: boolean,
  triggerRef: RefObject<HTMLDivElement | null>,
): { panelRef: RefObject<HTMLDivElement | null>; coords: PanelCoords | null } {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<PanelCoords | null>(null);

  const place = useCallback((): void => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const panel = panelRef.current;
    const pw = panel ? panel.offsetWidth : 0;
    const ph = panel ? panel.offsetHeight : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 8;
    const MARGIN = 8;
    let top = r.bottom + GAP; // 预设：按钮正下方
    if (ph > 0 && top + ph > vh - MARGIN && r.top - GAP - ph >= MARGIN) {
      top = r.top - GAP - ph; // 下方不足才翻到上方
    }
    if (ph > 0) top = Math.min(top, Math.max(MARGIN, vh - MARGIN - ph));
    let left = r.left; // 左缘与按钮左缘对齐
    if (pw > 0) left = Math.min(left, Math.max(MARGIN, vw - MARGIN - pw));
    setCoords({ top, left });
  }, [triggerRef]);

  // 先量尺寸再入座（useLayoutEffect 在 paint 前跑，不会闪）。
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    place();
  }, [open, place]);

  // 开著时视窗尺寸／任何祖先卷动（capture）都重新贴合锚点，面板不飘走。
  useEffect(() => {
    if (!open) return;
    const onMove = (): void => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onMove);
    vv?.addEventListener("scroll", onMove);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      vv?.removeEventListener("resize", onMove);
      vv?.removeEventListener("scroll", onMove);
    };
  }, [open, place]);

  return { panelRef, coords };
}

/**
 * 浮层面板（共用件）：工具行两颗下拉共享的唯一面板实作（材质／圆角／内距／层级／
 * 高光线只有这一份）。
 *
 * 材质 `agent-pop` ＋ `rounded-[18px] p-1.5` ＋ 顶缘 specular 高光线，素材来源＝历史
 * 下拉（`AgentChatSurface.tsx` 约 1129 行）与设定弹层（`AgentSettingsPopover.tsx` 约
 * 102 行）；`z-[85]` ＝ 压过宿主聊天壳 `.canvas-chat-panel`(z-60) 与 navbar(z-80)、
 * 又留在所有模态遮罩（89 起）之下。
 *
 * 动效用 tailwindcss-animate 的 `animate-in fade-in-0 slide-in-from-top-1`，**不得**
 * 换 `agent-pop-in`：它的 keyframes 带 `translateX(-50%)`（给 left-1/2 置中弹层用的），
 * 会把锚定面板整体左移半个宽度、内容滑出框外（已发生过的生产事故）。
 */
export function AnchoredMenuPanel({
  panelRef,
  coords,
  ariaLabel,
  children,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  coords: PanelCoords | null;
  ariaLabel: string;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label={ariaLabel}
      style={{
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        visibility: coords ? "visible" : "hidden",
      }}
      className="agent-pop fixed z-[85] w-max min-w-0 max-h-[min(60dvh,22rem)] overflow-y-auto overscroll-contain rounded-[18px] p-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-150 ease-out motion-reduce:animate-none"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
      {children}
    </div>,
    document.body,
  );
}

/**
 * 选项列（共用件）：工具行两颗下拉的唯一列实作。
 * 结构＝可选前置图示 → 标题＋说明行（两行都直接可见）→ 选中时右端勾。
 * `titleAttr` 挂原生 title（原生长说明的补充，可省）。
 */
export function MenuOptionRow({
  icon: Icon,
  title,
  subtitle,
  selected,
  disabled,
  onClick,
  titleAttr,
}: {
  icon?: LucideIcon;
  title: string;
  subtitle: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  titleAttr?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      title={titleAttr}
      className={cn(
        "flex w-full items-start gap-2 rounded-[12px] px-2.5 py-2 text-left transition-colors",
        "hover:bg-black/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected && "bg-ios-blue/[0.10]",
      )}
    >
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground/50" aria-hidden="true" />}
      <span className="flex min-w-0 flex-col">
        <span className="whitespace-nowrap text-ios-footnote font-medium text-foreground">{title}</span>
        <span className="mt-0.5 max-w-[15rem] text-ios-caption2 leading-snug text-foreground/50">
          {subtitle}
        </span>
      </span>
      {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-ios-blue" aria-hidden="true" />}
    </button>
  );
}

/**
 * 思考级别菜单（2026-10-03）：工具行同排、「+」右边的极简控件（暴君 2026-10-03
 * 三次退回悬浮形态后三选一定案，2026-10-03 二次定案改为无框语汇）。收起态＝
 * lucide `Brain` 图标 + 级别字（低/中/高/极限）+ 小 chevron，零框零底零影，
 * 与同排「+」「↑」同一套无框语言；展开态＝与「本机文件权限」共用同一套浮层
 * （AnchoredMenuPanel + MenuOptionRow），列语汇＝标题＋说明行。
 *
 * 状态归属：沿用设定既有的 localStorage 缓存 + 网关持久化链路——
 *   · 读：显式级别记录（agent-thinking-level-v1）优先，无记录由 settings 反推（resolve）。
 *   · 写：writeCachedAgentThinkingLevel（跨重载保留）+ saveAgentSettings(三栏 patch)
 *     （既有唯一写入者；interrupt_mode 由合并语义原样保留）。不另开 store。
 *
 * 交互：真 button 元素（Tab 可达 / Enter / Space 可开），Esc 关，焦点环走 --ring 主题，
 * 点击外部收起（与历史 dropdown / 设定弹层同一条 outside-click 规矩）。
 */
export function ThinkingLevelMenu({ disabled }: { disabled: boolean }) {
  // SSR 与首帧一律「中」：localStorage 只在挂载后读，避免 hydration 不一致。
  const [level, setLevel] = useState<AgentThinkingLevel>("medium");
  const [open, setOpen] = useState(false);
  // 触发钮容器：面板锚定量测与 outside-click 判定的锚。
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 展开面板已 portal 到 document.body（见 AnchoredMenuPanel），座标由此共用 hook 量测。
  const { panelRef, coords } = useAnchoredPanel(open, rootRef);

  useEffect(() => {
    // 挂载后解析：显式记录优先，否则由缓存 settings 反推，反推不到显示「中」。
    setLevel(resolveAgentThinkingLevel(readCachedAgentSettings()));
  }, []);

  // 开着时点外面就收——与历史 dropdown / 设定弹层同一条规矩（pointerdown + contains）。
  // 面板在 portal（document.body）内、不在 rootRef 子树，所以两棵树都要算「里面」。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open, panelRef]);

  // Esc 收起（语义与旧版一致：只收起，不选、不清输入框）。焦点在按钮（rootRef 内）时
  // 走 root 的 onKeyDown；焦点若落进 portal 的选项，root 收不到，故另挂一支 window keydown。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = useCallback((next: AgentThinkingLevel): void => {
    setLevel(next);
    writeCachedAgentThinkingLevel(next);
    // 既有唯一写入者：saveAgentSettings 合并当前缓存 + 三栏 patch（interrupt_mode 不动）。
    void saveAgentSettings(agentThinkingLevelPatch(next));
    setOpen(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
      }
    },
    [open],
  );

  const label = AGENT_THINKING_LEVEL_LABELS[level];

  return (
    // 工具行同排、「+」右边（暴君 2026-10-03 三选一定案）：控件进工具行流内，
    // 右边紧跟「+」，与「+」和「↑」同一条基线。
    // rootRef 只当锚点量测与 outside-click 判定；面板已 portal 到 body（见 AnchoredMenuPanel）。
    <div ref={rootRef} onKeyDown={onKeyDown} className="shrink-0 ml-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`思考级别：${label}（低/中/高/极限）`}
        title={`思考级别：${label}（低/中/高/极限）`}
        className={cn(
          // 2026-10-03 暴君定案：收起态＝脑图标＋级别字＋小 chevron，零框零底零影零胶囊，
          // 与同排「+」「↑」同一套无框语汇（旧的白底细边玻璃胶囊已删）。
          // 只换颜色/透明度，无尺寸或位移变化——hover 零 layout shift。
          // 2026-10-03 手机端：窄屏补 44px 触控高度（max-sm:min-h-11），桌面维持原行高。
          // 只加最小高度、不改宽/字级/位移——hover 与展开零 layout shift，items-center 保垂直置中。
          "flex w-max max-sm:min-h-11 shrink-0 items-center gap-1 whitespace-nowrap leading-none text-foreground/60",
          "transition-colors hover:text-ios-purple active:opacity-70",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-40",
          // 绝对定位盒走 shrink-to-fit；含块是工具行 flex。w-max＋nowrap 锁死单行不断行。
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
        )}
      >
        {/* lucide Brain（与同排 Plus / ArrowUp 同一套家族图标，风格统一）。装饰用，对辅助技术隐藏。 */}
        <Brain className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="whitespace-nowrap text-ios-footnote font-medium">{label}</span>
        {/* 尾端小 chevron：展开时 rotate-180（纯 transform，零 layout shift）。 */}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 opacity-60 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open && (
        <AnchoredMenuPanel panelRef={panelRef} coords={coords} ariaLabel="思考级别">
          {AGENT_THINKING_LEVELS.map((lv) => (
            <MenuOptionRow
              key={lv}
              // 标题＋说明行两行都直接可见；说明真源＝AGENT_THINKING_LEVEL_HINTS，同时挂 title。
              title={AGENT_THINKING_LEVEL_LABELS[lv]}
              subtitle={AGENT_THINKING_LEVEL_HINTS[lv]}
              titleAttr={AGENT_THINKING_LEVEL_HINTS[lv]}
              selected={lv === level}
              onClick={() => pick(lv)}
            />
          ))}
        </AnchoredMenuPanel>
      )}
    </div>
  );
}
