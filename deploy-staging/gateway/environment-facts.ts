// environment-facts.ts — 「环境事实」层（2026-10-04 抽离）。
//
// 背景：过去关于执行环境的事实（本回合挂哪个 agent、哪些工具有／没有、bash 是否
// 走沙箱、工作目录存不存在、本机档案通道状态）被写死成散文常量，散在
// messages-gw.ts 的 BEAST_STABLE_CORE 与 legacy v1 帧里，随部署漂移。
// 本档把这些事实抽成「型别化 + 可测 + 由真源推导」的一层，再由 messages-gw 依
// 稳定度动态注入 system prompt。
//
// 设计借镜（未复制程式码）Claude Code 的 SYSPROMPT 分段：static/session/turn 三段
// 稳定度，见 messages-gw.ts 的 SystemPromptSection 机制。
//
// 真源（不在本档手抄清单）：
//   - expert/opencode-agents.json：每个 opencode agent 的 tools 表。
//     opencode 语义：tools[id]=false ＝ 从该 agent 工具表物理移除；未列出＝默认开。
//   - constants-gateway.ts：WORKSPACE_DIR / UPLOADS_DIR（部署期落点）。
//   - opencode-runtime/lib/sandbox.ts：bash/run_py 走 /usr/bin/bwrap（本档只探测该
//     可执行档是否存在，不 import 该档以免跨 runtime 依赖）。
//
// 本档为纯函式为主（I/O 全部经可注入依赖），零副作用、零网路、零上游。

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WORKSPACE_DIR, UPLOADS_DIR } from "./constants-gateway.ts"
import { deviceBridgeEnabled, deviceBridgePolicyState, deviceBridgeRuntimeState, type DeviceBridgeRuntimeState } from "./device-bridge.ts"
import type { DeviceBridgeMode } from "./device-bridge-policy.ts"

// ── 型别 ────────────────────────────────────────────────────────────────

/**
 * 本机档案通道状态（device bridge，云端侧见 device-bridge.ts）。
 * `off`＝总开关关闭（能力未挂载）；`no_authorized_roots`＝装置已连线但未授权任何
 * 本机根（递回型工具一律拒）；`credentials_unavailable`（历史命名，语义实为「未连线」）＝
 * 总开关开启，但云端查不到该使用者的在线装置：成因为桌面壳未开启本机文件权限／未在该壳内
 * 登录／本次连线尚未建立，**不是**「缺少凭据」（空授权根时桌面壳根本不注册，故闸道只能
 * 看到「无在线装置」）；`online`＝可用；`unknown`＝本回合无法判定。
 *
 * 语义铁律：`unknown` 绝不等于「没有」——读不到事实（取不到 userId／查询失败）就维持
 * `unknown`，不得猜成 `off` 或任何否定结论。
 *
 * 来源由装置桥那一包接：`resolveLocalBridgeState`（下方）依总开关与唯读查询推导。
 */
export type LocalBridgeState = "off" | "no_authorized_roots" | "credentials_unavailable" | "online" | "unknown"

/**
 * W6b：本机档案权限事实（模式 ＋ 已授权根清单）。来源＝在线装置的 register 上报
 * （伺服器侧推导，不接受客户端自报）。`mode` 决定 `ask`／`auto`／`full` 下何时需要授权。
 */
export interface LocalFilePolicyFacts {
  mode: DeviceBridgeMode
  authorizedRoots: string[]
}

// ── 客户端环境上报（型别化白名单，防「前端注入 prompt」）──────────────────
//
// 只有客户端知道的事实（是否桌面壳、本机 ffmpeg/ffprobe/存档能力、渲染主机）由前端
// 随讯息上报。此栏位属「客户端可控」⇒ 一律不得原文落进 system：
//   1. 只收型别化白名单（enum 逐值比对、布林），不接收任何自由文字；
//   2. 未知 key 一律丢弃；
//   3. 单栏型别错只丢该栏，不整包失效；
//   4. 未上报的栏位语义＝`unknown`，闸道**不得**推论成否定（无 ffmpeg／非桌面壳）。
// 环境段只做事实陈述，不带任何指令语气。
//
// 注意：装置桥状态（localBridge）不在此列——它由伺服器侧 device-bridge 查询推导
// （见 resolveLocalBridgeState），不接受客户端自报。

