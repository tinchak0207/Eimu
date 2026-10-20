import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, FolderCheck, Globe, HardDrive, MessageCircleQuestion, Power, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LOCAL_FILE_MODES,
  bridgeNeedsAttention,
  bridgeToneClass,
  createDeviceBridgeController,
  describeBridgeAction,
  describeBridgeAvailability,
  describeLocalFileMode,
  getDeviceBridgeApi,
  modeFromStatus,
  supportsSetMode,
  type BridgeActionKind,
  type BridgeState,
  type DeviceBridgeController,
  type LocalFileMode,
  type LocalFileModeIcon,
} from "@/lib/device-bridge-display";
import { fetchAndPushDeviceCredential } from "@/lib/device-bridge-credential";
import { getStoredToken } from "@/lib/new-api-client";
import { useGithubLoginHandoff } from "@/hooks/use-github-login-handoff";
import { PwaHandoffPanel } from "@/components/PwaHandoffPanel";
import { syncDevicePermissionMode } from "@/lib/agent-chat-client";
import { AnchoredMenuPanel, MenuOptionRow, useAnchoredPanel } from "./AgentComposer.menus";

/**
 * 本机档案权限模式菜单（2026-10-04）：与相邻的 ThinkingLevelMenu 同一套无框语汇，
 * 工具行流内、「+」右边紧跟思考级别（同一颗工具列的两颗同族控件）。
 *
 * 收起态＝模式图示＋模式名＋小 chevron，零框零底零影；展开态＝四档清单
 * （图示＋标题＋副标＋右端勾），底下补一行「已授权 N 个资料夹」。
 *
 * 模式文案的唯一真源是 `@/lib/device-bridge-display` 的 LOCAL_FILE_MODES；
 * 本档不得另写一份字串。
 *
 * 渐进增强（比照 local-media-worker / device-bridge-display 的既有惯例）：
 *   · 无 window.eimuLocal（纯浏览器）⇒ 整颗控件回 null，不渲染（不是报错）。
 *   · 旧桌面产物（bridge.setMode 不存在）⇒ 可见但 disabled，副标提示「需更新桌面版」。
 *   · 旧 status 没有 mode 栏位 ⇒ 由 enabled/roots 推导（modeFromStatus），不假装真值。
 *
 * 授权入口就在这里（2026-10-11 修正）：面板内「已授权数量」那行下面按 `status.state`
 * 渲染一颗可点的行动——`no_authorized_roots` 给「选择文件夹…」（呼叫既有唯一授权来源
 * `controller.pickDirectory()`），`credentials_unavailable` 给「重试」（重推短效票）或
 * 「登录」。旧注释「授权在对话流程问」是空头承诺，对话流程从没问过。
 */
const LOCAL_FILE_MODE_ICONS: Record<LocalFileModeIcon, LucideIcon> = {
  power: Power,
  "message-circle-question": MessageCircleQuestion,
  "folder-check": FolderCheck,
  globe: Globe,
};

export interface LocalFileModeMenuViewProps {
  open: boolean;
  onToggleOpen: () => void;
  onPick: (mode: LocalFileMode) => void;
  /** 旧产物（bridge.setMode 不存在）＝false ⇒ disabled。 */
  supported: boolean;
  /** status 是否已读到；false 时不把任何一档画成「已选中」。 */
  known: boolean;
  mode: LocalFileMode;
  rootsCount: number;
  busy: boolean;
  /** 壳回报的原始连线状态（null＝还没读到）；行动行的判准。 */
  state: BridgeState | null;
  /** 页面是否已登录（未登录时行动行改点「登录」）。 */
  loggedIn: boolean;
  /** 收起态是否给警示（已开启却没授权根／凭证未就绪）；由壳的 bridgeNeedsAttention 算好。 */
  attention: boolean;
  /** 授权一个资料夹（授权入口真源＝controller.pickDirectory）。 */
  onPickDirectory: () => void;
  /** 重推短效装置票（credentials_unavailable 的重试）。 */
  onRetryCredential: () => void;
  /** 走站内既有登入入口（未登录时）。 */
  onLogin: () => void;
}

