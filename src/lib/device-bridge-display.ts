// device-bridge-display.ts — 「本机档案授权 / device bridge」的显示语义与框架无关状态机。
//
// 为什么要有这一支：设定页的「本机档案」区块必须把两件容易说谎的事收敛成人话——
//   1. `window.eimuLocal` 的有无：纯浏览器＝**渐进增强**（此区显示「需要桌面版」、不给开关），
//      绝不是报错；桌面壳才有开关。
//   2. `bridge.status().state` 的六个值（off/no_authorized_roots/credentials_unavailable/
//      connecting/online/error）各自的文案与色调。
// 互动（enable/disable/pickFiles/订阅与取消订阅）若埋在 JSX 里就无法在没有 DOM 的
// node:test 验证；故把「纯显示映射」与「无框架状态机（controller）」都放本档，
// React 元件只是 useSyncExternalStore 的薄壳。
//
// 契约（冻结，照抄桌面壳将注入的形状；本档只镜射需要的子集，不 import desktop/）：
//   window.eimuLocal.authorizedRoots(): Promise<string[]>
//   window.eimuLocal.bridge.status()/enable()/disable(): Promise<BridgeStatus>
//   window.eimuLocal.onBridgeStatus(cb): () => void
//   window.eimuLocal.pickFiles({ kind, multiple? }): Promise<string[]>
//
// 本档**零 IO、零 React、零外部 import**（比照 quota-display.ts / local-media-worker.ts 的形态）。

// ─────────────────────────── 契约型别（镜射桌面壳，别 import desktop/——那是另一包产物）

export type BridgeState =
  | "off"
  | "no_authorized_roots"
  | "credentials_unavailable"
  | "connecting"
  | "online"
  | "error";

export interface BridgeStatus {
  enabled: boolean;
  state: BridgeState;
  roots: string[];
  deviceId: string | null;
  lastError?: string;
  /**
   * 本机档案权限模式（2026-10-04 冻结契约）。**旧桌面产物没有此栏位** ⇒ UI 不得
   * 假设它存在，一律走 modeFromStatus 的推导。
   */
  mode?: LocalFileMode;
}

export interface PickFilesOpts {
  kind: "directory" | "file";
  multiple?: boolean;
}

/** 本档需要的 `window.eimuLocal` 子集（其余方法不碰）。 */
export interface DeviceBridgeApi {
  bridge: {
    status(): Promise<BridgeStatus>;
    enable(): Promise<BridgeStatus>;
    disable(): Promise<BridgeStatus>;
    /**
     * 切权限模式（2026-10-04 契约新增）。**旧桌面产物没有此方法** ⇒ 一律先过
     * `supportsSetMode()` 再呼叫，并在没有它时走 enable/disable 的降级路径。
     */
    setMode?(mode: LocalFileMode): Promise<BridgeStatus>;
    /**
     * 交一张**短效装置票**给壳（2026-10-05 契约新增，W7a）。**旧桌面产物没有此方法**
     * ⇒ 一律先过 `shouldPushDeviceCredential()`（见 device-bridge-credential.ts）再呼叫。
     * 票只活主进程记忆体，绝不落盘。
     */
    setCredential?(credential: { token: string; gatewayBaseUrl: string; expiresInSec: number }): Promise<BridgeStatus>;
  };
  onBridgeStatus(cb: (status: BridgeStatus) => void): () => void;
  /**
   * 主进程说「我这边没有可用凭证，请（重新）铸一张票推过来」（2026-10-05 新增）。
   * **旧桌面产物没有** ⇒ 先特性侦测。
   */
  onCredentialRequired?(cb: () => void): () => void;
  pickFiles(opts: PickFilesOpts): Promise<string[]>;
}

// ─────────────────────────── 侦测（纯浏览器＝不可用，不是错误）

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 形状守卫：只有当 `bridge.status/enable/disable`、`onBridgeStatus`、`pickFiles`
 * 都是函式时才算「桌面壳且此功能可用」。缺任一项即视为纯浏览器（渐进增强）。
 */
export function isDeviceBridgeApi(api: unknown): api is DeviceBridgeApi {
  if (!isRecord(api)) return false;
  const bridge = api.bridge;
  if (!isRecord(bridge)) return false;
  return (
    typeof api.pickFiles === "function" &&
    typeof api.onBridgeStatus === "function" &&
    typeof bridge.status === "function" &&
    typeof bridge.enable === "function" &&
    typeof bridge.disable === "function"
  );
}