/** 是否桌面壳：由客户端 `window.eimuLocal` 是否存在推导。 */
export type ClientSurface = "web" | "desktop-shell"

/** 渲染主机：`cloud-bridge`＝云端桥、`local`＝本机、`unknown`＝未上报／无法判定。 */
export type ClientRenderHost = "cloud-bridge" | "local" | "unknown"

/** 本机能力布林上报；缺＝未上报（语义 unknown，不是 false）。 */
export interface ClientLocalCapabilities {
  /** `window.eimuLocal` 是否存在。 */
  windowEimuLocal?: boolean
  /** 本机 ffmpeg 是否可用。 */
  ffmpeg?: boolean
  /** 本机 ffprobe 是否可用。 */
  ffprobe?: boolean
  /** 本机存档能力（File System Access API）是否可用。 */
  localSave?: boolean
}

/** 客户端上报的执行环境事实（已由 sanitizeClientEnvironmentReport 净化）；缺席栏位＝unknown。 */
export interface ClientEnvironmentReport {
  surface?: ClientSurface
  localCapabilities?: ClientLocalCapabilities
  renderHost?: ClientRenderHost
}

/** 一个 opencode agent 的工具表（真源 expert/opencode-agents.json）。 */
export interface ToolSurface {
  /** 本回合挂载的 agent id（opencode agent 名，如 orchestrator / creator）。 */
  agent: string
  /** 是否在真源找到该 agent 的工具表；false ⇒ 以下清单不可信（一律视为未知）。 */
  known: boolean
  /**
   * 显式启用（tools[id]===true）的工具。注意 opencode 语义「未列出＝默认开」，
   * 故 held 只代表「本档显式持有」，不等于完整工具面；不得推论其补集就是全部可调用工具。
   */
  held: string[]
  /** 显式禁用（tools[id]===false）＝物理不在工具表（呼叫直接失败）。 */
  cut: string[]
}

/** 「能力断路」事实：哪些工具不在你的工具表。由 ToolSurface 推导，非写死句子。 */
export interface CapabilityCutoff {
  /** 真源是否可读到该 agent 的工具表。 */
  known: boolean
  /** 不在 toolSurface 的宣告工具 ＝ 工具表 map 键集中 held 的补集。 */
  tools: string[]
  /** 推导来源的 agent id（可稽核）。 */
  derivedFrom: string
}

export type ShellSandbox = "bwrap" | "unavailable" | "unknown"
export type NativeFileSandbox = "outside_sandbox" | "unknown"

export interface SandboxFacts {
  /** bash/run_py 是否走 bwrap。 */
  shell: ShellSandbox
  /** 原生档案工具（read/write/edit/grep…）是否在沙箱之外。读不到事实时未知，不得猜。 */
  nativeFileTools: NativeFileSandbox
  /** 判定依据（可稽核，为什么是这个值）。 */
  evidence: string
}

export interface WorkspaceFacts {
  workspaceDir: string
  /** true/false＝实际探测结果；"unknown"＝探测失败。 */
  workspaceExists: boolean | "unknown"
  uploadsDir: string
  uploadsExists: boolean | "unknown"
}

/** 型别化的执行环境事实（同一输入必得同一输出）。 */
export interface RuntimeEnvironment {
  /** 本回合挂载的 agent（orchestrator / creator / 其他）。 */
  plane: string
  toolSurface: ToolSurface
  capabilityCutoff: CapabilityCutoff
  sandbox: SandboxFacts
  workspace: WorkspaceFacts
  /** 本机档案通道状态；本包预设 unknown，来源由装置桥那一包接。 */
  localBridge: LocalBridgeState
  /**
   * W6b：本机档案权限模式与已授权根（在线装置推导）；null＝无在线装置／总开关未开。
   * 只加事实，不改既有段落语义。
   */
  localFilePolicy?: LocalFilePolicyFacts | null
  /** 客户端上报的本机环境事实（净化后）；null＝客户端未上报（全部语义 unknown）。 */
  client: ClientEnvironmentReport | null
}