/** 纯展示层（受控）：文案／图示由纯函式与 LOCAL_FILE_MODES 算好，本层只画。 */
export function LocalFileModeMenuView({
  open,
  onToggleOpen,
  onPick,
  supported,
  known,
  mode,
  rootsCount,
  busy,
  state,
  loggedIn,
  attention,
  onPickDirectory,
  onRetryCredential,
  onLogin,
}: LocalFileModeMenuViewProps) {
  const currentSpec = LOCAL_FILE_MODES.find((m) => m.id === mode) ?? LOCAL_FILE_MODES[0];
  const current = describeLocalFileMode(mode);
  const CurrentIcon = known ? LOCAL_FILE_MODE_ICONS[currentSpec.icon] : HardDrive;
  const label = known ? current.title : "本机文件";
  const disabled = !supported;
  // 行动行的文案真源＝describeBridgeAction；本层不另写字串。
  const action = state ? describeBridgeAction(state, loggedIn) : null;
  const onAction = (kind: BridgeActionKind): void => {
    if (kind === "pick_directory") onPickDirectory();
    else if (kind === "retry_credential") onRetryCredential();
    else onLogin();
  };

  // 触发钮容器（chip）：面板锚定量测与 outside-click 判定的锚。
  const triggerRef = useRef<HTMLDivElement | null>(null);
  // 面板已 portal 到 document.body；只在展开且可用时才量座标。
  const { panelRef, coords } = useAnchoredPanel(open && !disabled, triggerRef);

  // 面板 portal 后不在本子树：落在 portal 选项上的点击／按键，chip 容器都收不到，
  // 故 outside-click 与 Esc 另挂 document／window，且「触发钮或面板」皆算里面
  // （否则点面板自己的选项会被判成点外面）。本监听只在 open 时存在，调 onToggleOpen 即关。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onToggleOpen();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onToggleOpen();
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onToggleOpen, panelRef]);

  return (
    // 与相邻 ThinkingLevelMenu 用同一套浮层：useAnchoredPanel + AnchoredMenuPanel +
    // MenuOptionRow（面板与选项列只存在一份实作）。triggerRef 仅供锚定与 outside-click 判定。
    <div
      ref={triggerRef}
      className="shrink-0 ml-1"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          onToggleOpen();
        }
      }}
    >
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`本机文件权限：${label}`}
        title={disabled ? "本机文件权限：需更新桌面版" : `本机文件权限：${label}`}
        className={cn(
          // 与同排「+」「↑」「思考级别」同一套无框语汇：只换颜色/透明度，零 layout shift。
          "flex w-max max-sm:min-h-11 shrink-0 items-center gap-1 whitespace-nowrap leading-none text-foreground/60",
          "transition-colors hover:text-ios-purple active:opacity-70",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-40",
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
          // 需要使用者动作（未授权根／凭证未就绪）时整颗 chip 走既有 warn 字色，
          // twMerge 会用它盖掉上面的 muted 色（同一群组取后者）。
          attention && cn(bridgeToneClass("warn"), "hover:text-[#8a6410]"),
        )}
      >
        {attention && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        )}
        <CurrentIcon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="whitespace-nowrap text-ios-footnote font-medium">{label}</span>
        {disabled && <span className="whitespace-nowrap text-ios-caption2 text-foreground/40">需更新桌面版</span>}
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && !disabled && (
        <AnchoredMenuPanel panelRef={panelRef} coords={coords} ariaLabel="本机文件权限">
          {LOCAL_FILE_MODES.map((spec) => (
            <MenuOptionRow
              key={spec.id}
              icon={LOCAL_FILE_MODE_ICONS[spec.icon]}
              // 文案真源＝LOCAL_FILE_MODES，本档不另写一份字串。
              title={spec.title}
              subtitle={spec.subtitle}
              selected={known && spec.id === mode}
              disabled={busy}
              onClick={() => onPick(spec.id)}
            />
          ))}
          {/* 页脚钉底（sticky）：面板有 max-h + 滚动，授权/重试/登录这颗「下一步」若
              跟着内容滚出视窗就等于没有。负外边距吃掉 AnchoredMenuPanel 的 p-1.5，
              让页脚贴齐面板底缘、底色与 .agent-pop 同值。 */}
          <div className="sticky bottom-0 -mx-1.5 -mb-1.5 rounded-b-[18px] bg-[rgba(255,255,255,0.96)] px-1.5 pb-1.5 backdrop-blur-sm">
            {/* 已授权数量：检视用。 */}
            <p className="mt-1 border-t border-black/[0.06] px-2.5 pb-1.5 pt-2 text-ios-caption2 text-foreground/45">
              {rootsCount > 0 ? `已授权 ${rootsCount} 个文件夹` : "尚未授权任何文件夹"}
            </p>
            {/* 失败态的可点下一步（2026-10-11）：文案真源＝describeBridgeAction。 */}
            {action && (
              <div className="px-2.5 pb-2">
                <p className={cn("text-ios-caption2 leading-snug", bridgeToneClass(action.tone))}>
                  {action.description}
                </p>
                <button
                  type="button"
                  data-db-action={action.kind}
                  disabled={busy}
                  onClick={() => onAction(action.kind)}
                  className={cn(
                    "mt-1.5 w-full rounded-[10px] px-2.5 py-1.5 text-ios-footnote font-semibold transition-colors",
                    "bg-ios-blue/[0.12] text-ios-blue hover:bg-ios-blue/[0.20]",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {action.label}
                </button>
              </div>
            )}
          </div>
        </AnchoredMenuPanel>
      )}
    </div>
  );
}

