// device-bridge-display.ts — 「本機檔案授權 / device bridge」的顯示語義與框架無關狀態機。
//
// 為什麼要有這一支：設定頁的「本機檔案」區塊必須把兩件容易說謊的事收斂成人話——
//   1. `window.eimuLocal` 的有無：純瀏覽器＝**漸進增強**（此區顯示「需要桌面版」、不給開關），
//      絕不是報錯；桌面殼才有開關。
//   2. `bridge.status().state` 的六個值（off/no_authorized_roots/credentials_unavailable/
//      connecting/online/error）各自的文案與色調。
// 互動（enable/disable/pickFiles/訂閱與取消訂閱）若埋在 JSX 裡就無法在沒有 DOM 的
// node:test 驗證；故把「純顯示映射」與「無框架狀態機（controller）」都放本檔，
// React 元件只是 useSyncExternalStore 的薄殼。
//
// 契約（凍結，照抄桌面殼將注入的形狀；本檔只鏡射需要的子集，不 import desktop/）：
//   window.eimuLocal.authorizedRoots(): Promise<string[]>
//   window.eimuLocal.bridge.status()/enable()/disable(): Promise<BridgeStatus>
//   window.eimuLocal.onBridgeStatus(cb): () => void
//   window.eimuLocal.pickFiles({ kind, multiple? }): Promise<string[]>
//
// 本檔**零 IO、零 React、零外部 import**（比照 quota-display.ts / local-media-worker.ts 的形態）。

// ─────────────────────────── 契約型別（鏡射桌面殼，別 import desktop/——那是另一包產物）

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
   * 本機檔案權限模式（2026-10-04 凍結契約）。**舊桌面產物沒有此欄位** ⇒ UI 不得
   * 假設它存在，一律走 modeFromStatus 的推導。
   */
  mode?: LocalFileMode;
}

export interface PickFilesOpts {
  kind: "directory" | "file";
  multiple?: boolean;
}

/** 本檔需要的 `window.eimuLocal` 子集（其餘方法不碰）。 */
export interface DeviceBridgeApi {
  bridge: {
    status(): Promise<BridgeStatus>;
    enable(): Promise<BridgeStatus>;
    disable(): Promise<BridgeStatus>;
    /**
     * 切權限模式（2026-10-04 契約新增）。**舊桌面產物沒有此方法** ⇒ 一律先過
     * `supportsSetMode()` 再呼叫，並在沒有它時走 enable/disable 的降級路徑。
     */
    setMode?(mode: LocalFileMode): Promise<BridgeStatus>;
  };
  onBridgeStatus(cb: (status: BridgeStatus) => void): () => void;
  pickFiles(opts: PickFilesOpts): Promise<string[]>;
}

// ─────────────────────────── 偵測（純瀏覽器＝不可用，不是錯誤）

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 形狀守衛：只有當 `bridge.status/enable/disable`、`onBridgeStatus`、`pickFiles`
 * 都是函式時才算「桌面殼且此功能可用」。缺任一項即視為純瀏覽器（漸進增強）。
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
 * 讀全域 `window.eimuLocal`（瀏覽器裡 window === globalThis；node 測試亦然）。
 * 與 local-media-worker.ts 的 `getLocalApi()` 同一條讀法，不另造第二套來源偵測。
 */
export function getDeviceBridgeApi(): unknown {
  const g = globalThis as typeof globalThis & { eimuLocal?: unknown };
  return g.eimuLocal;
}

// ─────────────────────────── 可用性（有無 eimuLocal → 可不可用）

export interface BridgeAvailability {
  available: boolean;
  label: string;
  description: string;
}

/** 純瀏覽器時的固定文案（單一真源；測試釘死）。 */
export const BRIDGE_UNAVAILABLE_LABEL = "此功能需要桌面版";

export function describeBridgeAvailability(api: unknown): BridgeAvailability {
  if (!isDeviceBridgeApi(api)) {
    return {
      available: false,
      label: BRIDGE_UNAVAILABLE_LABEL,
      description: "下載 Eimu 桌面版後，才能在這裡授權本機資料夾給 agent 讀取。",
    };
  }
  return { available: true, label: "", description: "" };
}

// ─────────────────────────── state → 文案／色調（純函式）

export type BridgeTone = "off" | "info" | "ok" | "warn" | "error";

export interface BridgeDisplay {
  /** 一行狀態人話。 */
  label: string;
  tone: BridgeTone;
  /** 補充說明（人話，可空）。 */
  description: string;
  /** 是否處於「已連上」的可運作狀態。 */
  connected: boolean;
  /** 已授權根（原樣帶回供 UI 列清單）。 */
  roots: string[];
}

/** 未知 state 的固定文案（契約漂移時寧可說「未知」，不畫假狀態）。 */
export const BRIDGE_UNKNOWN_LABEL = "未知狀態";

