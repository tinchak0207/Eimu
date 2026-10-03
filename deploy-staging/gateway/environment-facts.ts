// environment-facts.ts — 「環境事實」層（2026-10-04 抽離）。
//
// 背景：過去關於執行環境的事實（本回合掛哪個 agent、哪些工具有／沒有、bash 是否
// 走沙箱、工作目錄存不存在、本機檔案通道狀態）被寫死成散文常量，散在
// messages-gw.ts 的 BEAST_STABLE_CORE 與 legacy v1 幀裡，隨部署漂移。
// 本檔把這些事實抽成「型別化 + 可測 + 由真源推導」的一層，再由 messages-gw 依
// 穩定度動態注入 system prompt。
//
// 設計借鏡（未複製程式碼）Claude Code 的 SYSPROMPT 分段：static/session/turn 三段
// 穩定度，見 messages-gw.ts 的 SystemPromptSection 機制。
//
// 真源（不在本檔手抄清單）：
//   - expert/opencode-agents.json：每個 opencode agent 的 tools 表。
//     opencode 語義：tools[id]=false ＝ 從該 agent 工具表物理移除；未列出＝默認開。
//   - constants-gateway.ts：WORKSPACE_DIR / UPLOADS_DIR（部署期落點）。
//   - opencode-runtime/lib/sandbox.ts：bash/run_py 走 /usr/bin/bwrap（本檔只探測該
//     可執行檔是否存在，不 import 該檔以免跨 runtime 依賴）。
//
// 本檔為純函式為主（I/O 全部經可注入依賴），零副作用、零網路、零上游。

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WORKSPACE_DIR, UPLOADS_DIR } from "./constants-gateway.ts"
import { deviceBridgeEnabled, deviceBridgeRuntimeState, type DeviceBridgeRuntimeState } from "./device-bridge.ts"

// ── 型別 ────────────────────────────────────────────────────────────────

/**
 * 本機檔案通道狀態（device bridge，雲端側見 device-bridge.ts）。
 * `off`＝總開關關閉（能力未掛載）；`no_authorized_roots`＝裝置在線但未授權任何
 * 本機根（遞迴型工具一律拒）；`credentials_unavailable`＝通道不可用（總開關開啟、
 * 但該使用者取不到任何在線裝置）；`online`＝可用；`unknown`＝本回合無法判定。
 *
 * 語義鐵律：`unknown` 絕不等於「沒有」——讀不到事實（取不到 userId／查詢失敗）就維持
 * `unknown`，不得猜成 `off` 或任何否定結論。
 *
 * 來源由裝置橋那一包接：`resolveLocalBridgeState`（下方）依總開關與唯讀查詢推導。
 */
export type LocalBridgeState = "off" | "no_authorized_roots" | "credentials_unavailable" | "online" | "unknown"

// ── 客戶端環境上報（型別化白名單，防「前端注入 prompt」）──────────────────
//
// 只有客戶端知道的事實（是否桌面殼、本機 ffmpeg/ffprobe/存檔能力、渲染主機）由前端
// 隨訊息上報。此欄位屬「客戶端可控」⇒ 一律不得原文落進 system：
//   1. 只收型別化白名單（enum 逐值比對、布林），不接收任何自由文字；
//   2. 未知 key 一律丟棄；
//   3. 單欄型別錯只丟該欄，不整包失效；
//   4. 未上報的欄位語義＝`unknown`，閘道**不得**推論成否定（無 ffmpeg／非桌面殼）。
// 環境段只做事實陳述，不帶任何指令語氣。
//
// 注意：裝置橋狀態（localBridge）不在此列——它由伺服器側 device-bridge 查詢推導
// （見 resolveLocalBridgeState），不接受客戶端自報。

/** 是否桌面殼：由客戶端 `window.eimuLocal` 是否存在推導。 */
export type ClientSurface = "web" | "desktop-shell"

/** 渲染主機：`cloud-bridge`＝雲端橋、`local`＝本機、`unknown`＝未上報／無法判定。 */
export type ClientRenderHost = "cloud-bridge" | "local" | "unknown"