export interface CollectEnvironmentInputs {
  /** 本回合挂载的 agent id（messages-gw 的 promptBody.agent）。 */
  plane: string
  /** opencode-agents.json 路径；预设即本档同层 expert/opencode-agents.json。 */
  agentsTablePath?: string
  /** 工作目录／上传目录；预设取 constants-gateway 的部署落点。 */
  workspaceDir?: string
  uploadsDir?: string
  /** bwrap 可执行档路径；预设 /usr/bin/bwrap（对齐 opencode-runtime/lib/sandbox.ts）。 */
  bwrapPath?: string
  /**
   * 本回合使用者 id（messages-gw 提供 userId）。缺／null ⇒ 无从查装置注册表 ⇒
   * localBridge 维持 `unknown`（不得猜）。总开关未开时不需 userId 即可判 `off`。
   */
  userId?: number | null
  /** 装置桥唯读查询（依赖注入，测试用）；预设 device-bridge.deviceBridgeRuntimeState。 */
  deviceBridgeState?: (userId: number | null) => DeviceBridgeRuntimeState
  /** 总开关查询（依赖注入，测试用）；预设 device-bridge.deviceBridgeEnabled。 */
  deviceBridgeOn?: () => boolean
  /** W6b：权限模式与授权根查询（依赖注入，测试用）；预设 device-bridge.deviceBridgePolicyState。 */
  deviceBridgePolicy?: (userId: number | null) => LocalFilePolicyFacts | null
  /** W6b：明确指定权限事实（测试用）；给定时不查装置桥。 */
  localFilePolicy?: LocalFilePolicyFacts | null
  /** 明确指定 localBridge（测试用）；给定时不查装置桥。 */
  localBridge?: LocalBridgeState
  /** 客户端上报（未净化，来自讯息 body 的 client_environment）；缺＝null（全部语义 unknown）。 */
  clientEnvironmentReport?: unknown
  /** 依赖注入（测试用）：读文字档。预设 readFileSync(p,"utf8")。 */
  readTextFile?: (p: string) => string
  /** 依赖注入（测试用）：路径存在性。预设 existsSync。 */
  pathExists?: (p: string) => boolean
}

const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap"

/** 本档所在目录（bun 与 tsx/node 皆可）。 */
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

// ── 本机档案通道（localBridge）来源接线 ──────────────────────────────────

/** 装置桥查询结果中，推导通道状态所需的最小栏位。 */
export type DeviceBridgeStateInput = Pick<DeviceBridgeRuntimeState, "enabled" | "online" | "authorizedRootCount">

/**
 * 纯函式：由装置桥查询结果推导 localBridge 状态（同一输入必得同一输出）。
 *
 * 四态判定：
 *   - `enabled === false`（总开关未开）⇒ `off`
 *   - `enabled && !online`（开著但云端查不到该使用者的在线装置）⇒ `credentials_unavailable`
 *     ＝「未连线」：壳没开／壳未登录／壳未授权任何资料夹（空授权根时桌面壳根本不注册）皆落此态，
 *     故**不等于**「缺少凭据」，只是闸道侧看不到在线装置。
 *   - `enabled && online && authorizedRootCount === 0`（已连线但未授权任何根）⇒ `no_authorized_roots`
 *   - `enabled && online && authorizedRootCount > 0`（已连线且已授权根）⇒ `online`
 *   - 无查询结果（null/undefined）⇒ `unknown`（不得猜）
 */
export function deriveLocalBridgeState(query: DeviceBridgeStateInput | null | undefined): LocalBridgeState {
  if (!query) return "unknown"
  if (!query.enabled) return "off"
  if (!query.online) return "credentials_unavailable"
  return query.authorizedRootCount > 0 ? "online" : "no_authorized_roots"
}

