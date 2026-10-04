// 从 index.ts 无损抽取（2026-09-19 第一阶段）：定价区段（原 index.ts 519–726 行，R5-C 注释起、estimateNodeCoins 止）。
// 依赖说明：
//  - PLATFORM_BASE：逐行复制自 index.ts 465 行（constants-gateway.ts 尚未建立，整合时改 import）
//  - resolveConnectedVideoDuration：仍定义在 index.ts ≈2589 行（画布工作流引擎区），
//    本档以 declare 占位（bun build 只转译不查名，建得过）；整合阶段接线时替换为正式 import。
import { resolveVideoPerSecond } from "./workflow-service"
import { PLATFORM_BASE } from "./constants-gateway.ts"
import { resolveConnectedVideoDuration } from "./workflow-gw.ts"

// R5-C（2026-08-28）影片估价改价目表档位（暴君钦定：价目表 100% 权威，代码与
// 价目表冲突 = 代码错）：MiniMax H3 720P = 5 币/秒、1080P = 10 币/秒。旧 S4
// 0.05 币/秒估算口径废除；目录 /v1/models 的视频价是 0.25 RMB 混币脏价，
// 禁止回落目录。
// 2026-08-30 双账本收敛：档位单价不再在此另立常量——统一由 workflow-service 的
// resolveVideoPerSecond（锚点 unit_price_per_second 优先、档位价 5/10 兜底）提供，
// 与 service 侧 preflightBudget/midBatchBudgetGate/cost_hint 同一把尺。
// S4 cost_hint 目录快取：GET /v1/models 的 x_coins_per_image，TTL 10 分钟
//（与工具层 loadCatalog 同口径）。估不出单价的模型回 null（不许编数）。
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
          if (typeof raw === "number") prices[id] = raw
          else if (raw && typeof raw === "object") {
            const o = raw as Record<string, unknown>
            const v = typeof o.standard === "number" ? o.standard : typeof o.hd === "number" ? o.hd : null
            if (v !== null) prices[id] = v
          }
        }
        if (Object.keys(prices).length > 0) priceCatalogCache = { at: now, prices }
      }
    } catch {
      // 目录不可达：沿用旧快取；完全没有 → 呼叫方拿到 null（不编数）
    }
  }
  const v = priceCatalogCache?.prices[model]
  return typeof v === "number" ? v : null
}

// S4 姊妹快取：查平台目录视频秒价（币/秒）。权威来源 = GET /v1/models 的
// x_coins_per_second，与 catalogUnitCoins（x_coins_per_image）同一份目录回应、
// 同一 10 分钟 TTL——本次事故修复：seedance-2.0 等无 MiniMax 硬编码档位的模型，
// 从目录同源取（与扣费同一函式 generationCoins），不再落错误兜底档位。
export let priceCatalogPerSecondCache: { at: number; table: Record<string, Record<string, number>> } | null = null
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
        for (const m of body.data ?? []) {
          const id = typeof m.id === "string" ? m.id : null
          if (!id) continue
          const raw = m.x_coins_per_second
          if (raw && typeof raw === "object") {
            const entry: Record<string, number> = {}
            for (const [res_, v] of Object.entries(raw as Record<string, unknown>)) {
              if (typeof v === "number") entry[res_] = v
            }
            if (Object.keys(entry).length) table[id] = entry
          }
        }
        if (Object.keys(table).length > 0) priceCatalogPerSecondCache = { at: now, table }
      }
    } catch {
      // 目录不可达：沿用旧快取
    }
  }
  return priceCatalogPerSecondCache?.table[model] ?? null
}

// 同步变体：estimateGraphCoins（canvas.plan 热路径，同步签名不可 await）专用。
// 只读已warm的目录快取（不发网路请求）；快取未warm时等同旧行为（纯锚点/档位兜底）。
export function videoTierPerSecondSync(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "seedance-2.0"
  const catalogTable = priceCatalogPerSecondCache?.table[model] ?? null
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? (tier: "720p" | "1080p") => catalogTable[tier] ?? null : undefined,
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

/**
 * R5-C：影片档位单价（币/秒）——2026-08-30 双账本收敛：改由 workflow-service 的
 * 共享 resolveVideoPerSecond 提供（锚点 unit_price_per_second 优先、档位价 5/10
 * 兜底），与 service 侧 preflightBudget/midBatchBudgetGate/cost_hint 同一把尺。
 * 此处保留薄封装以不改动既有调用点签名。
 */
export async function videoTierPerSecond(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] } | undefined,
  apiKey: string,
): Promise<number> {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "seedance-2.0"
  // catalog 快取：先查一次目录（同一 apiKey 10 分钟快取，见 catalogVideoPerSecondCoins）——
  // 本次事故修复：seedance-2.0 等无 MiniMax 硬编码档位的模型，从 /v1/models 的
  // x_coins_per_second 同源取（与扣费同一函式 generationCoins），不再被错误套用
  // MiniMax 5/10 币/秒档位价。resolveVideoPerSecond 优先序：锚点价 → catalogLookup → 档位 5/10 兜底。
  const catalogTable = await catalogVideoPerSecondCoins(model, apiKey)
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? (tier: "720p" | "1080p") => catalogTable[tier] ?? null : undefined,
  )
}

/**
 * S4：估算单一可执行节点的币耗。优先级：节点自带价 → 平台目录单价 → null。
 * video 按价目表档位价（R5-C：720P=5 / 1080P=10 币/秒）；image 按目录单价 × 1
 *（submitWorkflowNode 对 workflow 节点固定 n:1，count 在 config 上只是参考标注，
 * 不放大节点张数）。回 null 表示估不出（目录不可达且模型不在目录）——上层保持
 * null / 保守策略。
 */
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
    const perSec = await videoTierPerSecond(node, graph, apiKey)
    return Math.round(secs * perSec * 100) / 100
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