/**
 * 读全域 `window.eimuLocal`（浏览器里 window === globalThis；node 测试亦然）。
 * 与 local-media-worker.ts 的 `getLocalApi()` 同一条读法，不另造第二套来源侦测。
 */
export function getDeviceBridgeApi(): unknown {
  const g = globalThis as typeof globalThis & { eimuLocal?: unknown };
  return g.eimuLocal;
}

// ─────────────────────────── 可用性（有无 eimuLocal → 可不可用）

export interface BridgeAvailability {
  available: boolean;
  label: string;
  description: string;
}

/** 纯浏览器时的固定文案（单一真源；测试钉死）。 */
export const BRIDGE_UNAVAILABLE_LABEL = "此功能需要桌面版";

export function describeBridgeAvailability(api: unknown): BridgeAvailability {
  if (!isDeviceBridgeApi(api)) {
    return {
      available: false,
      label: BRIDGE_UNAVAILABLE_LABEL,
      description: "下载 Eimu 桌面版后，才能在这里授权本机资料夹给 agent 读取。",
    };
  }
  return { available: true, label: "", description: "" };
}

// ─────────────────────────── state → 文案／色调（纯函式）

export type BridgeTone = "off" | "info" | "ok" | "warn" | "error";

export interface BridgeDisplay {
  /** 一行状态人话。 */
  label: string;
  tone: BridgeTone;
  /** 补充说明（人话，可空）。 */
  description: string;
  /** 是否处于「已连上」的可运作状态。 */
  connected: boolean;
  /** 已授权根（原样带回供 UI 列清单）。 */
  roots: string[];
}

/** 未知 state 的固定文案（契约漂移时宁可说「未知」，不画假状态）。 */
export const BRIDGE_UNKNOWN_LABEL = "未知状态";

/**
 * 把 bridge 状态翻成展示语义。纯函式：给定 status，输出恒定。
 * status=null 代表「还没读到」（初次载入中），显示读取中而非假装未开启。
 */
export function describeBridgeStatus(status: BridgeStatus | null): BridgeDisplay {
  if (!status) {
    return {
      label: "读取中…",
      tone: "info",
      description: "正在确认装置连线状态。",
      connected: false,
      roots: [],
    };
  }
  const roots = Array.isArray(status.roots) ? status.roots.slice() : [];
  switch (status.state) {
    case "online":
      return {
        label: "已连上",
        tone: "ok",
        description: "agent 只能在下列已授权的资料夹内读取档案。",
        connected: true,
        roots,
      };
    case "off":
      return {
        label: "未开启",
        tone: "off",
        description: "开启后，agent 才能读取你在这里授权的资料夹。",
        connected: false,
        roots,
      };
    case "no_authorized_roots":
      return {
        label: "已开启 · 尚未选择资料夹",
        tone: "warn",
        description: "请先选择要授权的资料夹。",
        connected: false,
        roots,
      };
    case "credentials_unavailable":
      // 据实改写（2026-10-11）：旧的「手放装置凭证档」是操作者路径的措辞，对真实
      // 使用者是误导；真相是「页面正在向壳换一张短效票」，换不到才是停在这里。
      return {
        label: "已开启 · 正在获取权限",
        tone: "warn",
        description: "正在获取本机文件权限…若一直停在这里，请点「重试」或重新登录。",
        connected: false,
        roots,
      };
    case "connecting":
      return {
        label: "连线中…",
        tone: "info",
        description: "正在与装置建立连线。",
        connected: false,
        roots,
      };
    case "error":
      return {
        label: "连线出错",
        tone: "error",
        description: status.lastError?.trim() || "连线发生错误，请稍后重试。",
        connected: false,
        roots,
      };
    default:
      return {
        label: BRIDGE_UNKNOWN_LABEL,
        tone: "warn",
        description: `未预期的状态：${String((status as { state?: unknown }).state)}`,
        connected: false,
        roots,
      };
  }
}

/** tone → 文字色 class（与 quota-display 的 tone 分流同形态；集中在纯函式，不埋进 JSX）。 */
export function bridgeToneClass(tone: BridgeTone): string {
  switch (tone) {
    case "ok":
      return "text-[#1a7a3a]";
    case "warn":
      return "text-[#8a6410]";
    case "error":
      return "text-[#b3271c]";
    case "info":
      return "text-[#0a5bd3]";
    case "off":
    default:
      return "text-[rgba(0,0,0,0.50)]";
  }
}