/**
 * 接线：判定本回合 localBridge。
 *
 * 顺序与理由：
 *   1. 总开关未开 ⇒ `off`——这是环境层可直接观测的事实，不需 userId（能力未挂载）。
 *   2. 开著但取不到/拿不到 userId ⇒ `unknown`——查不到该使用者的装置注册表，
 *      **不得猜成「没有」**（unknown 的语义铁律）。
 *   3. 查询抛错 ⇒ `unknown`——fail-safe，读不到事实就不下结论。
 *   4. 有 userId ⇒ 呼叫唯读查询，交 `deriveLocalBridgeState` 推导四态。
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

/**
 * W6b：判定本回合的本机档案权限事实（模式 ＋ 已授权根）。顺序与 localBridge 同款：
 * 明确给定（测试）优先；总开关未开／无 userId／查询失败 ⇒ null（读不到不下结论）。
 * 失败不掷出（fail-safe 回 null）。
 */
export function resolveLocalFilePolicy(inputs: {
  userId?: number | null
  deviceBridgeOn?: () => boolean
  deviceBridgePolicy?: (userId: number | null) => LocalFilePolicyFacts | null
  localFilePolicy?: LocalFilePolicyFacts | null
}): LocalFilePolicyFacts | null {
  if (inputs.localFilePolicy !== undefined) return inputs.localFilePolicy ?? null
  const isOn = inputs.deviceBridgeOn ?? deviceBridgeEnabled
  if (!isOn()) return null
  if (inputs.userId === undefined || inputs.userId === null) return null
  const query = inputs.deviceBridgePolicy ?? deviceBridgePolicyState
  try {
    return query(inputs.userId)
  } catch {
    return null
  }
}

// ── 客户端上报净化（逐值白名单）─────────────────────────────────────────

const CLIENT_SURFACES: ReadonlySet<string> = new Set(["web", "desktop-shell"])
const CLIENT_RENDER_HOSTS: ReadonlySet<string> = new Set(["cloud-bridge", "local", "unknown"])

/** 一般物件判定：排除 null 与阵列（两者皆非上报物件，整包丢弃）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 只接受白名单内的确切字串（不 trim、不正规化——避免任何自由文字渗入）。 */
function pickWhitelisted<T extends string>(raw: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof raw === "string" && allowed.has(raw) ? (raw as T) : undefined
}

/** 只接受原生布林；字串 "true"／数字 1／阵列一律视为型别不符 ⇒ 丢该栏。 */
function pickBoolean(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined
}

/**
 * 净化客户端上报（纯函式，同一输入必得同一输出）。规则：
 *   - 非物件（null / 阵列 / 纯量）⇒ 回 `null`（整包丢弃，全部语义 unknown）。
 *   - 只读白名单 key；未知 key（含自由文字、任意长度阵列）一律丢弃，不进结果。
 *   - enum 逐值比对、布林逐值型别检查；型别错或不在白名单 ⇒ 只丢该栏，其余照收。
 *   - 绝不接收自由文字：任何字串都必须命中 enum 白名单才可能进入结果，杜绝
 *     「前端把指令塞进 payload → 落进 system prompt」的权威注入通道。
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

// ── 搜集 ────────────────────────────────────────────────────────────────

/**
 * 由 toolSurface 推导「哪些工具不在工具表」。
 * 纯函式：cut ＝ 该 agent 工具表 map 的键集减去 held。换一份工具表输入，输出跟著变。
 */
export function deriveCapabilityCutoff(toolSurface: ToolSurface): CapabilityCutoff {
  if (!toolSurface.known) {
    return { known: false, tools: [], derivedFrom: toolSurface.agent }
  }
  const held = new Set(toolSurface.held)
  // declared keys ＝ held ∪ cut（真源 map 的全部键）；此处直接对两者做补集推导，
  // 不依赖呼叫端传进来的 cut 栏位是否干净。
  const declared = [...toolSurface.held, ...toolSurface.cut]
  const tools: string[] = []
  for (const id of declared) if (!held.has(id) && !tools.includes(id)) tools.push(id)
  return { known: true, tools, derivedFrom: toolSurface.agent }
}