/** 本機能力布林上報；缺＝未上報（語義 unknown，不是 false）。 */
export interface ClientLocalCapabilities {
  /** `window.eimuLocal` 是否存在。 */
  windowEimuLocal?: boolean
  /** 本機 ffmpeg 是否可用。 */
  ffmpeg?: boolean
  /** 本機 ffprobe 是否可用。 */
  ffprobe?: boolean
  /** 本機存檔能力（File System Access API）是否可用。 */
  localSave?: boolean
}

/** 客戶端上報的執行環境事實（已由 sanitizeClientEnvironmentReport 淨化）；缺席欄位＝unknown。 */
export interface ClientEnvironmentReport {
  surface?: ClientSurface
  localCapabilities?: ClientLocalCapabilities
  renderHost?: ClientRenderHost
}

/** 一個 opencode agent 的工具表（真源 expert/opencode-agents.json）。 */
export interface ToolSurface {
  /** 本回合掛載的 agent id（opencode agent 名，如 orchestrator / creator）。 */
  agent: string
  /** 是否在真源找到該 agent 的工具表；false ⇒ 以下清單不可信（一律視為未知）。 */
  known: boolean
  /**
   * 顯式啟用（tools[id]===true）的工具。注意 opencode 語義「未列出＝默認開」，
   * 故 held 只代表「本檔顯式持有」，不等於完整工具面；不得推論其補集就是全部可調用工具。
   */
  held: string[]
  /** 顯式禁用（tools[id]===false）＝物理不在工具表（呼叫直接失敗）。 */
  cut: string[]
}

/** 「能力斷路」事實：哪些工具不在你的工具表。由 ToolSurface 推導，非寫死句子。 */
export interface CapabilityCutoff {
  /** 真源是否可讀到該 agent 的工具表。 */
  known: boolean
  /** 不在 toolSurface 的宣告工具 ＝ 工具表 map 鍵集中 held 的補集。 */
  tools: string[]
  /** 推導來源的 agent id（可稽核）。 */
  derivedFrom: string
}

export type ShellSandbox = "bwrap" | "unavailable" | "unknown"
export type NativeFileSandbox = "outside_sandbox" | "unknown"

export interface SandboxFacts {
  /** bash/run_py 是否走 bwrap。 */
  shell: ShellSandbox
  /** 原生檔案工具（read/write/edit/grep…）是否在沙箱之外。讀不到事實時未知，不得猜。 */
  nativeFileTools: NativeFileSandbox
  /** 判定依據（可稽核，為什麼是這個值）。 */
  evidence: string
}

export interface WorkspaceFacts {
  workspaceDir: string
  /** true/false＝實際探測結果；"unknown"＝探測失敗。 */
  workspaceExists: boolean | "unknown"
  uploadsDir: string
  uploadsExists: boolean | "unknown"
}

/** 型別化的執行環境事實（同一輸入必得同一輸出）。 */
export interface RuntimeEnvironment {
  /** 本回合掛載的 agent（orchestrator / creator / 其他）。 */
  plane: string
  toolSurface: ToolSurface
  capabilityCutoff: CapabilityCutoff
  sandbox: SandboxFacts
  workspace: WorkspaceFacts
  /** 本機檔案通道狀態；本包預設 unknown，來源由裝置橋那一包接。 */
  localBridge: LocalBridgeState
  /** 客戶端上報的本機環境事實（淨化後）；null＝客戶端未上報（全部語義 unknown）。 */
  client: ClientEnvironmentReport | null
}