// ─────────────────────────── 失败态 → 可点的「下一步」（文案＝单一真源）

/** 使用者在本机档案权限卡上能主动做的一件事。 */
export type BridgeActionKind = "pick_directory" | "retry_credential" | "login";

export interface BridgeActionHint {
  kind: BridgeActionKind;
  /** 按钮文字（真源在此，组件不得另写）。 */
  label: string;
  /** 行动上方的一行人话（真源在此，组件不得另写）。 */
  description: string;
  tone: BridgeTone;
}

/**
 * 把「本机档案权限」的失败态翻成使用者能按的一步（纯函式）。
 *
 * 为什么要有它（2026-10-11）：`pickDirectory()` 早就存在却零呼叫点 ⇒ 使用者无从
 * 授权任何资料夹；凭证换不到时也是静默死等。这条把两种「卡住」都收敛成一颗按钮，
 * 未登录时另点明「登录后才能开启」——不再让使用者对着没有出口的状态发呆。
 *
 * 只对**需要使用者动作**的两个状态给行动；其余（off/connecting/online/error 等）
 * 一律回 null，维持现状不动。
 */
export function describeBridgeAction(state: BridgeState, loggedIn: boolean): BridgeActionHint | null {
  switch (state) {
    case "no_authorized_roots":
      return {
        kind: "pick_directory",
        label: "选择文件夹…",
        description: "还没授权任何文件夹，agent 现在读不到本机档案。",
        tone: "warn",
      };
    case "credentials_unavailable":
      return loggedIn
        ? {
            kind: "retry_credential",
            label: "重试",
            description: "正在获取本机文件权限…",
            tone: "info",
          }
        : {
            kind: "login",
            label: "登录",
            description: "登录后才能开启本机文件权限。",
            tone: "warn",
          };
    default:
      return null;
  }
}

/**
 * 收起态 chip 该不该给警示（纯函式）。true＝已开启却没有任何授权根，或凭证未就绪。
 *
 * 刻意不含 `off`（status.enabled=false）：那是使用者自己关掉的，警示会变噪音；
 * 也不含 status=null（还在读）。
 */
export function bridgeNeedsAttention(status: BridgeStatus | null): boolean {
  if (!status) return false;
  if (status.state === "credentials_unavailable") return true;
  if (!status.enabled) return false;
  const roots = Array.isArray(status.roots) ? status.roots : [];
  return roots.length === 0;
}

// ─────────────────────────── 本机档案权限模式（四档；文案＝单一真源）

/**
 * 四档权限模式（冻结契约）。**此处是文案的唯一真源**：UI 不得另写一份字串，
 * 一律经 `LOCAL_FILE_MODES` / `describeLocalFileMode()` 取用。
 *
 * 模式语义逐字采用产品规格，不得改写。
 */
export type LocalFileMode = "off" | "ask" | "auto" | "full";

/** 图示语义名。本档零外部 import（不引 lucide）——UI 依此名映射到具体图示元件。 */
export type LocalFileModeIcon = "power" | "message-circle-question" | "folder-check" | "globe";

export interface LocalFileModeSpec {
  id: LocalFileMode;
  icon: LocalFileModeIcon;
  title: string;
  subtitle: string;
}

export const LOCAL_FILE_MODES: readonly LocalFileModeSpec[] = [
  { id: "off", icon: "power", title: "关闭", subtitle: "agent 不能读取本机档案。" },
  {
    id: "ask",
    icon: "message-circle-question",
    title: "读取允许，写入询问",
    subtitle: "已授权资料夹内直接读取；范围外或要写入时才问你。",
  },
  {
    id: "auto",
    icon: "folder-check",
    title: "授权范围内自动",
    subtitle: "已授权资料夹内自动读取，范围外会先问你。",
  },
  {
    id: "full",
    icon: "globe",
    title: "完全访问",
    subtitle: "自动执行并同意所有扣费；整个家目录可读，敏感位置（~/.ssh、~/.aws、私钥等）仍不读取。",
  },
] as const;

export const LOCAL_FILE_MODE_IDS: readonly LocalFileMode[] = LOCAL_FILE_MODES.map((m) => m.id);

/** tone 只给标题上色（收敛在最宽松的一档用 warn 提示）。 */
const LOCAL_FILE_MODE_TONES: Record<LocalFileMode, BridgeTone> = {
  off: "off",
  ask: "info",
  auto: "ok",
  full: "warn",
};