/** 从真源读某 agent 的工具表；找不到／读不到 → known=false（不得猜）。 */
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

/** 实际搜集环境事实（I/O 可注入以便测试）。 */
export function collectRuntimeEnvironment(inputs: CollectEnvironmentInputs): RuntimeEnvironment {
  const pathExists = inputs.pathExists ?? existsSync
  const toolSurface = readToolSurface(inputs.plane, inputs)
  const capabilityCutoff = deriveCapabilityCutoff(toolSurface)

  const bwrapPath = inputs.bwrapPath ?? DEFAULT_BWRAP_PATH
  const bwrapExists = probePath(bwrapPath, pathExists)
  const sandbox: SandboxFacts =
    bwrapExists === "unknown"
      ? { shell: "unknown", nativeFileTools: "unknown", evidence: `${bwrapPath} 探测失败` }
      : bwrapExists
        ? { shell: "bwrap", nativeFileTools: "unknown", evidence: `探测到 ${bwrapPath} 存在` }
        : { shell: "unavailable", nativeFileTools: "unknown", evidence: `未探测到 ${bwrapPath}` }
  // nativeFileTools：原生档案工具跑在受信 opencode 进程（沙箱外）是 runtime 拓扑事实，
  // 但本进程无法可信探测 opencode 进程的挂载拓扑 ⇒ 一律 unknown，不得猜（待另一包接）。

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
    // 明确给定（测试）优先；否则由装置桥接线推导（env 未开 ⇒ off；取不到 userId ⇒ unknown）。
    localBridge: inputs.localBridge ?? resolveLocalBridgeState(inputs),
    // W6b：权限模式与授权根（只加事实；未开／读不到 ⇒ null，不渲染该行）。
    localFilePolicy: resolveLocalFilePolicy(inputs),
    // 客户端可控上报一律经 sanitize 白名单；非物件／全栏位无效 ⇒ null（语义 unknown）。
    client: sanitizeClientEnvironmentReport(inputs.clientEnvironmentReport),
  }
}

// ── 稳定度 ──────────────────────────────────────────────────────────────

export type EnvironmentStability = "static" | "session" | "turn"

/**
 * 由事实本身决定环境段的稳定度（messages-gw 据此决定是否黏著 latch）。
 *
 * 逐格理由：
 *   - localBridge：装置上下线、授权根变更、凭据可用性每轮都可能变 ⇒ 一旦有值（非
 *     unknown，含 `off`）即判 turn，不得黏著。只有 `unknown`（取不到 userId／查询失败）
 *     才回到 session；因为 unknown 是「读不到」而非「没有」，不得被当成稳定结论黏死。
 *   - client.surface：桌面壳／Web 由客户端在会话内固定 ⇒ 不影响判级（可黏著）。
 *   - client.localCapabilities / client.renderHost：本机能力（ffmpeg 就绪与否）与渲染
 *     主机每轮可变 ⇒ 一旦有具体上报即判 turn，不得黏著；全未上报则不影响判级。
 *   - plane / toolSurface / capabilityCutoff：由本会话挂载的 agent 决定；beast_mode
 *     在会话内固定、工具表来自部署期静态 JSON ⇒ 会话内稳定 ⇒ session（可黏著）。
 *   - sandbox / workspace：探测结果为部署期主机事实＋会话级 uploads 路径语义，
 *     会话内不变但跨 session／跨部署可能不同 ⇒ 不升为 static，一律 session。
 */
export function environmentSectionStability(env: RuntimeEnvironment): EnvironmentStability {
  if (env.localBridge !== "unknown") return "turn"
  // W6b：授权根／模式每轮可变（使用者对话中授权）⇒ 一旦有值即 turn，不得黏著。
  if (env.localFilePolicy) return "turn"
  const client = env.client
  if (client) {
    if (client.localCapabilities && Object.keys(client.localCapabilities).length > 0) return "turn"
    if (client.renderHost !== undefined && client.renderHost !== "unknown") return "turn"
  }
  return "session"
}

