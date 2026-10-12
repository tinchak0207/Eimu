// 从 index.ts 无损抽取（2026-09-19 第一阶段）：定价区段（原 index.ts 519–726 行，R5-C 注释起、estimateNodeCoins 止）。
// 依赖说明：
//  - PLATFORM_BASE：逐行复制自 index.ts 465 行（constants-gateway.ts 尚未建立，整合时改 import）
//  - resolveConnectedVideoDuration：仍定义在 index.ts ≈2589 行（画布工作流引擎区），
//    本档以 declare 占位（bun build 只转译不查名，建得过）；整合阶段接线时替换为正式 import。
import { resolveVideoPerSecond } from "./workflow-service"
import { PLATFORM_BASE } from "./constants-gateway.ts"
import { resolveConnectedVideoDuration } from "./workflow-gw.ts"

// 报价只认站内目录明确的x_coins_per_image/x_coins_per_second币字段，TTL10分钟。
// RMB/供应商价格、模板锚点、历史档位与过期快取不能冒充当前平台币价；未知回null。
export const PRICE_CATALOG_TTL_MS = 10 * 60 * 1000
export let priceCatalogCache: { at: number; prices: Record<string, number> } | null = null

/**
 * S4：查平台目录单价（币/张）。权威来源 = GET /v1/models 的 x_coins_per_image，
 * 与工具层 loadCatalog / quote_bundle 完全同一数据源（不许第二个价格宇宙）。
 * 取不到回 null——cost_hint 与门槛估算都宁缺勿编。
 */
export async function catalogUnitCoins(model: string, apiKey: string): Promise<number | null> {
  const now = Date.now()
  if (!priceCatalogCache || now - priceCatalogCache.at > PRICE_CATALOG_TTL_MS) {
    try {
      const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
        const prices: Record<string, number> = {}
        for (const m of body.data ?? []) {
          const id = typeof m.id === "string" ? m.id : null
          if (!id) continue
          const raw = m.x_coins_per_image
          if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) prices[id] = raw
          else if (raw && typeof raw === "object") {
            const o = raw as Record<string, unknown>
            const v = typeof o.standard === "number" ? o.standard : typeof o.hd === "number" ? o.hd : null
            if (v !== null && Number.isFinite(v) && v >= 0) prices[id] = v
          }
        }
        priceCatalogCache = { at: now, prices }
      }
    } catch {
      // 目录不可达：沿用旧快取；完全没有 → 呼叫方拿到 null（不编数）
    }
  }
  const v = priceCatalogCache && now - priceCatalogCache.at <= PRICE_CATALOG_TTL_MS ? priceCatalogCache.prices[model] : undefined
  return typeof v === "number" ? v : null
}

// S4 姊妹快取：查平台目录视频秒价（币/秒）。权威来源 = GET /v1/models 的
// x_coins_per_second，与 catalogUnitCoins（x_coins_per_image）同一份目录回应、
// 同一 10 分钟 TTL——本次事故修复：seedance-2.0 等无 MiniMax 硬编码档位的模型，
// 从目录同源取（与扣费同一函式 generationCoins），不再落错误兜底档位。
export let priceCatalogPerSecondCache: { at: number; table: Record<string, Record<string, number>>; audioTable?: Record<string, Record<string, number>>; capabilities?: Record<string, Record<string, unknown>>; billing?: Record<string, Record<string, unknown>> } | null = null
export async function catalogVideoPerSecondCoins(model: string, apiKey: string): Promise<Record<string, number> | null> {
  const now = Date.now()
  if (!priceCatalogPerSecondCache || now - priceCatalogPerSecondCache.at > PRICE_CATALOG_TTL_MS) {
    try {
      const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
        const table: Record<string, Record<string, number>> = {}
        const audioTable: Record<string, Record<string, number>> = {}
        const capabilities: Record<string, Record<string, unknown>> = {}
        const billing: Record<string, Record<string, unknown>> = {}
        for (const m of body.data ?? []) {
          const id = typeof m.id === "string" ? m.id : null
          if (!id) continue
          billing[id] = m.x_billing && typeof m.x_billing === "object" ? m.x_billing as Record<string, unknown> : {}
          capabilities[id] = m.x_capabilities && typeof m.x_capabilities === "object" ? m.x_capabilities as Record<string, unknown> : {}
          const withAudio = m.x_coins_per_second_with_audio
          if (withAudio && typeof withAudio === "object") {
            audioTable[id] = Object.fromEntries(Object.entries(withAudio).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0)) as Record<string, number>
          }
          const raw = m.x_coins_per_second
          if (raw && typeof raw === "object") {
            const entry: Record<string, number> = {}
            for (const [res_, v] of Object.entries(raw as Record<string, unknown>)) {
              if (typeof v === "number" && Number.isFinite(v) && v >= 0) entry[res_] = v
            }
            const capabilities = m.x_capabilities as { defaultResolution?: unknown } | undefined
            const defaultResolution = capabilities?.defaultResolution
            if (typeof defaultResolution === "string" && typeof entry[defaultResolution] === "number") entry.default = entry[defaultResolution]
            if (Object.keys(entry).length) table[id] = entry
          }
        }
        priceCatalogPerSecondCache = { at: now, table, audioTable, capabilities, billing }
      }
    } catch {
      // 目录不可达：沿用旧快取
    }
  }
  return priceCatalogPerSecondCache && now - priceCatalogPerSecondCache.at <= PRICE_CATALOG_TTL_MS ? priceCatalogPerSecondCache.table[model] ?? null : null
}