export interface CollectEnvironmentInputs {
  /** 本回合掛載的 agent id（messages-gw 的 promptBody.agent）。 */
  plane: string
  /** opencode-agents.json 路徑；預設即本檔同層 expert/opencode-agents.json。 */
  agentsTablePath?: string
  /** 工作目錄／上傳目錄；預設取 constants-gateway 的部署落點。 */
  workspaceDir?: string
  uploadsDir?: string
  /** bwrap 可執行檔路徑；預設 /usr/bin/bwrap（對齊 opencode-runtime/lib/sandbox.ts）。 */
  bwrapPath?: string
  /**
   * 本回合使用者 id（messages-gw 提供 userId）。缺／null ⇒ 無從查裝置註冊表 ⇒
   * localBridge 維持 `unknown`（不得猜）。總開關未開時不需 userId 即可判 `off`。
   */
  userId?: number | null
  /** 裝置橋唯讀查詢（依賴注入，測試用）；預設 device-bridge.deviceBridgeRuntimeState。 */
  deviceBridgeState?: (userId: number | null) => DeviceBridgeRuntimeState
  /** 總開關查詢（依賴注入，測試用）；預設 device-bridge.deviceBridgeEnabled。 */
  deviceBridgeOn?: () => boolean
  /** 明確指定 localBridge（測試用）；給定時不查裝置橋。 */
  localBridge?: LocalBridgeState
  /** 客戶端上報（未淨化，來自訊息 body 的 client_environment）；缺＝null（全部語義 unknown）。 */
  clientEnvironmentReport?: unknown
  /** 依賴注入（測試用）：讀文字檔。預設 readFileSync(p,"utf8")。 */
  readTextFile?: (p: string) => string
  /** 依賴注入（測試用）：路徑存在性。預設 existsSync。 */
  pathExists?: (p: string) => boolean
}

const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap"

/** 本檔所在目錄（bun 與 tsx/node 皆可）。 */
function moduleDir(): string {
  return fileURLToPath(new URL(".", import.meta.url))
}

function defaultAgentsTablePath(): string {
  return path.join(moduleDir(), "expert", "opencode-agents.json")
}

function probePath(p: string, pathExists: (q: string) => boolean): boolean | "unknown" {
  try {
    return pathExists(p)
  } catch {
    return "unknown"
  }
}

// ── 本機檔案通道（localBridge）來源接線 ──────────────────────────────────

/** 裝置橋查詢結果中，推導通道狀態所需的最小欄位。 */
export type DeviceBridgeStateInput = Pick<DeviceBridgeRuntimeState, "enabled" | "online" | "authorizedRootCount">

/**
 * 純函式：由裝置橋查詢結果推導 localBridge 狀態（同一輸入必得同一輸出）。
 *
 * 四態判定：
 *   - `enabled === false`（總開關未開）⇒ `off`
 *   - `enabled && !online`（開著但該使用者無在線裝置）⇒ `credentials_unavailable`
 *   - `enabled && online && authorizedRootCount === 0`（在線但未授權任何根）⇒ `no_authorized_roots`
 *   - `enabled && online && authorizedRootCount > 0`（在線且已授權根）⇒ `online`
 *   - 無查詢結果（null/undefined）⇒ `unknown`（不得猜）
 */
export function deriveLocalBridgeState(query: DeviceBridgeStateInput | null | undefined): LocalBridgeState {
  if (!query) return "unknown"
  if (!query.enabled) return "off"
  if (!query.online) return "credentials_unavailable"
  return query.authorizedRootCount > 0 ? "online" : "no_authorized_roots"
}

/**
 * 接線：判定本回合 localBridge。
 *
 * 順序與理由：
 *   1. 總開關未開 ⇒ `off`——這是環境層可直接觀測的事實，不需 userId（能力未掛載）。
 *   2. 開著但取不到/拿不到 userId ⇒ `unknown`——查不到該使用者的裝置註冊表，
 *      **不得猜成「沒有」**（unknown 的語義鐵律）。
 *   3. 查詢拋錯 ⇒ `unknown`——fail-safe，讀不到事實就不下結論。
 *   4. 有 userId ⇒ 呼叫唯讀查詢，交 `deriveLocalBridgeState` 推導四態。
 */
export function resolveLocalBridgeState(inputs: {
  userId?: number | null
  deviceBridgeState?: (userId: number | null) => DeviceBridgeRuntimeState
  deviceBridgeOn?: () => boolean
}): LocalBridgeState {
  const isOn = inputs.deviceBridgeOn ?? deviceBridgeEnabled
  if (!isOn()) return "off"
  if (inputs.userId === undefined || inputs.userId === null) return "unknown"
  const query = inputs.deviceBridgeState ?? deviceBridgeRuntimeState
  try {
    return deriveLocalBridgeState(query(inputs.userId))
  } catch {
    return "unknown"
  }
}