/**
 * 把 bridge 狀態翻成展示語義。純函式：給定 status，輸出恆定。
 * status=null 代表「還沒讀到」（初次載入中），顯示讀取中而非假裝未開啟。
 */
export function describeBridgeStatus(status: BridgeStatus | null): BridgeDisplay {
  if (!status) {
    return {
      label: "讀取中…",
      tone: "info",
      description: "正在確認裝置連線狀態。",
      connected: false,
      roots: [],
    };
  }
  const roots = Array.isArray(status.roots) ? status.roots.slice() : [];
  switch (status.state) {
    case "online":
      return {
        label: "已連上",
        tone: "ok",
        description: "agent 只能在下列已授權的資料夾內讀取檔案。",
        connected: true,
        roots,
      };
    case "off":
      return {
        label: "未開啟",
        tone: "off",
        description: "開啟後，agent 才能讀取你在這裡授權的資料夾。",
        connected: false,
        roots,
      };
    case "no_authorized_roots":
      return {
        label: "已開啟 · 尚未選擇資料夾",
        tone: "warn",
        description: "請先選擇要授權的資料夾。",
        connected: false,
        roots,
      };
    case "credentials_unavailable":
      return {
        label: "已開啟 · 尚未設定裝置憑證",
        tone: "warn",
        description: "桌面版還沒設定裝置憑證（見說明）；此功能需要一次性設定。",
        connected: false,
        roots,
      };
    case "connecting":
      return {
        label: "連線中…",
        tone: "info",
        description: "正在與裝置建立連線。",
        connected: false,
        roots,
      };
    case "error":
      return {
        label: "連線出錯",
        tone: "error",
        description: status.lastError?.trim() || "連線發生錯誤，請稍後重試。",
        connected: false,
        roots,
      };
    default:
      return {
        label: BRIDGE_UNKNOWN_LABEL,
        tone: "warn",
        description: `未預期的狀態：${String((status as { state?: unknown }).state)}`,
        connected: false,
        roots,
      };
  }
}

/** tone → 文字色 class（與 quota-display 的 tone 分流同形態；集中在純函式，不埋進 JSX）。 */
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

// ─────────────────────────── 本機檔案權限模式（四檔；文案＝單一真源）

/**
 * 四檔權限模式（凍結契約）。**此處是文案的唯一真源**：UI 不得另寫一份字串，
 * 一律經 `LOCAL_FILE_MODES` / `describeLocalFileMode()` 取用。
 *
 * 模式語義逐字採用產品規格，不得改寫。
 */
export type LocalFileMode = "off" | "ask" | "auto" | "full";

/** 圖示語義名。本檔零外部 import（不引 lucide）——UI 依此名映射到具體圖示元件。 */
export type LocalFileModeIcon = "power" | "message-circle-question" | "folder-check" | "globe";

export interface LocalFileModeSpec {
  id: LocalFileMode;
  icon: LocalFileModeIcon;
  title: string;
  subtitle: string;
}

export const LOCAL_FILE_MODES: readonly LocalFileModeSpec[] = [
  { id: "off", icon: "power", title: "關閉", subtitle: "agent 不能讀取本機檔案。" },
  { id: "ask", icon: "message-circle-question", title: "每次詢問", subtitle: "每次讀取前先問你。" },
  {
    id: "auto",
    icon: "folder-check",
    title: "授權範圍內自動",
    subtitle: "已授權資料夾內自動讀取，範圍外會先問你。",
  },
  {
    id: "full",
    icon: "globe",
    title: "完全訪問",
    subtitle: "整個家目錄可讀；敏感位置（~/.ssh、~/.aws、私鑰等）一律不讀。",
  },
] as const;

export const LOCAL_FILE_MODE_IDS: readonly LocalFileMode[] = LOCAL_FILE_MODES.map((m) => m.id);

/** tone 只給標題上色（收斂在最寬鬆的一檔用 warn 提示）。 */
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

/** mode → 文案／色調（純函式）。未知值回退 off，不 throw（契約漂移時寧可保守）。 */
export function describeLocalFileMode(mode: LocalFileMode): LocalFileModeDisplay {
  const spec = LOCAL_FILE_MODES.find((m) => m.id === mode) ?? LOCAL_FILE_MODES[0];
  return { title: spec.title, subtitle: spec.subtitle, tone: LOCAL_FILE_MODE_TONES[spec.id] };
}

export interface LocalFileModeResolution {
  mode: LocalFileMode;
  /** true＝由 enabled/roots 推導（殼沒回報真值 mode 欄位）；false＝殼回報的真值。 */
  derived: boolean;
  /** false＝status 尚未讀到（null）；mode 僅為佔位，UI 不得顯示成「已選中」。 */
  known: boolean;
}

