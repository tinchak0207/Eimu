// 從 index.ts 無損抽取（2026-09-19 第一階段）：定價區段（原 index.ts 519–726 行，R5-C 註釋起、estimateNodeCoins 止）。
// 依賴說明：
//  - PLATFORM_BASE：逐行複製自 index.ts 465 行（constants-gateway.ts 尚未建立，整合時改 import）
//  - resolveConnectedVideoDuration：仍定義在 index.ts ≈2589 行（畫布工作流引擎區），
//    本檔以 declare 佔位（bun build 只轉譯不查名，建得過）；整合階段接線時替換為正式 import。
import { resolveVideoPerSecond } from "./workflow-service"
import { PLATFORM_BASE } from "./constants-gateway.ts"
import { resolveConnectedVideoDuration } from "./workflow-gw.ts"

// R5-C（2026-08-28）影片估價改價目表檔位（暴君欽定：價目表 100% 權威，代碼與
// 價目表衝突 = 代碼錯）：MiniMax H3 720P = 5 幣/秒、1080P = 10 幣/秒。舊 S4
// 0.05 幣/秒估算口徑廢除；目錄 /v1/models 的視頻價是 0.25 RMB 混幣髒價，
// 禁止回落目錄。
// 2026-08-30 双账本收敛：檔位單價不再在此另立常量——統一由 workflow-service 的
// resolveVideoPerSecond（锚点 unit_price_per_second 优先、档位价 5/10 兜底）提供，
// 與 service 側 preflightBudget/midBatchBudgetGate/cost_hint 同一把尺。
// S4 cost_hint 目錄快取：GET /v1/models 的 x_coins_per_image，TTL 10 分鐘
//（與工具層 loadCatalog 同口徑）。估不出單價的模型回 null（不許編數）。
export const PRICE_CATALOG_TTL_MS = 10 * 60 * 1000
export let priceCatalogCache: { at: number; prices: Record<string, number> } | null = null

/**
 * S4：查平台目錄單價（幣/張）。權威來源 = GET /v1/models 的 x_coins_per_image，
 * 與工具層 loadCatalog / quote_bundle 完全同一數據源（不許第二個價格宇宙）。
 * 取不到回 null——cost_hint 與門檻估算都寧缺勿編。
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
      // 目錄不可達：沿用舊快取；完全沒有 → 呼叫方拿到 null（不編數）
    }
  }
  const v = priceCatalogCache?.prices[model]
  return typeof v === "number" ? v : null
}

// S4 姊妹快取：查平台目錄視頻秒價（幣/秒）。權威來源 = GET /v1/models 的
// x_coins_per_second，與 catalogUnitCoins（x_coins_per_image）同一份目錄回應、
// 同一 10 分鐘 TTL——本次事故修復：seedance-2.0 等無 MiniMax 硬編碼檔位的模型，
// 從目錄同源取（與扣費同一函式 generationCoins），不再落錯誤兜底檔位。
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
      // 目錄不可達：沿用舊快取
    }
  }
  return priceCatalogPerSecondCache?.table[model] ?? null
}

// 同步變體：estimateGraphCoins（canvas.plan 熱路徑，同步簽名不可 await）專用。
// 只讀已warm的目錄快取（不發網路請求）；快取未warm時等同舊行為（純錨點/檔位兜底）。
export function videoTierPerSecondSync(
  node: { id?: string; kind: string; metadata: Record<string, unknown> },
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number {
  const model =
    typeof node.metadata.model === "string" && node.metadata.model
      ? node.metadata.model
      : graph
        ? resolveNodeModel((node as { id?: string }).id ?? "", node, graph)
        : "minimax-h3"
  const catalogTable = priceCatalogPerSecondCache?.table[model] ?? null
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? (tier: "720p" | "1080p") => catalogTable[tier] ?? null : undefined,
  )
}

/**
 * S4：沿連線向上游 config 節點解析 image 節點的實際執行參數（model）。
 * 模板結構：text → config(帶 model/size/count) → image*（image 節點
 * metadata 通常為空，model 在上游 config 上——submitWorkflowNode 也是
 * 這樣預設的：image 缺 model 時用 pixai-tsubaki2）。最多回看 2 層。
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
 * R5-C：影片檔位單價（幣/秒）——2026-08-30 双账本收敛：改由 workflow-service 的
 * 共享 resolveVideoPerSecond 提供（锚点 unit_price_per_second 优先、档位价 5/10
 * 兜底），与 service 侧 preflightBudget/midBatchBudgetGate/cost_hint 同一把尺。
 * 此處保留薄封装以不改動既有调用点签名。
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
        : "minimax-h3"
  // catalog 快取：先查一次目錄（同一 apiKey 10 分鐘快取，見 catalogVideoPerSecondCoins）——
  // 本次事故修復：seedance-2.0 等無 MiniMax 硬編碼檔位的模型，從 /v1/models 的
  // x_coins_per_second 同源取（與扣費同一函式 generationCoins），不再被錯誤套用
  // MiniMax 5/10 幣/秒檔位價。resolveVideoPerSecond 優先序：錨點價 → catalogLookup → 檔位 5/10 兜底。
  const catalogTable = await catalogVideoPerSecondCoins(model, apiKey)
  return resolveVideoPerSecond(
    node as never,
    graph as never,
    catalogTable ? (tier: "720p" | "1080p") => catalogTable[tier] ?? null : undefined,
  )
}

/**
 * S4：估算單一可執行節點的幣耗。優先級：節點自帶價 → 平台目錄單價 → null。
 * video 按價目表檔位價（R5-C：720P=5 / 1080P=10 幣/秒）；image 按目錄單價 × 1
 *（submitWorkflowNode 對 workflow 節點固定 n:1，count 在 config 上只是參考標注，
 * 不放大節點張數）。回 null 表示估不出（目錄不可達且模型不在目錄）——上層保持
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
    if (typeof secs !== "number" || !(secs > 0)) return null // 拒絕編數：與 submitWorkflowNode 的「缺時長拒絕提交」同口徑
    const perSec = await videoTierPerSecond(node, graph, apiKey)
    return Math.round(secs * perSec * 100) / 100
  }
  if (node.kind !== "image") return 0 // audio/film 現行 0 幣（TTS 定價 0）
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