// ── 渲染（同一输入必得同一输出）────────────────────────────────────────

function renderWorkspaceExistence(exists: boolean | "unknown"): string {
  if (exists === true) return "存在"
  if (exists === false) return "不存在"
  return "未知"
}

/** W6b：本机档案权限模式与授权根的散文事实（只陈述事实，不带指令语气）。 */
function renderLocalFilePolicy(p: LocalFilePolicyFacts): string {
  const roots = p.authorizedRoots.length > 0 ? p.authorizedRoots.join("、") : "无"
  let contract: string
  switch (p.mode) {
    case "ask":
      contract = "该模式下任何未授权路径都会回 needs_authorization，须先经授权（once/session/permanent）后重试。"
      break
    case "auto":
      contract = "该模式下已授权根内直接可用，根外回 needs_authorization。"
      break
    case "full":
      contract = "该模式下家目录内直接可用；硬 denylist 路径一律拒绝，safety 文件仍会询问。"
      break
    case "off":
      contract = "该模式下本机文件工具一律拒绝。"
      break
  }
  return `mode=${p.mode}；已授权根（${p.authorizedRoots.length}）：${roots}。${contract}`
}

function renderLocalBridge(state: LocalBridgeState): string {
  switch (state) {
    case "off":
      return "已关闭（本机文件通道未挂载）"
    case "no_authorized_roots":
      // 已连线但授权根为空：递归型工具一律拒；给 agent 一句可直接转述的使用者行动指令。
      return "在线，但未授权任何本机根目录（递归型工具一律拒绝）；请使用者在桌面版底栏「本机文件」→「选择文件夹」授权至少一个资料夹"
    case "credentials_unavailable":
      // 据实写「未连线」，**不得**写成「缺少可用凭据」（那是错误成因）：空授权根时桌面壳
      // 根本不注册，闸道侧只能看到「无在线装置」，无法区分「壳没开／壳未登录／壳未授权」。
      // 给 agent 一句可直接抄进对话的使用者行动指令。
      return "未连线（桌面版尚未与本通道连线：可能未开启本机文件权限、未在该桌面版内登录，或本次连线尚未建立）；请使用者在桌面版底栏「本机文件」→「选择文件夹」授权资料夹，并确认已在该桌面版内登录，然后重试本机文件"
    case "online":
      return "在线可用（云端已可经此通道读取使用者授权资料夹）"
    case "unknown":
      return "未知（本轮无法判定）"
  }
}

function renderSandboxShell(shell: ShellSandbox): string {
  if (shell === "bwrap") return "走 bwrap 隔离"
  if (shell === "unavailable") return "不可用（未找到 bwrap 可执行文件）"
  return "未知"
}

/** 客户端运行面：未上报一律渲染成「未知（客户端未上报）」，**不得**写成否定。 */
function renderClientSurface(surface: ClientSurface | undefined): string {
  if (surface === "desktop-shell") return "桌面壳（Electron 薄壳）"
  if (surface === "web") return "Web 浏览器"
  return "未知（客户端未上报）"
}

/** 本机能力三态：true→可用、false→不可用、缺→未知（客户端未上报）。 */
function renderClientCapability(available: boolean | undefined): string {
  if (available === true) return "可用"
  if (available === false) return "不可用"
  return "未知（客户端未上报）"
}

/** 渲染主机：未上报／`unknown` ⇒ 「未知（客户端未上报）」，不得推论。 */
function renderClientRenderHost(host: ClientRenderHost | undefined): string {
  if (host === "local") return "本机"
  if (host === "cloud-bridge") return "云端桥"
  return "未知（客户端未上报）"
}

/**
 * 能力断路事实（单一宣告真源）。由 toolSurface 推导清单与数字，路由语义为既有
 * 规则的固定外框（与旧散文同语义）。legacy v1 帧与环境段共用此函式 ⇒ 不会各自为真源。
 */