/**
 * 從 bridge status 得到模式。真值優先；**舊產物沒有 mode 欄位**時推導：
 *   !enabled → off；enabled && roots 非空 → auto；enabled && roots 空 → ask。
 * 推導結果一律帶 `derived: true`，讓 UI／回報能標明「這是推導不是真值」。
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

/** 舊桌面產物沒有 `bridge.setMode` ⇒ 選擇器可見但須 disabled（不得 throw）。 */
export function supportsSetMode(api: unknown): boolean {
  if (!isRecord(api)) return false;
  const bridge = api.bridge;
  if (!isRecord(bridge)) return false;
  return typeof bridge.setMode === "function";
}

// ─────────────────────────── 無框架狀態機（互動可測；元件只是它的薄殼）

export interface DeviceBridgeSnapshot {
  /** 桌面殼且有此 API 子集。 */
  available: boolean;
  /** 最新一次 status（null＝還沒讀到）。 */
  status: BridgeStatus | null;
  /** 初次 status 讀取中。 */
  loading: boolean;
  /** enable/disable/pickFiles 進行中。 */
  busy: boolean;
  /** 最近一次操作的錯誤訊息（人話；成功即清空）。 */
  notice: string | null;
}

export interface DeviceBridgeController {
  getSnapshot(): DeviceBridgeSnapshot;
  /**
   * SSR／hydration 用的固定快照（一律「未偵測」）：伺服器沒有 window，桌面殼的能力
   * 只能在瀏覽器得知；首畫格一律相同，避免 hydration mismatch，掛載後由 effect 換上真狀態。
   */
  getServerSnapshot(): DeviceBridgeSnapshot;
  subscribe(listener: () => void): () => void;
  /** 掛載時呼叫：訂閱 onBridgeStatus 並讀一次 status。 */
  init(): void;
  /** 重讀 status（例：選完資料夾後，授權根變了殼會自動重註冊）。 */
  refresh(): Promise<void>;
  /** 開／關授權橋接。 */
  setEnabled(enabled: boolean): Promise<void>;
  /**
   * 切本機檔案權限模式（2026-10-04 新增；既有方法語義不動）。
   *   · 有 bridge.setMode → 直接切（非 off 且殼回報未 enabled 時補一次 enable）。
   *   · 無 bridge.setMode（舊產物）→ off 走 disable()、非 off 走 enable() 的降級。
   * 失敗一律收斂成 notice，不 throw。
   */
  setMode(mode: LocalFileMode): Promise<void>;
  /** 選資料夾（挑完即授權該路徑）並重讀 status。回傳已授權路徑（失敗回空陣列）。 */
  pickDirectory(): Promise<string[]>;
  /** 卸載時呼叫：取消訂閱、標記 disposed，之後不再 notify。 */
  dispose(): void;
}

/** SSR／hydration 首畫格固定值：伺服器無 window，桌面能力只能在瀏覽器得知。 */
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
  return "操作失敗，請稍後重試。";
}

/**
 * 建立 controller。`getApi` 每次讀取當下全域（測試可注入假件）。
 * 一律不 throw：任何失敗都轉成 snapshot.notice，不中斷 UI。
 */
export function createDeviceBridgeController(getApi: () => unknown = getDeviceBridgeApi): DeviceBridgeController {
  let disposed = false;
  const listeners = new Set<() => void>();
  let unsubscribeStatus: (() => void) | null = null;
  let initialized = false;

  const api = (): DeviceBridgeApi | null => {
    const candidate = getApi();
    return isDeviceBridgeApi(candidate) ? candidate : null;
  };

  // 初次快照：立即可知「有無 API」，讓純瀏覽器第一畫格就誠實顯示「需要桌面版」
  //（也讓 SSR/hydration 的首畫格一致；status 才需進 effect 讀）。
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
   * 切權限模式。有 setMode 走它；沒有（舊產物）就 off→disable、非 off→enable 降級。
   * 非 off 且切完仍 !enabled 時補一次 enable（契約：其他檔若未啟用則同時啟用）。
   */
  const setMode = async (mode: LocalFileMode): Promise<void> => {
    const a = api();
    if (!a) return;
    patch({ busy: true, notice: null });
    try {
      let next: BridgeStatus;
      if (typeof a.bridge.setMode === "function") {
        next = await a.bridge.setMode(mode);
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
      // 挑完即授權該路徑，授權根變了 → 殼會自動重註冊，故重讀 status。
      patch({ busy: false });
      await refresh();
      return picked;
    } catch (e) {
      if (!disposed) patch({ busy: false, notice: errText(e) });
      return [];
    }
  };

  const init = (): void => {
    if (initialized || disposed) return;
    initialized = true;
    const a = api();
    if (!a) {
      // 純瀏覽器：維持 available:false，無事可做（不是報錯）。
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
    void refresh();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (unsubscribeStatus) {
      try {
        unsubscribeStatus();
      } catch {
        /* 冪等：取消訂閱失敗不影響卸載 */
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
    dispose,
  };
}