// ── 客戶端上報淨化（逐值白名單）─────────────────────────────────────────

const CLIENT_SURFACES: ReadonlySet<string> = new Set(["web", "desktop-shell"])
const CLIENT_RENDER_HOSTS: ReadonlySet<string> = new Set(["cloud-bridge", "local", "unknown"])

/** 一般物件判定：排除 null 與陣列（兩者皆非上報物件，整包丟棄）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 只接受白名單內的確切字串（不 trim、不正規化——避免任何自由文字滲入）。 */
function pickWhitelisted<T extends string>(raw: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof raw === "string" && allowed.has(raw) ? (raw as T) : undefined
}

/** 只接受原生布林；字串 "true"／數字 1／陣列一律視為型別不符 ⇒ 丟該欄。 */
function pickBoolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined
}

/**
 * 淨化客戶端上報（純函式，同一輸入必得同一輸出）。規則：
 *   - 非物件（null / 陣列 / 純量）⇒ 回 `null`（整包丟棄，全部語義 unknown）。
 *   - 只讀白名單 key；未知 key（含自由文字、任意長度陣列）一律丟棄，不進結果。
 *   - enum 逐值比對、布林逐值型別檢查；型別錯或不在白名單 ⇒ 只丟該欄，其餘照收。
 *   - 絕不接收自由文字：任何字串都必須命中 enum 白名單才可能進入結果，杜絕
 *     「前端把指令塞進 payload → 落進 system prompt」的權威注入通道。
 */
export function sanitizeClientEnvironmentReport(raw: unknown): ClientEnvironmentReport | null {
  if (!isPlainObject(raw)) return null
  const out: ClientEnvironmentReport = {}
  const surface = pickWhitelisted<ClientSurface>(raw.surface, CLIENT_SURFACES)
  if (surface !== undefined) out.surface = surface
  const renderHost = pickWhitelisted<ClientRenderHost>(raw.render_host, CLIENT_RENDER_HOSTS)
  if (renderHost !== undefined) out.renderHost = renderHost
  if (isPlainObject(raw.local_capabilities)) {
    const src = raw.local_capabilities
    const caps: ClientLocalCapabilities = {}
    const windowEimuLocal = pickBoolean(src.window_eimu_local)
    if (windowEimuLocal !== undefined) caps.windowEimuLocal = windowEimuLocal
    const ffmpeg = pickBoolean(src.ffmpeg)
    if (ffmpeg !== undefined) caps.ffmpeg = ffmpeg
    const ffprobe = pickBoolean(src.ffprobe)
    if (ffprobe !== undefined) caps.ffprobe = ffprobe
    const localSave = pickBoolean(src.local_save)
    if (localSave !== undefined) caps.localSave = localSave
    if (Object.keys(caps).length > 0) out.localCapabilities = caps
  }
  return out
}

// ── 蒐集 ────────────────────────────────────────────────────────────────

/**
 * 由 toolSurface 推導「哪些工具不在工具表」。
 * 純函式：cut ＝ 該 agent 工具表 map 的鍵集減去 held。換一份工具表輸入，輸出跟著變。
 */
export function deriveCapabilityCutoff(toolSurface: ToolSurface): CapabilityCutoff {
  if (!toolSurface.known) {
    return { known: false, tools: [], derivedFrom: toolSurface.agent }
  }
  const held = new Set(toolSurface.held)
  // declared keys ＝ held ∪ cut（真源 map 的全部鍵）；此處直接對兩者做補集推導，
  // 不依賴呼叫端傳進來的 cut 欄位是否乾淨。
  const declared = [...toolSurface.held, ...toolSurface.cut]
  const tools: string[] = []
  for (const id of declared) if (!held.has(id) && !tools.includes(id)) tools.push(id)
  return { known: true, tools, derivedFrom: toolSurface.agent }
}