/**
 * 薄壳：建立 controller、订阅它（useSyncExternalStore）、把纯函式吐出的语义交给展示层。
 * 纯浏览器（无 `window.eimuLocal`）时 controller 快照 `available:false` ⇒ 本层**不再静默
 * 消失**，改渲染一行「此功能需要桌面版」（2026-10-05 修正：`describeBridgeAvailability`
 * 本来是死码，使用者只看到控件不见、连一句解释都没有）。
 *
 * W7a（2026-10-05）：壳支持 `bridge.setCredential` 时，本层挂载即向站内换一张短效装置票
 * 并推给壳（换票动作在有 IO 的 `device-bridge-credential.ts`；本档只把动作注入 controller）。
 */
export function LocalFileModeMenu() {
  const controllerRef = useRef<DeviceBridgeController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createDeviceBridgeController(getDeviceBridgeApi, {
      syncMode: syncDevicePermissionMode,
      pushCredential: async () => {
        const pushed = await fetchAndPushDeviceCredential(getDeviceBridgeApi());
        return pushed ? { expiresInSec: pushed.expiresInSec } : null;
      },
    });
  }
  const controller = controllerRef.current;
  const [open, setOpen] = useState(false);
  // SSR／hydration：伺服器没有 window，无法判定「是不是桌面壳」。等挂载后才敢下结论，
  // 否则壳内首画格会闪一行「需要桌面版」（与 DesktopDownloadButton 的 checked 同一条规矩）。
  const [mounted, setMounted] = useState(false);
  // 登录态：驱动 credentials_unavailable 时的分流（未登录 ⇒ 点「登录」，已登录 ⇒ 点「重试」）。
  // 首画格 false（伺服器无 localStorage），挂载后读一次，再跟 storage 事件（跨标签页登录）。
  const [loggedIn, setLoggedIn] = useState(false);
  // 登入入口＝站内既有那一条（standalone PWA／Electron 壳走跨浏览器交接，其余同窗口跳转）；
  // 本档不自己拼路由。
  const { handoffUrl, startLogin, closeHandoff } = useGithubLoginHandoff();

  useEffect(() => {
    setMounted(true);
    controller.init();
    // 卸载时取消订阅 onBridgeStatus（dispose 内含 unsubscribe）。
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const sync = (): void => setLoggedIn(!!getStoredToken());
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);

  // 开著时点外面就收：面板已 portal 到 body，判定搬进 LocalFileModeMenuView（它同时
  // 认得触发钮与面板两棵树）——本层若再挂一支只看自己子树的 pointerdown，点面板选项
  // 会被误判成「点外面」。

  // 判定未完成（SSR／首画格）一律不渲染，避免闪错。
  if (!mounted) return null;

  if (!snap.available) {
    // 纯浏览器：给一句人话，而不是让控件凭空消失（不是报错，是渐进增强的说明）。
    const availability = describeBridgeAvailability(getDeviceBridgeApi());
    return (
      <div className="shrink-0 ml-1 flex items-center gap-1 text-foreground/40" title={availability.description}>
        <HardDrive className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="whitespace-nowrap text-ios-footnote">{availability.label}</span>
      </div>
    );
  }

  const supported = supportsSetMode(getDeviceBridgeApi());
  const resolution = modeFromStatus(snap.status);
  const rootsCount = Array.isArray(snap.status?.roots) ? snap.status.roots.length : 0;
  const state = snap.status?.state ?? null;

  return (
    <div className="contents">
      <LocalFileModeMenuView
        open={open}
        onToggleOpen={() => setOpen((v) => !v)}
        onPick={(mode) => {
          setOpen(false);
          void controller.setMode(mode);
        }}
        supported={supported}
        known={resolution.known}
        mode={resolution.mode}
        rootsCount={rootsCount}
        busy={snap.busy}
        state={state}
        loggedIn={loggedIn}
        attention={bridgeNeedsAttention(snap.status)}
        onPickDirectory={() => {
          // 授权入口真源＝controller.pickDirectory（内部走既有 pickFiles IPC + 重读）。
          void controller.pickDirectory();
        }}
        onRetryCredential={() => {
          // 复用既有推票流程；推完壳会经 onBridgeStatus 回报新状态。
          void controller.refreshCredential();
        }}
        onLogin={() => {
          setOpen(false);
          void startLogin();
        }}
      />
      {/* 交接面板：登录成功后关闭交接面、刷新登录态，并让壳再推一次票。 */}
      {snap.notice && <span role="alert" className="lg-card absolute inset-x-2 bottom-full mb-2 rounded-xl px-3 py-2 text-ios-footnote text-ios-red whitespace-normal break-words">{snap.notice}</span>}
      {handoffUrl && (
        <PwaHandoffPanel
          loginUrl={handoffUrl}
          onSuccess={() => {
            closeHandoff();
            setLoggedIn(!!getStoredToken());
            void controller.refreshCredential();
            void controller.refresh();
          }}
          onClose={closeHandoff}
        />
      )}
    </div>
  );
}