/** 开放工具面（beast OFF / creator）：无显式 held、断路很少且不含「仅保留派遣面」语义。 */
export function isOpenToolSurface(ts: ToolSurface): boolean {
  if (!ts.known) return false
  if (ts.held.length > 0) return false
  // creator 真源仅禁 task；亦容忍 cut 为空（未列＝全开）。
  return ts.cut.length === 0 || (ts.cut.length <= 2 && ts.cut.every((id) => id === "task"))
}

export function renderCapabilityCutoffFact(env: RuntimeEnvironment): string {
  const ts = env.toolSurface
  const cutoff = env.capabilityCutoff
  const routing =
    "要执行这些工具，必须经 subagent_dispatch（带 expert 栏）派遣对应 Expert——这是唯一通路。"
  if (!ts.known || !cutoff.known) {
    return `【能力断路·物理事实】未能在真源 expert/opencode-agents.json 找到 agent=${env.plane} 的工具表，工具面未知，勿凭记忆断言自己有什么或没有什么。`
  }
  // beast OFF / creator：默认开放，禁止套用 orchestrator 的「Expert 唯一通路」话术。
  if (isOpenToolSurface(ts)) {
    const cutNote =
      cutoff.tools.length === 0
        ? "未记录任何被移除的工具（未列出＝默认开）。"
        : `仅物理禁用：${cutoff.tools.join("、")}（其余未列出＝默认开）。`
    return `【能力断路·物理事实】真源 expert/opencode-agents.json 对 agent=${env.plane}：${cutNote}域生成工具可直调；多步骤／可并行大活再用 subagent_dispatch。`
  }
  if (cutoff.tools.length === 0) {
    return `【能力断路·物理事实】真源 expert/opencode-agents.json 对 agent=${env.plane} 未记录任何被移除的工具（未列出的工具默认为开）。${routing}`
  }
  // 断路名单过长时只报数量＋显式保留面，避免每轮把百级工具名灌进上下文（2026-10-11 context-slim）。
  const held = ts.held.length > 0 ? `你本回合显式可调用：${ts.held.join("、")}。` : ""
  const cutList =
    cutoff.tools.length <= 24
      ? `已物理移除：${cutoff.tools.join("、")}。`
      : `已物理移除 ${cutoff.tools.length} 个域工具（名单省略；未在显式可调用列表中的自定义工具一律当断路）。`
  return `【能力断路·物理事实】真源 expert/opencode-agents.json 对 agent=${env.plane}：${held}${cutList}${routing}AGENTS.md 路由表中对应断路工具的行，由你派遣的 Expert 代为执行；禁止直调域生成工具。`
}

/**
 * 把环境事实渲染成一段确定的中文散文。同一 RuntimeEnvironment 必得同一输出
 * （无时间戳、无随机、清单顺序＝真源键序）。
 */