/** 從真源讀某 agent 的工具表；找不到／讀不到 → known=false（不得猜）。 */
function readToolSurface(agent: string, inputs: CollectEnvironmentInputs): ToolSurface {
  const readTextFile = inputs.readTextFile ?? ((p: string) => readFileSync(p, "utf8"))
  const tablePath = inputs.agentsTablePath ?? defaultAgentsTablePath()
  let raw: unknown
  try {
    raw = JSON.parse(readTextFile(tablePath))
  } catch {
    return { agent, known: false, held: [], cut: [] }
  }
  if (!raw || typeof raw !== "object") return { agent, known: false, held: [], cut: [] }
  const entry = (raw as Record<string, unknown>)[agent]
  if (!entry || typeof entry !== "object") return { agent, known: false, held: [], cut: [] }
  const tools = (entry as { tools?: unknown }).tools
  if (!tools || typeof tools !== "object") return { agent, known: false, held: [], cut: [] }
  const held: string[] = []
  const cut: string[] = []
  for (const [id, value] of Object.entries(tools as Record<string, unknown>)) {
    if (value === true) held.push(id)
    else cut.push(id)
  }
  return { agent, known: true, held, cut }
}

/** 實際蒐集環境事實（I/O 可注入以便測試）。 */
export function collectRuntimeEnvironment(inputs: CollectEnvironmentInputs): RuntimeEnvironment {
  const pathExists = inputs.pathExists ?? existsSync
  const toolSurface = readToolSurface(inputs.plane, inputs)
  const capabilityCutoff = deriveCapabilityCutoff(toolSurface)

  const bwrapPath = inputs.bwrapPath ?? DEFAULT_BWRAP_PATH
  const bwrapExists = probePath(bwrapPath, pathExists)
  const sandbox: SandboxFacts =
    bwrapExists === "unknown"
      ? { shell: "unknown", nativeFileTools: "unknown", evidence: `${bwrapPath} 探測失敗` }
      : bwrapExists
        ? { shell: "bwrap", nativeFileTools: "unknown", evidence: `探測到 ${bwrapPath} 存在` }
        : { shell: "unavailable", nativeFileTools: "unknown", evidence: `未探測到 ${bwrapPath}` }
  // nativeFileTools：原生檔案工具跑在受信 opencode 進程（沙箱外）是 runtime 拓撲事實，
  // 但本進程無法可信探測 opencode 進程的掛載拓撲 ⇒ 一律 unknown，不得猜（待另一包接）。

  const workspaceDir = inputs.workspaceDir ?? WORKSPACE_DIR
  const uploadsDir = inputs.uploadsDir ?? UPLOADS_DIR
  const workspace: WorkspaceFacts = {
    workspaceDir,
    workspaceExists: probePath(workspaceDir, pathExists),
    uploadsDir,
    uploadsExists: probePath(uploadsDir, pathExists),
  }

  return {
    plane: inputs.plane,
    toolSurface,
    capabilityCutoff,
    sandbox,
    workspace,
    // 明確給定（測試）優先；否則由裝置橋接線推導（env 未開 ⇒ off；取不到 userId ⇒ unknown）。
    localBridge: inputs.localBridge ?? resolveLocalBridgeState(inputs),
    // 客戶端可控上報一律經 sanitize 白名單；非物件／全欄位無效 ⇒ null（語義 unknown）。
    client: sanitizeClientEnvironmentReport(inputs.clientEnvironmentReport),
  }
}

// ── 穩定度 ──────────────────────────────────────────────────────────────

export type EnvironmentStability = "static" | "session" | "turn"