export function isLocalFileMode(value: unknown): value is LocalFileMode {
  return typeof value === "string" && (LOCAL_FILE_MODE_IDS as readonly string[]).includes(value);
}

export interface LocalFileModeDisplay {
  title: string;
  subtitle: string;
  tone: BridgeTone;
}

/** mode → 文案／色调（纯函式）。未知值回退 off，不 throw（契约漂移时宁可保守）。 */
export function describeLocalFileMode(mode: LocalFileMode): LocalFileModeDisplay {
  const spec = LOCAL_FILE_MODES.find((m) => m.id === mode) ?? LOCAL_FILE_MODES[0];
  return { title: spec.title, subtitle: spec.subtitle, tone: LOCAL_FILE_MODE_TONES[spec.id] };
}

export interface LocalFileModeResolution {
  mode: LocalFileMode;
  /** true＝由 enabled/roots 推导（壳没回报真值 mode 栏位）；false＝壳回报的真值。 */
  derived: boolean;
  /** false＝status 尚未读到（null）；mode 仅为占位，UI 不得显示成「已选中」。 */
  known: boolean;
}

/**
 * 从 bridge status 得到模式。真值优先；**旧产物没有 mode 栏位**时推导：
 *   !enabled → off；enabled && roots 非空 → auto；enabled && roots 空 → ask。
 * 推导结果一律带 `derived: true`，让 UI／回报能标明「这是推导不是真值」。
 */
export function modeFromStatus(status: BridgeStatus | null): LocalFileModeResolution {
  if (!status) return { mode: "off", derived: true, known: false };
  if (isLocalFileMode(status.mode)) return { mode: status.mode, derived: false, known: true };
  const roots = Array.isArray(status.roots) ? status.roots : [];
  if (!status.enabled) return { mode: "off", derived: true, known: true };
  return roots.length > 0
    ? { mode: "auto", derived: true, known: true }
    : { mode: "ask", derived: true, known: true };
}

/**
 * 下一次重推短效票的延迟（毫秒）：提前 60s 刷新，夹在 [30s, 10min]。
 * 下界防「TTL 很短时变成忙回圈」，上界防「票过期前没来得及换」。纯函式（本档零 IO）。
 */
export function credentialRefreshDelayMs(expiresInSec: number): number {
  const ttlMs =
    Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : DEFAULT_DEVICE_TICKET_TTL_SEC * 1000;
  return Math.min(Math.max(ttlMs - 60_000, 30_000), 10 * 60_000);
}

/** 上游没给票期时的退路（秒）——与闸道预设 600s 同值。 */
export const DEFAULT_DEVICE_TICKET_TTL_SEC = 600;

/** 旧桌面产物没有 `bridge.setMode` ⇒ 选择器可见但须 disabled（不得 throw）。 */
export function supportsSetMode(api: unknown): boolean {
  if (!isRecord(api)) return false;
  const bridge = api.bridge;
  if (!isRecord(bridge)) return false;
  return typeof bridge.setMode === "function";
}

// ─────────────────────────── 无框架状态机（互动可测；元件只是它的薄壳）

export interface DeviceBridgeSnapshot {
  /** 桌面壳且有此 API 子集。 */
  available: boolean;
  /** 最新一次 status（null＝还没读到）。 */
  status: BridgeStatus | null;
  /** 初次 status 读取中。 */
  loading: boolean;
  /** enable/disable/pickFiles 进行中。 */
  busy: boolean;
  /** 最近一次操作的错误讯息（人话；成功即清空）。 */
  notice: string | null;
}