export function renderEnvironmentSection(env: RuntimeEnvironment): string {
  const ts = env.toolSurface
  const lines: string[] = ["【环境事实·运行时（由网关按当前环境动态生成，勿凭记忆推测）】"]
  lines.push(`- 本回合挂载 agent：${env.plane}`)

  if (!ts.known) {
    lines.push(`- 工具表：未能在真源 expert/opencode-agents.json 找到 agent=${env.plane} 的条目（工具面未知，勿断言）。`)
  } else if (isOpenToolSurface(ts)) {
    const cutNote =
      ts.cut.length === 0 ? "无物理禁用" : `仅物理禁用 ${ts.cut.join("、")}`
    lines.push(
      `- 工具表（真源 expert/opencode-agents.json）：默认开放（未列出＝开）；${cutNote}。域生成可直调；大活再派 subagent_dispatch。`,
    )
  } else {
    const heldPart = ts.held.length > 0 ? `显式启用 ${ts.held.length} 个：${ts.held.join("、")}` : "无显式启用的工具"
    const cutNote =
      ts.cut.length <= 24
        ? `已从工具表物理移除 ${ts.cut.length} 个`
        : `已从工具表物理移除 ${ts.cut.length} 个域工具（主会话仅保留显式启用面；未列出≠默认可调）`
    lines.push(
      `- 工具表（真源 expert/opencode-agents.json）：${heldPart}；${cutNote}。`,
    )
  }

  const cutoff = env.capabilityCutoff
  if (!cutoff.known) {
    lines.push("- 能力断路：未知（工具表条目缺失）。")
  } else if (isOpenToolSurface(ts)) {
    if (cutoff.tools.length === 0) {
      lines.push("- 能力断路：无（工具面默认开放）。")
    } else {
      lines.push(
        `- 能力断路：仅 ${cutoff.tools.join("、")} 禁用；其余域工具可直调（勿套用 orchestrator 的 Expert 唯一通路）。`,
      )
    }
  } else if (cutoff.tools.length === 0) {
    lines.push("- 能力断路：本档未记录任何被移除的工具。")
  } else if (cutoff.tools.length <= 24) {
    lines.push(
      `- 能力断路：以下 ${cutoff.tools.length} 个工具不在你的工具表，直接调用会失败：${cutoff.tools.join("、")}；执行它们必须经 subagent_dispatch（带 expert 栏）派遣对应 Expert（唯一通路）。`,
    )
  } else {
    lines.push(
      `- 能力断路：${cutoff.tools.length} 个域工具不在你的工具表（名单省略）；直接调用会失败。执行它们必须经 subagent_dispatch（带 expert 栏）派遣对应 Expert（唯一通路）。本回合只准用显式启用工具。`,
    )
  }

  lines.push(
    `- 沙箱：bash/run_py ${renderSandboxShell(env.sandbox.shell)}；原生文件工具沙箱归属：${env.sandbox.nativeFileTools === "outside_sandbox" ? "在沙箱之外" : "未知"}（依据：${env.sandbox.evidence}）。`,
  )
  lines.push(
    `- 工作目录 ${env.workspace.workspaceDir}：${renderWorkspaceExistence(env.workspace.workspaceExists)}；上传目录 ${env.workspace.uploadsDir}：${renderWorkspaceExistence(env.workspace.uploadsExists)}。`,
  )
  // 客户端上报的事实（只有客户端知道）。**栏位缺失（client=null）⇒ 完全不渲染这段**，
  // 以保证「未带 client_environment 的旧请求」收到的环境段与功能上线前逐位元组相同
  // （缺栏位＝unknown，闸道不下任何断言，自然不会被写成否定）。一旦有上报物件，
  // 逐栏诚实渲染：具体值照写，未上报的栏位写「未知（客户端未上报）」，不得写成否定。
  const client = env.client
  if (client) {
    lines.push(`- 客户端运行面：${renderClientSurface(client.surface)}。`)
    const caps = client.localCapabilities
    // 显式区分「能力存在」与「通道已连线」：window.eimuLocal 存在只代表桌面壳在且具备本机
    // 能力，**不代表**云端已能经本机文件通道读到使用者的授权资料夹（是否已连线见下一行）。
    lines.push(
      `- 客户端本机能力：window.eimuLocal ${renderClientCapability(caps?.windowEimuLocal)}；ffmpeg ${renderClientCapability(caps?.ffmpeg)}；ffprobe ${renderClientCapability(caps?.ffprobe)}；本机存档 ${renderClientCapability(caps?.localSave)}。注意：本行只陈述上述本机能力的可用性状态，与「本机文件通道是否已连线」是两件事（能力存在 ≠ 通道已连线）——通道状态请见下一行。`,
    )
    lines.push(`- 客户端渲染主机：${renderClientRenderHost(client.renderHost)}。`)
  }
  lines.push(`- 本机文件通道：${renderLocalBridge(env.localBridge)}。`)
  // W6b：本机档案权限模式与已授权根（只加事实；无在线装置／读不到时不渲染该行）。
  if (env.localFilePolicy) lines.push(`- 本机文件权限：${renderLocalFilePolicy(env.localFilePolicy)}`)

  return lines.join("\n")
}