/** 报价/提交共用视频选项解析；当前/v1/videos仅接受音轨，分辨率由模型默认决定。 */
export function resolveVideoSubmissionOptions(
  node: { id?: string; metadata: Record<string, unknown> },
  graph: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] } | undefined,
  model: string,
): { resolution: string | null; generateAudio: boolean; error?: string } {
  const cache = priceCatalogPerSecondCache
  const cap = cache && Date.now() - cache.at <= PRICE_CATALOG_TTL_MS ? cache.capabilities?.[model] : undefined
  const config = graph?.nodes.filter((n) => n.kind === "config" && graph.connections.some((c) => c.to === node.id && c.from === n.id)).at(-1)?.metadata ?? {}
  const meta = { ...config, ...node.metadata }
  const defaultResolution = typeof cap?.defaultResolution === "string" ? cap.defaultResolution : null
  const raw = meta.resolution ?? meta.definition ?? meta.quality
  let explicit: string | undefined
  if (raw !== undefined && raw !== "standard" && raw !== "fast") {
    const normalized = String(raw).toLowerCase()
    explicit = normalized === "hd" || normalized === "1080" ? "1080p" : normalized === "720" ? "720p" : normalized
  }
  const resolution = explicit ?? defaultResolution
  const generateAudio = typeof meta.generate_audio === "boolean" ? meta.generate_audio : cap?.defaultAudio === true
  if (!defaultResolution) return { resolution, generateAudio, error: "目录未提供模型默认分辨率，无法核实提交档位" }
  if (explicit && explicit !== defaultResolution) return { resolution, generateAudio, error: `当前视频提交API不接受显式分辨率；请求${explicit}、模型默认${defaultResolution}，未提交且未降规格` }
  if (generateAudio && cap?.audio !== true) return { resolution, generateAudio, error: "当前模型不支持所请求音轨，未提交" }
  return { resolution, generateAudio }
}