/**
 * 由事實本身決定環境段的穩定度（messages-gw 據此決定是否黏著 latch）。
 *
 * 逐格理由：
 *   - localBridge：裝置上下線、授權根變更、憑據可用性每輪都可能變 ⇒ 一旦有值（非
 *     unknown，含 `off`）即判 turn，不得黏著。只有 `unknown`（取不到 userId／查詢失敗）
 *     才回到 session；因為 unknown 是「讀不到」而非「沒有」，不得被當成穩定結論黏死。
 *   - client.surface：桌面殼／Web 由客戶端在會話內固定 ⇒ 不影響判級（可黏著）。
 *   - client.localCapabilities / client.renderHost：本機能力（ffmpeg 就緒與否）與渲染
 *     主機每輪可變 ⇒ 一旦有具體上報即判 turn，不得黏著；全未上報則不影響判級。
 *   - plane / toolSurface / capabilityCutoff：由本會話掛載的 agent 決定；beast_mode
 *     在會話內固定、工具表來自部署期靜態 JSON ⇒ 會話內穩定 ⇒ session（可黏著）。
 *   - sandbox / workspace：探測結果為部署期主機事實＋會話級 uploads 路徑語義，
 *     會話內不變但跨 session／跨部署可能不同 ⇒ 不升為 static，一律 session。
 */
export function environmentSectionStability(env: RuntimeEnvironment): EnvironmentStability {
  if (env.localBridge !== "unknown") return "turn"
  const client = env.client
  if (client) {
    if (client.localCapabilities && Object.keys(client.localCapabilities).length > 0) return "turn"
    if (client.renderHost !== undefined && client.renderHost !== "unknown") return "turn"
  }
  return "session"
}

// ── 渲染（同一輸入必得同一輸出）────────────────────────────────────────

function renderWorkspaceExistence(exists: boolean | "unknown"): string {
  if (exists === true) return "存在"
  if (exists === false) return "不存在"
  return "未知"
}

function renderLocalBridge(state: LocalBridgeState): string {
  switch (state) {
    case "off":
      return "已关闭（本机文件通道未挂载）"
    case "no_authorized_roots":
      return "在线，但未授权任何本机根目录（递归型工具一律拒绝）"
    case "credentials_unavailable":
      // 涵蓋「總開關已開但該使用者無在線裝置」與「憑據不可用」兩種不可用情境，
      // 不把成因寫死成憑據（避免對模型陳述錯誤成因）。
      return "不可用（该使用者当前无在线装置或缺少可用凭据）"
    case "online":
      return "在线可用"
    case "unknown":
      return "未知（本轮无法判定）"
  }
}

function renderSandboxShell(shell: ShellSandbox): string {
  if (shell === "bwrap") return "走 bwrap 隔离"
  if (shell === "unavailable") return "不可用（未找到 bwrap 可执行文件）"
  return "未知"
}

/** 客戶端運行面：未上報一律渲染成「未知（客户端未上报）」，**不得**寫成否定。 */
function renderClientSurface(surface: ClientSurface | undefined): string {
  if (surface === "desktop-shell") return "桌面壳（Electron 薄壳）"
  if (surface === "web") return "Web 浏览器"
  return "未知（客户端未上报）"
}

/** 本機能力三態：true→可用、false→不可用、缺→未知（客户端未上报）。 */
function renderClientCapability(available: boolean | undefined): string {
  if (available === true) return "可用"
  if (available === false) return "不可用"
  return "未知（客户端未上报）"
}

/** 渲染主機：未上報／`unknown` ⇒ 「未知（客户端未上报）」，不得推論。 */
function renderClientRenderHost(host: ClientRenderHost | undefined): string {
  if (host === "local") return "本机"
  if (host === "cloud-bridge") return "云端桥"
  return "未知（客户端未上报）"
}

/**
 * 能力断路事实（单一宣告真源）。由 toolSurface 推導清單與數字，路由語義為既有
 * 規則的固定外框（與舊散文同語義）。legacy v1 帧與環境段共用此函式 ⇒ 不會各自為真源。
 */