export interface DeviceBridgeController {
  getSnapshot(): DeviceBridgeSnapshot;
  /**
   * SSR／hydration 用的固定快照（一律「未侦测」）：伺服器没有 window，桌面壳的能力
   * 只能在浏览器得知；首画格一律相同，避免 hydration mismatch，挂载后由 effect 换上真状态。
   */
  getServerSnapshot(): DeviceBridgeSnapshot;
  subscribe(listener: () => void): () => void;
  /** 挂载时呼叫：订阅 onBridgeStatus 并读一次 status。 */
  init(): void;
  /** 重读 status（例：选完资料夹后，授权根变了壳会自动重注册）。 */
  refresh(): Promise<void>;
  /** 开／关授权桥接。 */
  setEnabled(enabled: boolean): Promise<void>;
  /**
   * 切本机档案权限模式（2026-10-04 新增；既有方法语义不动）。
   *   · 有 bridge.setMode → 直接切（非 off 且壳回报未 enabled 时补一次 enable）。
   *   · 无 bridge.setMode（旧产物）→ off 走 disable()、非 off 走 enable() 的降级。
   * 失败一律收敛成 notice，不 throw。
   */
  setMode(mode: LocalFileMode): Promise<void>;
  /** 选资料夹（挑完即授权该路径）并重读 status。回传已授权路径（失败回空阵列）。 */
  pickDirectory(): Promise<string[]>;
  /**
   * 重推一张短效装置票（2026-10-11）。给「credentials_unavailable」的「重试」
   * 用：复用既有的推票流程（挂载／索取／到期前走的同一条 pushCredentialOnce），
   * 不复制逻辑。未注入 pushCredential 时是无操作。
   */
  refreshCredential(): Promise<void>;
  /** 卸载时呼叫：取消订阅、标记 disposed，之后不再 notify。 */
  dispose(): void;
}

/** SSR／hydration 首画格固定值：伺服器无 window，桌面能力只能在浏览器得知。 */
const SERVER_SNAPSHOT: DeviceBridgeSnapshot = Object.freeze({
  available: false,
  status: null,
  loading: false,
  busy: false,
  notice: null,
});

function errText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "操作失败，请稍后重试。";
}

/**
 * 建立 controller。`getApi` 每次读取当下全域（测试可注入假件）。
 * 一律不 throw：任何失败都转成 snapshot.notice，不中断 UI。
 */