function cachedVideoRate(node: { id?: string; metadata: Record<string, unknown> }, graph: Parameters<typeof resolveVideoSubmissionOptions>[1], model: string): number | null {
  const options = resolveVideoSubmissionOptions(node, graph, model)
  if (options.error || !options.resolution) return null
  const cache = priceCatalogPerSecondCache
  if (cache?.billing?.[model]?.unit !== "per_second") return null
  const table = options.generateAudio ? cache?.audioTable?.[model] ?? cache?.table[model] : cache?.table[model]
  const value = table?.[options.resolution]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/** 完整提交档位报价，直接读站点generationCoins导出的金额，不用一秒样本盲乘。 */
export function videoNodeCoinsSync(node: { id?: string; metadata: Record<string, unknown> }, graph: Parameters<typeof resolveVideoSubmissionOptions>[1], durationSeconds: number): number | null {
  const model = typeof node.metadata.model === "string" && node.metadata.model ? node.metadata.model : graph ? resolveNodeModel(node.id ?? "", node, graph) : "minimax-h3"
  const options = resolveVideoSubmissionOptions(node, graph, model)
  if (options.error || !options.resolution) return null
  const billing = priceCatalogPerSecondCache?.billing?.[model]
  if (billing?.currency !== "coins" || (billing.unit !== "per_second" && billing.unit !== "per_video")) return null
  const table = (options.generateAudio ? billing.prices_with_audio ?? billing.prices : billing.prices) as Record<string, Record<string, unknown>> | undefined
  const amount = table?.[options.resolution]?.[String(durationSeconds)]
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : null
}

/** 每次正式预算重新核目录，复用既有读取路径；缓存只供同步画布展示。 */
export function invalidateWorkflowPriceCatalog(): void {
  priceCatalogCache = null
  priceCatalogPerSecondCache = null
}

// 同步变体：estimateGraphCoins（canvas.plan 热路径，同步签名不可 await）专用。
// 只读有效目录快取（不发网络请求）；未暖或过期时价格未知。
export function videoTierPerSecondSync(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number | null {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "minimax-h3"
  const catalogTable = priceCatalogPerSecondCache && Date.now() - priceCatalogPerSecondCache.at <= PRICE_CATALOG_TTL_MS ? priceCatalogPerSecondCache.table[model] ?? null : null
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? () => cachedVideoRate(node, graph, model) : undefined,
  )
}

/**
 * S4：沿连线向上游 config 节点解析 image 节点的实际执行参数（model）。
 * 模板结构：text → config(带 model/size/count) → image*（image 节点
 * metadata 通常为空，model 在上游 config 上——submitWorkflowNode 也是
 * 这样预设的：image 缺 model 时用 pixai-tsubaki2）。最多回看 2 层。
 */
export function resolveNodeModel(
  nodeId: string,
  node: { id?: unknown; kind?: unknown; metadata?: Record<string, unknown> },
  graph: { nodes: { id?: unknown; kind?: unknown; metadata?: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): string {
  if (typeof node.metadata.model === "string" && node.metadata.model) return node.metadata.model
  const upstreamIds = graph.connections.filter((c) => c.to === nodeId).map((c) => c.from)
  // 2026-08-30 事故修复：多 config 时模型跟随最新 cfg，旧 cfg 不再抢先——
  // 旧逻辑按 connections 数组顺序取第一个带 model 的 config，先连的旧 cfg
  //（minimax-h3）永远压住后接的 seedance cfg，rerun 永远解析回旧模型。
  // 改为：遍历入边所有 config 节点，剔除无 model 的，取 graph.nodes 里 index
  // 最大的那个（= 最后创建/最新接的 config）。递归兜底与 pixai-tsubaki2
  // 默认不变，只改这一处选择逻辑。
  let bestConfig: { node: (typeof graph.nodes)[number]; idx: number } | null = null
  for (const uid of upstreamIds) {
    const un = graph.nodes.find((n) => n.id === uid)
    if (un && un.kind === "config" && typeof un.metadata.model === "string" && un.metadata.model) {
      const idx = graph.nodes.findIndex((n) => n.id === un.id)
      if (!bestConfig || idx > bestConfig.idx) bestConfig = { node: un, idx }
    }
  }
  if (bestConfig) return bestConfig.node.metadata.model as string
  for (const uid of upstreamIds) {
    const un = graph.nodes.find((n) => n.id === uid)
    if (un) {
      const m = resolveNodeModel(uid, un, graph)
      if (m !== "pixai-tsubaki2") return m
    }
  }
  return "pixai-tsubaki2"
}

/** 影片每秒平台币价，取当前目录及默认分辨率，无价回null。 */
export async function videoTierPerSecond(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] } | undefined,
  apiKey: string,
): Promise<number | null> {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "minimax-h3"
  // 使用明确coin目录；不采信模板价格或通用5/10兜底。
  const catalogTable = await catalogVideoPerSecondCoins(model, apiKey)
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? () => cachedVideoRate(node, graph, model) : undefined,
  )
}

/** 单节点真实目录币价；视频按实际秒数，缺价格/秒数回null。 */
export async function estimateNodeCoins(
  node: { kind: string; metadata: Record<string, unknown> },
  apiKey: string,
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<number | null> {
  if (node.kind === "video") {
    const nodeId = (node as { id?: string }).id ?? ""
    const cfgDuration = graph ? resolveConnectedVideoDuration(nodeId, graph) : undefined
    const secs =
      typeof node.metadata.duration_seconds === "number" && node.metadata.duration_seconds > 0
        ? node.metadata.duration_seconds
        : cfgDuration
    if (typeof secs !== "number" || !(secs > 0)) return null // 拒绝编数：与 submitWorkflowNode 的「缺时长拒绝提交」同口径
    const model = typeof node.metadata.model === "string" && node.metadata.model ? node.metadata.model : graph ? resolveNodeModel(nodeId, node, graph) : "minimax-h3"
    await catalogVideoPerSecondCoins(model, apiKey)
    return videoNodeCoinsSync(node, graph, secs)
  }
  if (node.kind !== "image") return 0 // audio/film 现行 0 币（TTS 定价 0）
  const nodeId = (node as { id?: string }).id ?? ""
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel(nodeId, node, graph)
        : "pixai-tsubaki2"
  const unit = await catalogUnitCoins(model, apiKey)
  if (unit === null) return null
  return Math.round(unit * 1e6) / 1e6
}