export function renderCapabilityCutoffFact(env: RuntimeEnvironment): string {
  const ts = env.toolSurface
  const cutoff = env.capabilityCutoff
  const routing =
    "要执行这些工具，必须经 subagent_dispatch（带 expert 栏）派遣对应 Expert——这是唯一通路。"
  if (!ts.known || !cutoff.known) {
    return `【能力断路·物理事实】未能在真源 expert/opencode-agents.json 找到 agent=${env.plane} 的工具表，工具面未知，勿凭记忆断言自己有什么或没有什么。`
  }
  if (cutoff.tools.length === 0) {
    return `【能力断路·物理事实】真源 expert/opencode-agents.json 对 agent=${env.plane} 未记录任何被移除的工具（未列出的工具默认为开）。${routing}`
  }
  return `【能力断路·物理事实】真源 expert/opencode-agents.json 对 agent=${env.plane} 已物理移除以下 ${cutoff.tools.length} 个工具，直接调用会失败：${cutoff.tools.join("、")}。${routing}AGENTS.md 路由表中对应这些工具的行，由你派遣的 Expert 代为执行；其余工具（image_generate 等）的直接调用路由仍按 AGENTS.md 执行。`
}

/**
 * 把環境事實渲染成一段確定的中文散文。同一 RuntimeEnvironment 必得同一輸出
 * （無時間戳、無隨機、清單順序＝真源鍵序）。
 */
export function renderEnvironmentSection(env: RuntimeEnvironment): string {
  const ts = env.toolSurface
  const lines: string[] = ["【环境事实·运行时（由网关按当前环境动态生成，勿凭记忆推测）】"]
  lines.push(`- 本回合挂载 agent：${env.plane}`)

  if (!ts.known) {
    lines.push(`- 工具表：未能在真源 expert/opencode-agents.json 找到 agent=${env.plane} 的条目（工具面未知，勿断言）。`)
  } else {
    const heldPart = ts.held.length > 0 ? `显式启用 ${ts.held.length} 个：${ts.held.join("、")}` : "无显式启用的工具"
    lines.push(
      `- 工具表（真源 expert/opencode-agents.json）：${heldPart}；已从工具表物理移除 ${ts.cut.length} 个（未列出的工具默认为开）。`,
    )
  }

  const cutoff = env.capabilityCutoff
  if (!cutoff.known) {
    lines.push("- 能力断路：未知（工具表条目缺失）。")
  } else if (cutoff.tools.length === 0) {
    lines.push("- 能力断路：本档未记录任何被移除的工具。")
  } else {
    lines.push(
      `- 能力断路：以下 ${cutoff.tools.length} 个工具不在你的工具表，直接调用会失败：${cutoff.tools.join("、")}；执行它们必须经 subagent_dispatch（带 expert 栏）派遣对应 Expert（唯一通路）。`,
    )
  }

  lines.push(
    `- 沙箱：bash/run_py ${renderSandboxShell(env.sandbox.shell)}；原生文件工具沙箱归属：${env.sandbox.nativeFileTools === "outside_sandbox" ? "在沙箱之外" : "未知"}（依据：${env.sandbox.evidence}）。`,
  )
  lines.push(
    `- 工作目录 ${env.workspace.workspaceDir}：${renderWorkspaceExistence(env.workspace.workspaceExists)}；上传目录 ${env.workspace.uploadsDir}：${renderWorkspaceExistence(env.workspace.uploadsExists)}。`,
  )
  // 客戶端上報的事實（只有客戶端知道）。**欄位缺失（client=null）⇒ 完全不渲染這段**，
  // 以保證「未帶 client_environment 的舊請求」收到的環境段與功能上線前逐位元組相同
  // （缺欄位＝unknown，閘道不下任何斷言，自然不會被寫成否定）。一旦有上報物件，
  // 逐欄誠實渲染：具體值照寫，未上報的欄位寫「未知（客户端未上报）」，不得寫成否定。
  const client = env.client
  if (client) {
    lines.push(`- 客户端运行面：${renderClientSurface(client.surface)}。`)
    const caps = client.localCapabilities
    lines.push(
      `- 客户端本机能力：window.eimuLocal ${renderClientCapability(caps?.windowEimuLocal)}；ffmpeg ${renderClientCapability(caps?.ffmpeg)}；ffprobe ${renderClientCapability(caps?.ffprobe)}；本机存档 ${renderClientCapability(caps?.localSave)}。`,
    )
    lines.push(`- 客户端渲染主机：${renderClientRenderHost(client.renderHost)}。`)
  }
  lines.push(`- 本机文件通道：${renderLocalBridge(env.localBridge)}。`)

  return lines.join("\n")
}