export function createDeviceBridgeController(
  getApi: () => unknown = getDeviceBridgeApi,
  opts: {
    /** 远端页面兼容旧桌面：云端权限同步成功后才切本机模式。 */
    syncMode?: (mode: LocalFileMode) => Promise<void>;
    /**
     * 换一张短效装置票并推给壳（W7a）。由呼叫端注入**有 IO 的那一支**
     * （`device-bridge-credential.ts` 的 fetchAndPushDeviceCredential），本档维持零 IO。
     * 回传实际推成功的票（含 expiresInSec）以便排下一次刷新；没推成回 null。
     * 未注入＝完全不碰凭证（纯浏览器与旧桌面产物都不该被呼叫）。
     */
    pushCredential?: () => Promise<{ expiresInSec: number } | null>;
  } = {},
): DeviceBridgeController {
  const pushCredential = typeof opts.pushCredential === "function" ? opts.pushCredential : null;
  let disposed = false;
  const listeners = new Set<() => void>();
  let unsubscribeStatus: (() => void) | null = null;
  let unsubscribeCredentialRequired: (() => void) | null = null;
  let credentialTimer: ReturnType<typeof setTimeout> | null = null;
  let initialized = false;

  const api = (): DeviceBridgeApi | null => {
    const candidate = getApi();
    return isDeviceBridgeApi(candidate) ? candidate : null;
  };

  // 初次快照：立即可知「有无 API」，让纯浏览器第一画格就诚实显示「需要桌面版」
  //（也让 SSR/hydration 的首画格一致；status 才需进 effect 读）。
  let snapshot: DeviceBridgeSnapshot = {
    available: api() !== null,
    status: null,
    loading: api() !== null,
    busy: false,
    notice: null,
  };

  const notify = () => {
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  };

  const patch = (next: Partial<DeviceBridgeSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    notify();
  };

  const applyStatus = (status: BridgeStatus | null) => {
    patch({ status, loading: false });
  };

  const refresh = async (): Promise<void> => {
    const a = api();
    if (!a) return;
    try {
      const status = await a.bridge.status();
      if (!disposed) applyStatus(status);
    } catch (e) {
      if (!disposed) patch({ loading: false, notice: errText(e) });
    }
  };

  const setEnabled = async (enabled: boolean): Promise<void> => {
    const a = api();
    if (!a) return;
    patch({ busy: true, notice: null });
    try {
      const status = enabled ? await a.bridge.enable() : await a.bridge.disable();
      if (disposed) return;
      patch({ status, loading: false, busy: false });
    } catch (e) {
      if (!disposed) patch({ busy: false, notice: errText(e) });
    }
  };

  /**
   * 切权限模式。有 setMode 走它；没有（旧产物）就 off→disable、非 off→enable 降级。
   * 非 off 且切完仍 !enabled 时补一次 enable（契约：其他档若未启用则同时启用）。
   */
  const setMode = async (mode: LocalFileMode): Promise<void> => {
    const a = api();
    if (!a) return;
    patch({ busy: true, notice: null });
    try {
      let next: BridgeStatus;
      if (opts.syncMode) await opts.syncMode(mode);
      if (typeof a.bridge.setMode === "function") {
        next = await a.bridge.setMode(mode);
        if (next.mode !== undefined && next.mode !== mode) {
          throw new Error(next.lastError || "桌面权限尚未切换，当前选择保持不变，请重试。");
        }
        if (mode !== "off" && !next.enabled) next = await a.bridge.enable();
      } else if (mode === "off") {
        next = await a.bridge.disable();
      } else {
        next = await a.bridge.enable();
      }
      if (disposed) return;
      patch({ status: next, loading: false, busy: false });
    } catch (e) {
      if (!disposed) patch({ busy: false, notice: errText(e) });
    }
  };

  const pickDirectory = async (): Promise<string[]> => {
    const a = api();
    if (!a) return [];
    patch({ busy: true, notice: null });
    try {
      const picked = await a.pickFiles({ kind: "directory", multiple: true });
      if (disposed) return picked;
      // 挑完即授权该路径，授权根变了 → 壳会自动重注册，故重读 status。
      patch({ busy: false });
      await refresh();
      return picked;
    } catch (e) {
      if (!disposed) patch({ busy: false, notice: errText(e) });
      return [];
    }
  };

  /**
   * W7a：把「什么时候该推票」做完——挂载时推一次、主进程索取时推一次、到期前推一次。
   * 实际换票动作在注入的 pushCredential 里；任何失败都只是「这次没票」，不 throw、
   * 不改任何既有状态（桥没票时的行为本来就是安全的 credentials_unavailable）。
   */
  const pushCredentialOnce = async (): Promise<void> => {
    if (!pushCredential || disposed) return;
    let pushed: { expiresInSec: number } | null = null;
    try {
      pushed = await pushCredential();
    } catch {
      pushed = null;
    }
    if (disposed) return;
    if (pushed && Number.isFinite(pushed.expiresInSec) && pushed.expiresInSec > 0) {
      scheduleCredentialRefresh(pushed.expiresInSec);
    }
  };

  const scheduleCredentialRefresh = (expiresInSec: number): void => {
    if (disposed || !pushCredential) return;
    if (credentialTimer) clearTimeout(credentialTimer);
    const delay = credentialRefreshDelayMs(expiresInSec);
    credentialTimer = setTimeout(() => {
      credentialTimer = null;
      void pushCredentialOnce();
    }, delay);
  };

  const init = (): void => {
    if (initialized || disposed) return;
    initialized = true;
    const a = api();
    if (!a) {
      // 纯浏览器：维持 available:false，无事可做（不是报错）。
      patch({ available: false, loading: false });
      return;
    }
    patch({ available: true, loading: true });
    try {
      unsubscribeStatus = a.onBridgeStatus((status) => {
        if (!disposed) patch({ status, loading: false });
      });
    } catch {
      unsubscribeStatus = null;
    }
    // 票只推给「支持 setCredential 且注入过推票动作」的壳（旧桌面产物一律不碰）。
    if (pushCredential && typeof a.bridge.setCredential === "function") {
      try {
        unsubscribeCredentialRequired =
          typeof a.onCredentialRequired === "function"
            ? a.onCredentialRequired(() => {
                void pushCredentialOnce();
              })
            : null;
      } catch {
        unsubscribeCredentialRequired = null;
      }
      void pushCredentialOnce();
    }
    void refresh();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (credentialTimer) {
      clearTimeout(credentialTimer);
      credentialTimer = null;
    }
    if (unsubscribeCredentialRequired) {
      try {
        unsubscribeCredentialRequired();
      } catch {
        /* 幂等：取消订阅失败不影响卸载 */
      }
      unsubscribeCredentialRequired = null;
    }
    if (unsubscribeStatus) {
      try {
        unsubscribeStatus();
      } catch {
        /* 幂等：取消订阅失败不影响卸载 */
      }
      unsubscribeStatus = null;
    }
    listeners.clear();
  };

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    init,
    refresh,
    setEnabled,
    setMode,
    pickDirectory,
    // 复用同一条推票流程（挂载／被索取／到期前用的就是它）；没注入 pushCredential
    // 时 pushCredentialOnce 是无操作，故这里不必另判。
    refreshCredential: pushCredentialOnce,
    dispose,
  };
}
