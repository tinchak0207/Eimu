// 画布工作流服务（Workflow Service）
//
// 暴君策略 v2：Deepseek 透过 workflow_* 工具填内容，本服务展开节点流并执行。
// 本档案独立于 gateway index.ts（Bun 动态 import），接受注入的 emit 函数
// （gateway 的 emitToSession）——保持 gateway 单档干净、本模组可测。
//
// 执行流程：
//   start(templateId, content) → 展开节点流（expandTemplate）→ 存 session
//   addNode / connect → 修改节点流
//   generate → topo 排序 → 逐节点执行（text/config 跳过，image/video 调平台）
//             → emit canvas.* 事件 → 回填结果
//
// 流式搭建（2026-08-21）：canvas.plan / node.created / node.connected 不再等
// workflow_generate 一次性爆发——start 成功即推送展开的节点流，addNode /
// connect 各自即时推送增量。generate 只补发没发过的漏网节点（emitGraph 为
// 增量语义，emittedNodes/emittedConnections 去重），前端在 agent 逐步搭建的
// 同步就能看到工作流「长」出来，与左侧 tool 卡同步。
//
// 平台执行依赖注入（避免本档耦合 fetch/认证）：
//   runNode(node, upstreamResults) => Promise<{ok, content?, costCoins?, error?}>
//   - image → 调 /v1/images/generations
//   - video → 调 /v1/videos/generations

import { expandTemplate, topologicalSort, type WorkflowGraph, type WorkflowNode, type WorkflowNodeResult, type TemplateContent } from "./workflow-engine"
import { getWorkflowTemplate, listWorkflowTemplates } from "./workflow-templates"
import { validateShotJson, parseShotCandidate, shotOutputParams } from "./video-prompt-schema"
import { isRetryableNodeError } from "./error-classify"

export interface EmitFn {
  (state: unknown, name: string, data: unknown): void
}

export interface RunNodeFn {
  /**
   * 执行单一节点。upstream = 已完成的上游节点 id → content 映射。
   * graph = 整个节点流（供 submit 解析上游 text/config 拿 prompt/参考）。
   * node 本身 metadata 可能只有 config 的 model/size——prompt 常在上游。
   */
  (node: WorkflowNode, upstream: Map<string, string>, graph: WorkflowGraph): Promise<WorkflowNodeResult>
}

export interface WorkflowServiceOptions {
  emit: EmitFn
  runNode: RunNodeFn
  /**
   * S5a（2026-08-27）：错误人话化挂点（index.ts 注入 humanMessageFor）。
   * 节点失败的 canvas.node.updated patch 在 errorDetails 原文之外补
   * human_message 中文短句；未注入则维持旧载荷。
   */
  humanize?: (message: string) => string
  /**
   * 状态变更通知（持久化挂点，对齐 canvas 快照的 markDirty 模式）：
   * start/addNode/connect/generate 的每次节点状态/结果变更后同步呼叫，
   * gateway 在这里把 workflow 快照镜像回 session（随防抖落盘）。
   * owner 是 start 时绑定的 session 物件（可能为 null——恢复路径会重新绑定）。
   */
  onDirty?: (wf: ActiveWorkflow) => void
  /**
   * S4（2026-08-27）：整圖幣耗估價掛點（gateway 注入，同步簽名）。
   * 用於 canvas.plan 的 cost_hint。null = 估不出（不許編數）。未注入回 null。
   */
  estimateGraphCoins?: (graph: WorkflowGraph) => number | null
  /**
   * R8（2026-09-10 多鏡展開修復）：可用視頻模型動態選型掛點（gateway 注入）。
   * 大片模板 shotN_gen 不再寫死 model=minimax-h3（該模型當前不可用），start 時
   * 由 gateway 查 /v1/model-status 選當前可用的視頻模型回填。回 null/undefined =
   * 掛點不可用（探測故障），回退引擎默認（與舊行為一致，submit 前仍有 F2 failover
   * 兜底）。輪子 = index.ts 的 resolveActiveModel 同源（/v1/model-status 判活）。
   */
  pickDefaultVideoModel?: () => Promise<string | null>
}

export interface ActiveWorkflow {
  workflowId: string
  templateId: string
  graph: WorkflowGraph
  status: "building" | "running" | "success" | "partial" | "failed" | "paused_insufficient_quota"
  nodeStatus: Record<string, "pending" | "running" | "success" | "error">
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
  owner: unknown // 建立时绑定的 session；emit 事件送回这个 session，后台执行不受 stateForWorkflow 影响
  // 流式搭建去重：plan 只发一次；节点/连线按 id/边去重，generate 再呼叫 emitGraph 只补增量。
  planEmitted: boolean
  emittedNodes: Set<string>
  emittedConnections: Set<string>
}

let workflowCounter = 0

/**
 * 同层并行分批（2026-08-27）：把 topo order 按「依赖深度」切层——层 L 的节点只依赖层 < L
 * 的节点，同层节点互不依赖 → 可并行；批间严格串行（下游等上游）。order 为 topo 序，前驱必已分层。
 */
function splitIntoBatches(order: string[], graph: WorkflowGraph): string[][] {
  const layerOf = new Map<string, number>()
  const batches: string[][] = []
  for (const nodeId of order) {
    let layer = 0
    for (const c of graph.connections) {
      if (c.to !== nodeId) continue
      const fromLayer = layerOf.get(c.from)
      if (fromLayer !== undefined && fromLayer + 1 > layer) layer = fromLayer + 1
    }
    layerOf.set(nodeId, layer)
    ;(batches[layer] ??= []).push(nodeId)
  }
  return batches
}

/**
 * R5-B（2026-08-28）：可重試錯誤識別——poll timeout / 上游 5xx / 網絡抖動類
 * 自動退避重試；語義性失敗（缺提示詞、模型不可用、submit 4xx）不浪費重試。
 * 0920 收口：原單條正則 RETRYABLE_NODE_ERROR 併入 error-classify.ts 的單一
 * 有序表 ERROR_RULES（與人話翻譯同源同序），判定改走 isRetryableNodeError。
 */

/**
 * R5-B/R5-D2（2026-08-29 價目表糾偏）：節點單價解析——沿連線向上游 config（≤2 層）
 * 取指定價格欄位。取數原則 = 與 /pricing 數據源同源，衝突時改代碼：
 *   - unit_price_coins（幣/張）：pixai 系 0.001（價目表權威值；/v1/models 目錄同源
 *     正確。R5-B 曾誤信 ledger 實扣 3 幣/張——真相是計費層多扣 3000 倍的 bug，
 *     另線修復，ledger 不作價格依據）。
 *   - unit_price_per_second（幣/秒）：MiniMax H3 檔位 720P = 5、1080P 見
 *     unit_price_per_second_1080p = 10（暴君價目表）。目錄對 minimax-h3 標 0.25
 *     是 RMB 混幣髒價，影片禁用目錄。
 * 圖片預設欄位行為不變；欄位參數化供影片檔位復用同一條 2 層上游解析。
 */
export function resolveNodeUnitPrice(node: WorkflowNode, graph: WorkflowGraph, field = "unit_price_coins"): number | null {
  const self = node.metadata[field]
  if (typeof self === "number" && self > 0) return self
  const connections = Array.isArray(graph?.connections) ? graph.connections : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const upstreamOf = (id: string) =>
    connections
      .filter((c) => c.to === id)
      .map((c) => nodes.find((n) => n.id === c.from))
      .filter((n): n is WorkflowNode => Boolean(n))
  let frontier = upstreamOf(node.id)
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    for (const up of frontier) {
      if (up.kind === "config") {
        const v = up.metadata[field]
        if (typeof v === "number" && v > 0) return v
      }
    }
    frontier = frontier.flatMap((up) => upstreamOf(up.id))
  }
  return null
}

/**
 * 2026-08-30 双账本收敛：网关侧硬编码档位价（5/10 币/秒）与 service 侧 metadata
 * 锚点价（unit_price_per_second）两套宇宙——同一工作流两个估值各写各的，报价与
 * 实扣可能漂移。收敛为单一公共函数：档位判定 + 锚点价优先、档位价兜底。
 * 供 index.ts 的 estimateNodeCoins / estimateGraphCoins 与 workflow-service 的
 * estimateGraphLocalCoins 同源调用（CONFIRM_THRESHOLD / preflightBudget /
 * midBatchBudgetGate / cost_hint 同一把尺）。
 */
/**
 * 2026-08-31 R10 计费同源：加第三个可选参数 catalogLookup——由呼叫方（index.ts
 * 的 videoTierPerSecond）传入查平台目录 x_coins_per_second 的闭包。优先级变成
 * 锚点价（unit_price_per_second，暴君裁定不动）→ 目录价（本次新增，seedance-2.0
 * 等无 MiniMax 硬编码档位的模型走这层）→ 档位 5/10 兜底（暴君裁定 MiniMax H3
 * 校准值，不动）。省略第三参数时与旧版逐字节等价，preflightBudget/
 * midBatchBudgetGate/cost_hint 三个既有调用点不用改。
 */
export function resolveVideoPerSecond(
  node: WorkflowNode,
  graph: WorkflowGraph,
  catalogLookup?: (tier: "720p" | "1080p") => number | null,
): number {
  const tier = videoQualityTier(node, graph)
  const anchored = resolveNodeUnitPrice(
    node,
    graph,
    tier === "1080p" ? "unit_price_per_second_1080p" : "unit_price_per_second",
  )
  if (anchored !== null && anchored > 0) return anchored
  // R10 协调修复：catalogLookup 不再要求本函式自行解析 node.metadata.model——
  // video 节点自身的 model 常态为空（model 挂在上游 config），呼叫方
  // （index.ts 的 videoTierPerSecond）已用 resolveNodeModel 解析好完整 model 并
  // 闭包捕获，这里直接调用即可；此前要求 node.metadata.model 非空才调用闭包，
  // 导致目录 fallback 恒不触发（闭包永远没机会跑）。
  if (catalogLookup) {
    const fromCatalog = catalogLookup(tier)
    if (fromCatalog !== null && fromCatalog > 0) return fromCatalog
  }
  return tier === "1080p" ? 10 : 5
}
/**
 * R5-D2：影片檔位探測——quality 欄位（節點自身或上游 config ≤2 層；index.ts 提交
 * 視頻時原樣透傳 cfg.quality）含 "1080" → 1080P 檔；含 "720" 或缺省 → 720P 檔
 *（保守取低檔）。resolution/definition 欄位同名同判。
 */
function videoQualityTier(node: WorkflowNode, graph: WorkflowGraph): "720p" | "1080p" {
  const scan = (meta: Record<string, unknown>): string | null => {
    for (const k of ["quality", "resolution", "definition"]) {
      const v = meta[k]
      if (typeof v === "string" && v) return v
      if (typeof v === "number") return String(v)
    }
    return null
  }
  const selfQ = scan(node.metadata)
  if (selfQ?.includes("1080")) return "1080p"
  if (selfQ?.includes("720")) return "720p"
  const connections = Array.isArray(graph?.connections) ? graph.connections : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const upstreamOf = (id: string) =>
    connections
      .filter((c) => c.to === id)
      .map((c) => nodes.find((n) => n.id === c.from))
      .filter((n): n is WorkflowNode => Boolean(n))
  let frontier = upstreamOf(node.id)
  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    for (const up of frontier) {
      if (up.kind === "config") {
        const q = scan(up.metadata)
        if (q?.includes("1080")) return "1080p"
        if (q?.includes("720")) return "720p"
      }
    }
    frontier = frontier.flatMap((up) => upstreamOf(up.id))
  }
  return "720p"
}

/** 餘額解析（與 gateway fetchBalance/extractBalance 同構：balance_coins/balance/coins/credit，遞歸 data）。 */
function extractBalanceLocal(data: unknown): number | null {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    for (const k of ["balance_coins", "balance", "coins", "credit"]) {
      if (typeof obj[k] === "number") return obj[k]
    }
    if (obj.data && typeof obj.data === "object") return extractBalanceLocal(obj.data)
  }
  return null
}

/** 节点的结构化 shot JSON（metadata.shot），给 index.ts 的 submitWorkflowNode 编译 prompt 用。没有则 null。 */
export function resolveNodeShot(node: { kind: string; metadata: Record<string, unknown> }): unknown {
  return node.metadata.shot !== undefined ? node.metadata.shot : null
}

/**
 * R5-D2：image 節點模型名解析——自身 metadata.model → 直接上游 config 的 model
 *（引擎對缺 model 的 image 節點用 pixai-tsubaki2，index.ts submitWorkflowNode
 * 文檔行為）；取不到回 null（= 走引擎 pixai 預設）。
 */
function resolveImageModelName(node: WorkflowNode, graph: WorkflowGraph): string | null {
  if (typeof node.metadata.model === "string" && node.metadata.model) return node.metadata.model
  const connections = Array.isArray(graph?.connections) ? graph.connections : []
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  for (const c of connections) {
    if (c.to !== node.id) continue
    const up = nodes.find((n) => n.id === c.from)
    if (up && up.kind === "config" && typeof up.metadata.model === "string" && up.metadata.model) return up.metadata.model
  }
  return null
}

export class WorkflowService {
  private workflows = new Map<string, ActiveWorkflow>()
  // F1（2026-08-31）：執行循環去重集合——generate() 重入守衛與 finally 清理用。
  private generateLoops = new Set<string>()
  constructor(private opts: WorkflowServiceOptions) {}

  /** 通知 gateway：本工作流有状态变更，请镜像进 session 持久化（防抖落盘）。 */
  private dirty(wf: ActiveWorkflow): void {
    try {
      this.opts.onDirty?.(wf)
    } catch {
      // 持久化故障绝不杀工作流执行（fail-open，与 canvas 快照同语义）
    }
  }

  /** 恢复路径专用：把快照重建的 ActiveWorkflow 灌回 Map（不触发 dirty，避免回写放大）。 */
  restore(wf: ActiveWorkflow): void {
    this.workflows.set(wf.workflowId, wf)
  }

  /** teardown 清理：摘除内存工作流（快照已随 session 落盘/删除，不需再动）。 */
  forget(workflowId: string): void {
    this.workflows.delete(workflowId)
  }

  /**
   * R5-B：節點執行 + 自動重試——可重試錯誤（timeout/poll 5xx/網絡）退避 5s、15s
   * 重試 2 次，重試耗盡才判 error；不可重試錯誤（缺提示詞/模型不可用/submit 4xx）
   * 立即返回不浪費重試。每步 console.log 留 journal 路徑證據。
   */
  private async runNodeWithRetry(node: WorkflowNode, upstream: Map<string, string>, graph: WorkflowGraph): Promise<WorkflowNodeResult> {
    const maxRetries = 2
    const backoffs = [5_000, 15_000]
    let last: WorkflowNodeResult | null = null
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (attempt > 1) {
        const wait = backoffs[Math.min(attempt - 2, backoffs.length - 1)]
        console.log(`[workflow-retry] ${node.id} attempt ${attempt}/${maxRetries + 1} in ${wait}ms (prev: ${String(last?.error ?? "").slice(0, 140)})`)
        await new Promise((r) => setTimeout(r, wait))
      }
      const result = await this.opts.runNode(node, upstream, graph)
      if (result.ok) {
        if (attempt > 1) console.log(`[workflow-retry] ${node.id} RECOVERED on attempt ${attempt}`)
        return result
      }
      last = result
      const msg = String(result.error ?? "")
      if (!isRetryableNodeError(msg)) {
        console.log(`[workflow-retry] ${node.id} non-retryable (attempt ${attempt}): ${msg.slice(0, 160)}`)
        return result
      }
      console.log(`[workflow-retry] ${node.id} retryable error (attempt ${attempt}): ${msg.slice(0, 160)}`)
    }
    console.error(`[workflow-retry] ${node.id} retries exhausted (${maxRetries})`)
    return { nodeId: last?.nodeId ?? node.id, ok: false, error: `${last?.error ?? "unknown"}（已自动重试 ${maxRetries} 次仍失败）` }
  }

  /**
   * R5-B/R5-D2：本地估價——image 節點取 config 的 unit_price_coins（pixai 系 0.001
   * 幣/張 = 價目表同源值；5 張 ≈ 0.005 幣是正確顯示）；無 config 價錨時解析模型：
   * 缺 model（引擎預設 pixai-tsubaki2）或 pixai 系 → 價目表 0.001，其他模型無本地錨
   * → null（純圖工作流由目錄掛點同源補價）。video 節點按 quality 檔位取
   * unit_price_per_second（720P = 5 幣/秒預設、1080P = 10 幣/秒），秒數取節點/上游
   * config 的 duration_seconds，取不到按保守預設 5s。0.05 幣/秒舊口徑與目錄髒價
   *（minimax-h3 被標 0.25，RMB 混幣）一律禁用；解析不到錨點 → null（寧缺勿編）。
   */
  estimateGraphLocalCoins(graph: WorkflowGraph): number | null {
    let total = 0
    let any = false
    for (const n of graph.nodes) {
      if (n.kind === "text" || n.kind === "config") continue
      any = true
      if (n.kind === "video") {
        // R5-D2：檔位價——1080P 只認 unit_price_per_second_1080p（無檔位價不低報，
        // 回 null）；720P（含缺省）認 unit_price_per_second。
        const perSec =
          videoQualityTier(n, graph) === "1080p"
            ? resolveNodeUnitPrice(n, graph, "unit_price_per_second_1080p")
            : resolveNodeUnitPrice(n, graph, "unit_price_per_second")
        if (perSec === null) return null // 無錨點不編數（0.05 舊口徑已廢）
        const selfSecs = n.metadata.duration_seconds
        const secs =
          typeof selfSecs === "number" && selfSecs > 0
            ? selfSecs
            : (resolveNodeUnitPrice(n, graph, "duration_seconds") ?? 5) // 保守預設 5s
        total += perSec * secs
        continue
      }
      if (n.kind !== "image") continue
      const anchored = resolveNodeUnitPrice(n, graph)
      if (anchored !== null) {
        total += anchored
        continue
      }
      // R5-D2：無價錨——模型歸屬判斷（見 resolveImageModelName）
      const model = resolveImageModelName(n, graph)
      if (model && !model.startsWith("pixai")) return null
      total += 0.001 // 缺 model = 引擎預設 pixai-tsubaki2；pixai 系 = 價目表 0.001 幣/張
    }
    return any ? Math.round(total * 1e6) / 1e6 : null
  }

  /**
   * R5-B/R5-D2：全圖估價——本地錨點（unit_price_coins / unit_price_per_second，
   * 價目表同源）優先。含 video 節點的圖禁用 gateway 目錄回落：video 舊口徑
   * 0.05 幣/秒與目錄髒價（minimax-h3 標 0.25，RMB 混幣）都會從回落漏進來——
   * 寧可 null 不回落髒價。純圖工作流本地估不出才回落 gateway 目錄掛點
   *（目錄圖片價與 /pricing 同源正確；seedance 2.0 是視頻模型，分類歸屬由域 A 修，
   * 本估價不把它當圖片模型——無 unit_price 錨點即 null）。
   */
  estimateTotalCoins(graph: WorkflowGraph): number | null {
    const local = this.estimateGraphLocalCoins(graph)
    if (local !== null) return local
    if (graph.nodes.some((n) => n.kind === "video")) return null
    return this.opts.estimateGraphCoins ? this.opts.estimateGraphCoins(graph) : null
  }

  /**
   * R5-B：開工前餘額預檢——/v1/quota（QUOTA_URL env，先例=gateway fetchBalance；
   * 2026-08-28 實測 200 {balance_coins}）。餘額 < 預算 → 拒絕開工（帶缺口數字），
   * 不燒到一半才死。預算估不出或餘額端點故障 → fail-open 放行（預檢故障不卡死工作流）。
   * 回 null = 放行；回字串 = 拒絕原因（帶缺口數字）。
   */
  /** R9：讀 owner 餘額（/v1/quota，幣）。端點缺失/故障/解析失敗 = null，fail-open 姿勢由呼叫方定。 */
  private async ownerBalance(wf: ActiveWorkflow): Promise<number | null> {
    const owner = wf.owner as { apiKey?: string } | null | undefined
    const key = owner?.apiKey
    if (!key) return null
    const base = (process.env.PLATFORM_BASE || "https://image.tinchak0207.xyz").replace(/\/+$/, "")
    const quotaUrl = process.env.QUOTA_URL || `${base}/v1/quota`
    try {
      const res = await fetch(quotaUrl, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      const data = (await res.json().catch(() => null)) as unknown
      return extractBalanceLocal(data)
    } catch {
      return null
    }
  }

  /**
   * R9：批間餘額閘——對「尚未成功的可執行節點」重估總價，餘額不足即暫停。
   * commit 在批次之間落帳，preflight 只看開工那一刻，攔不住「跑到一半扣穿」
   *（2026-08-29 實錘：agent 影片批量淨扣 145 幣把餘額打成 -9.11 無人攔）。
   * 回 null = 放行；回字串 = 暫停原因（帶缺口數字，經 generate 拒絕通道轉發用戶）。
   * 已成功節點保留；充值後重新 generate 沿用 resume 語義只跑剩餘部分。
   */
  private async midBatchBudgetGate(wf: ActiveWorkflow): Promise<string | null> {
    const pending = wf.graph.nodes.filter(
      (n) => n.kind !== "text" && n.kind !== "config" && wf.nodeStatus[n.id] !== "success",
    )
    if (!pending.length) return null
    const need = this.estimateTotalCoins({ nodes: pending, connections: wf.graph.connections })
    if (need === null || !(need > 0)) return null
    const balance = await this.ownerBalance(wf)
    if (balance === null) return null
    if (balance < need) {
      const gap = Math.round((need - balance) * 1e6) / 1e6
      console.log(`[workflow-budget] ${wf.workflowId} PAUSED mid-run: need=${need} balance=${balance} gap=${gap} pending=${pending.length}`)
      return `余额不足，已暂停剩余节点：完成剩余部分还需要约 ${need} 币，当前余额 ${balance} 币，缺口 ${gap} 币。已完成的节点不受影响；充值后重新执行工作流会自动续跑剩余部分。`
    }
    return null
  }

  private async preflightBudget(wf: ActiveWorkflow): Promise<string | null> {
    const need = this.estimateTotalCoins(wf.graph)
    if (need === null || !(need > 0)) return null
    const owner = wf.owner as { apiKey?: string } | null | undefined
    if (!owner?.apiKey) {
      console.log(`[workflow-budget] ${wf.workflowId} preflight skipped: no session key on owner (need=${need})`)
      return null
    }
    const balance = await this.ownerBalance(wf)
    if (balance === null) {
      console.log(`[workflow-budget] ${wf.workflowId} preflight skipped: quota endpoint unavailable (need=${need})`)
      return null
    }
    if (balance < need) {
      const gap = Math.round((need - balance) * 1e6) / 1e6
      console.log(`[workflow-budget] ${wf.workflowId} BLOCKED: need=${need} balance=${balance} gap=${gap}`)
      return `余额不足，拒绝开工：本次工作流预估 ${need} 币，当前余额 ${balance} 币，缺口 ${gap} 币。请充值，或缩减节点数量／更换更便宜的模型后再开工。`
    }
    console.log(`[workflow-budget] ${wf.workflowId} preflight pass: need=${need} balance=${balance}`)
    return null
  }

  templates() {
    return listWorkflowTemplates()
  }

  /**
   * R8（2026-09-10 多鏡展開修復）：async 入口。shotN_gen 的 model 動態選型
   * （pickDefaultVideoModel 掛點查 /v1/model-status 判活）需要 await——舊 start
   * 是同步函數，gateway 路由「error in r」守衛對 Promise 誤判。拆成：
   *   start()          = async 包裝（選模型，5s 超時 fail-open 回 null）→ startSync()
   *   startSync(...)   = 原有全部邏輯（驗證/展開/預設/duration 對齊/建 wf），同步純淨。
   * content shot 的 duration_seconds 對齊在 startSync 內做（text 節點 shot JSON
   * 解析後，同鏈回寫下游 config 的 duration_seconds——agent 傳 10s 就 10s，別回 5s）。
   */
  async start(templateId: string | null, content: TemplateContent = {}, owner?: unknown): Promise<{ workflowId: string } | { error: string }> {
    let videoModel: string | null = null
    if (templateId && this.opts.pickDefaultVideoModel && getWorkflowTemplate(templateId)?.multiShot) {
      // fail-open：探測不可達/逾時 → null → startSync 用引擎默認（submit 前仍有 F2 failover）
      videoModel = await Promise.race([
        this.opts.pickDefaultVideoModel().catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ])
    }
    return this.startSync(templateId, content, owner, videoModel)
  }

  /**
   * 0920 暴君裁定（壓縮垃圾時間）：骨架上畫布路徑**禁**走視頻模型探測——
   * start() 對 multiShot 模板會 await pickDefaultVideoModel（上限 5s fail-open），
   * 而那 5 秒對「讓用戶看見骨架」零貢獻（節點 metadata.model 由 config 節點
   * defaults 或 workflow_generate 時的動態選型接手，startSync 的 videoModel 只是
   * 建構期預填）。Jev 判定是毫秒級，骨架也該是毫秒級。
   */
  startFast(templateId: string | null, content: TemplateContent = {}, owner?: unknown): { workflowId: string } | { error: string } {
    return this.startSync(templateId, content, owner, null)
  }

  /** 建工作流（从模板或空）。回 workflowId 或 error（模板缺必需内容时）。 */
  startSync(templateId: string | null, content: TemplateContent = {}, owner?: unknown, defaultVideoModel?: string | null): { workflowId: string } | { error: string } {
    const template = templateId ? getWorkflowTemplate(templateId) : undefined
    // 校验：模板每个 text role 都必须填内容（content/prompt 非空字串，或带有效 shot JSON），
    // 不让空白画布产生（agent 收到 400 后补齐重试）。shot 存在但无效 → 明确报错。
    if (template) {
      const missing: string[] = []
      const invalidShots: string[] = []
      for (const n of template.nodes) {
        if (n.kind !== "text") continue
        const c = content[n.role] as Record<string, unknown> | undefined
        const text = typeof c?.content === "string" ? c.content : typeof c?.prompt === "string" ? c.prompt : ""
        if (text.trim()) continue
        if (c && c.shot !== undefined) {
          const v = validateShotJson(c.shot)
          if (v.ok) continue
          invalidShots.push(`模板「${template.name}」角色 ${n.role} 的 shot JSON 无效：${"error" in v ? v.error : "unknown"}`)
          continue
        }
        missing.push(`${n.role}(${n.title})`)
      }
      if (missing.length || invalidShots.length) {
        const parts: string[] = []
        if (missing.length) parts.push(`模板「${template.name}」缺少必要内容：${missing.join("、")}。请重新呼叫 workflow_start 并在 content 中补齐：{ ${missing.map((m) => `${m.split("(")[0]}: { content: "..." }`).join(", ")} }`)
        if (invalidShots.length) parts.push(invalidShots.join("\n"))
        return { error: parts.join("\n") }
      }
    }
    workflowCounter += 1
    const workflowId = `wf_${Date.now().toString(36)}_${workflowCounter}`
    const graph = template ? expandTemplate(templateId!, template, content) : { nodes: [], connections: [] }
    // config 节点补默认参数（与 submitWorkflowNode 的默认一致），画布上永远显示得出参数
    for (const n of graph.nodes) {
      if (n.kind === "config") {
        const isVideo = n.metadata.kind === "video"
        if (!n.metadata.model) n.metadata.model = isVideo ? defaultVideoModel || "seedance-2.0" : "pixai-tsubaki2"
        if (!n.metadata.size) n.metadata.size = isVideo ? "16:9" : "1024x1024"
      }
    }
    // text 节点 shot JSON：content 本身是 shot JSON 字串时解析存回 metadata.shot（原 content 不动）；
    // metadata.shot 存在则验证（无效 → 400），有效时把 duration/aspect_ratio 回写节点参数（仅当原本没有）。
    for (const n of graph.nodes) {
      if (n.kind !== "text") continue
      if (n.metadata.shot === undefined && typeof n.metadata.content === "string") {
        const parsed = parseShotCandidate(n.metadata.content)
        if (parsed) n.metadata.shot = parsed
      }
      if (n.metadata.shot !== undefined) {
        const v = validateShotJson(n.metadata.shot)
        if (!v.ok) {
          return { error: `模板「${template?.name ?? templateId ?? "custom"}」节点 ${n.role}(${n.title}) 的 shot JSON 无效：${"error" in v ? v.error : "unknown"}` }
        }
        const params = shotOutputParams(v.shot)
        if (params.duration_seconds !== undefined && typeof n.metadata.duration_seconds !== "number") n.metadata.duration_seconds = params.duration_seconds
        if (params.aspect_ratio && typeof n.metadata.size !== "string") n.metadata.size = params.aspect_ratio
      }
    }
    // R8（2026-09-10 duration 對齊）：同鏈 config（shotN → shotN_gen）缺
    // duration_seconds 時，從上游 shotN text 節點的 shot JSON / duration_seconds
    // 回寫——agent 傳 10s 就 10s，別回 5s。舊版 config 寫死 duration_seconds: 5
    // 蓋住 agent 計劃時長（模板 defaults 已同步拔除），此處補齊回寫鏈。
    for (const c of graph.connections) {
      const fromNode = graph.nodes.find((n) => n.id === c.from)
      const toNode = graph.nodes.find((n) => n.id === c.to)
      if (!fromNode || !toNode) continue
      if (fromNode.kind !== "text" || toNode.kind !== "config") continue
      if (toNode.metadata.kind !== "video") continue
      if (typeof toNode.metadata.duration_seconds === "number" && toNode.metadata.duration_seconds > 0) continue
      const shotSecs = fromNode.metadata.duration_seconds
      if (typeof shotSecs === "number" && shotSecs > 0) toNode.metadata.duration_seconds = shotSecs
    }
    const nodeStatus: ActiveWorkflow["nodeStatus"] = {}
    const nodeContent: Record<string, string> = {}
    const nodeCost: Record<string, number> = {}
    for (const n of graph.nodes) {
      nodeStatus[n.id] = n.kind === "text" || n.kind === "config" ? "success" : "pending"
      if (typeof n.metadata.content === "string" && n.metadata.content) nodeContent[n.id] = n.metadata.content
    }
    const wf: ActiveWorkflow = {
      workflowId,
      templateId: templateId ?? "custom",
      graph,
      status: "building",
      nodeStatus,
      nodeContent,
      nodeCost,
      owner,
      planEmitted: false,
      emittedNodes: new Set(),
      emittedConnections: new Set(),
    }
    this.workflows.set(workflowId, wf)
    this.dirty(wf) // 建立即持久化：重启后 workflow/status 仍可恢复
    // 流式搭建：start 成功即把展开的节点流推上画布（模板路径一次可见整副骨架），
    // 之后 agent 的 add_node / connect 逐颗增量长出来——不等 workflow_generate。
    this.emitGraph(wf)
    return { workflowId }
  }

  get(workflowId: string): ActiveWorkflow | undefined {
    return this.workflows.get(workflowId)
  }

  addNode(workflowId: string, role: string, kind: string, title: string, metadata: Record<string, unknown> = {}): { nodeId: string } | { error: string } {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { error: "workflow not found" }
    if (kind === "text" && !metadata.content && !metadata.prompt && metadata.shot === undefined) {
      return { error: "text 节点必须填 content（提示词内容）或 shot（结构化 JSON），请补上再呼叫 workflow_add_node" }
    }
    // shot JSON：任何 kind 都可带 metadata.shot；text 节点 content 是 shot JSON 字串时也解析存回。
    if (metadata.shot === undefined && kind === "text" && typeof metadata.content === "string") {
      const parsed = parseShotCandidate(metadata.content)
      if (parsed) metadata.shot = parsed
    }
    if (metadata.shot !== undefined) {
      const v = validateShotJson(metadata.shot)
      if (!v.ok) {
        return {
          error:
            `shot JSON 无效：${"error" in v ? v.error : "unknown"}` +
            "。schema：{ subject, action, appearance, camera:{shot_type,angle,movement,lens}, environment:{time_of_day,lighting,elements}, style:{look,mood,color_grading}, audio:{dialogue:[{character,tone,line}],ambience,sfx}, output:{duration_seconds,aspect_ratio} }",
        }
      }
      const params = shotOutputParams(v.shot)
      if (params.duration_seconds !== undefined && typeof metadata.duration_seconds !== "number") metadata.duration_seconds = params.duration_seconds
      if (params.aspect_ratio && typeof metadata.size !== "string") metadata.size = params.aspect_ratio
    }
    const node: WorkflowNode = { id: `${workflowId}-${role}-${wf.graph.nodes.length}`, role, kind: kind as WorkflowNode["kind"], title, metadata }
    wf.graph.nodes.push(node)
    wf.nodeStatus[node.id] = node.kind === "text" || node.kind === "config" ? "success" : "pending"
    if (typeof metadata.content === "string" && metadata.content) wf.nodeContent[node.id] = metadata.content
    // 流式搭建：新节点即时上画布（emitNodeDelta 按 id 去重，幂等）。
    this.emitNodeDelta(wf, node)
    this.dirty(wf) // 节点流变更持久化
    return { nodeId: node.id }
  }

  connect(workflowId: string, from: string, to: string): { ok: boolean } | { error: string } {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { error: "workflow not found" }
    if (!wf.graph.nodes.some((n) => n.id === from) || !wf.graph.nodes.some((n) => n.id === to)) return { error: "node not found" }
    if (!wf.graph.connections.some((c) => c.from === from && c.to === to)) {
      wf.graph.connections.push({ from, to })
      // 流式搭建：新连线即时上画布。
      this.emitConnectionDelta(wf, { from, to })
      this.dirty(wf) // 连线变更持久化
    }
    return { ok: true }
  }

  updateNode(workflowId: string, nodeId: string, patch: Record<string, unknown>): { error: string } | { node: unknown; affected_node_ids: string[]; status: string } {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { error: "workflow not found" }
    const node = wf.graph.nodes.find((n: any) => n.id === nodeId)
    if (!node) return { error: "node not found" }

    // 允许更新的字段
    if (patch.title !== undefined) node.title = String(patch.title)
    // metadata 合并
    Object.assign(node.metadata, patch)

    // 素材注入（2026-08-30）：patch.content 为平台素材 URL 且节点可承载内容
    // （image/video/audio/film）时，直接写入 nodeContent 并标记 success——节点
    // 视为已完成，下游消费此内容，不触发重新生成（generate 的 R5-B 恢复语义
    // 天然沿用既有成果）。下方下游 stale 标记保留：注入新素材后下游本该重跑。
    // 不可承载 kind（text/config）行为照旧。
    const injectedContent = typeof patch.content === "string" ? patch.content.trim() : ""
    const contentInjectable = Boolean(injectedContent) && ["image", "video", "audio", "film"].includes(node.kind)
    if (contentInjectable) {
      wf.nodeContent[nodeId] = injectedContent
      wf.nodeStatus[nodeId] = "success"
    }

    // BFS 标记下游节点为 stale
    const affected: string[] = [nodeId]
    const queue = [nodeId]
    const visited = new Set<string>([nodeId])
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const conn of wf.graph.connections) {
        if (conn.from === current && !visited.has(conn.to)) {
          visited.add(conn.to)
          queue.push(conn.to)
          affected.push(conn.to)
          const downstream = wf.graph.nodes.find((n: any) => n.id === conn.to)
          if (downstream && downstream.kind !== "text" && downstream.kind !== "config") {
            wf.nodeStatus[conn.to] = "pending"
            delete wf.nodeContent[conn.to]
            delete wf.nodeCost[conn.to]
          }
        }
      }
    }

    // 发射 canvas.node.updated（素材注入时 patch 带上 content 与 status: "success"）
    this.opts.emit(wf.owner, "canvas.node.updated", {
      node_id: nodeId,
      workflow_id: workflowId,
      patch: { ...patch, ...(contentInjectable ? { content: injectedContent, status: "success" } : {}) },
    })
    this.dirty(wf)
    return { node, affected_node_ids: affected, status: "pending" }
  }

  removeConnection(workflowId: string, from: string, to: string): { error: string } | { ok: true } {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { error: "workflow not found" }
    const idx = wf.graph.connections.findIndex((c: any) => c.from === from && c.to === to)
    if (idx === -1) return { error: "connection not found" }
    wf.graph.connections.splice(idx, 1)

    // 断线事件：前端按 from/to 移除连线。同步从 emittedConnections 去掉该边，
    // 否则模型重新 connect 同一条边时 emitConnectionDelta 因去重不再补发。
    wf.emittedConnections.delete(`${from}->${to}`)
    this.opts.emit(wf.owner, "canvas.node.disconnected", { unit_id: wf.workflowId, from, to })
    this.dirty(wf)
    return { ok: true }
  }

  /** 执行工作流。emit canvas 事件；text/config 节点视为完成，image/video 调 runNode。 */
  async generate(workflowId: string): Promise<{ ok: boolean; status: string }> {
    // F1（2026-08-31）重入守衛：同一工作流已有執行循環在跑時拒絕二次 generate，
    // 防「自動續跑 + 手動 rerun / 重複 start」並發雙跑雙扣費。finally 保證清理。
    if (this.generateLoops.has(workflowId)) return { ok: false, status: "already running" }
    this.generateLoops.add(workflowId)
    try {
      return await this.generateInner(workflowId)
    } finally {
      this.generateLoops.delete(workflowId)
    }
  }

  private async generateInner(workflowId: string): Promise<{ ok: boolean; status: string }> {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { ok: false, status: "workflow not found" }
    // R5-B：餘額預檢在置 running 之前——拒絕開工時工作流狀態不動、一幣不燒。
    const budgetBlocked = await this.preflightBudget(wf)
    if (budgetBlocked) return { ok: false, status: budgetBlocked }
    wf.status = "running"

    // topo 排序；有循环 → 报错
    const { order, cycle } = topologicalSort(wf.graph)
    if (cycle.length) {
      wf.status = "failed"
      return { ok: false, status: `cycle: ${cycle.join(",")}` }
    }

    // 增量补发：start/add/connect 已即时推送过的不再重发（前端 upsert 幂等，
    // 但重发会打乱节点序与进场动画）；只补漏网（如事件丢失后的兜底）。
    this.emitGraph(wf)

    // 防假阳性（2026-08-21 测试轮实录）：模型可能把生成节点建成 config 类型，
    // 引擎逐节点跳过后仍回 success——前端显示「跑完了」实际什么都没发生。
    // 全工作流没有任何可执行节点时必须显式报错，把正确的 kind 语义告诉模型。
    const executableCount = order.filter((id) => {
      const node = wf.graph.nodes.find((n) => n.id === id)
      return node && node.kind !== "text" && node.kind !== "config"
    }).length
    if (executableCount === 0) {
      wf.status = "failed"
      return {
        ok: false,
        status:
          "no executable nodes: every node is text/config, which the engine skips. " +
          "Nodes that should produce an image or video must be created with kind='image' or kind='video' " +
          "(config nodes are reference/data-only and never execute).",
      }
    }

    // 逐节点执行（同层并行：按依赖深度分批，同批节点互不依赖、Promise.all 同时飞行，
    // 批间串行——下游等上游；批内 generating/updated 事件仍按 order 原序发射，画布顺序稳定）
    const upstreamContent = new Map<string, string>()
    // R5-B：重入恢復語義——已 success 且有成果的節點直接沿用其產物，絕不重跑重置
    //（R5 23:07 實錄：重試整鏈把先前成功節點重置為 error，畫布倒退）。失敗/待跑節點照常執行。
    let reusedCount = 0
    for (const [id, content] of Object.entries(wf.nodeContent)) {
      if (wf.nodeStatus[id] === "success" && content) {
        upstreamContent.set(id, content)
        reusedCount += 1
      }
    }
    if (reusedCount > 0) console.log(`[workflow] ${workflowId} resume: reusing ${reusedCount} succeeded node result(s), only failed/pending nodes will run`)
    const batches = splitIntoBatches(order, wf.graph)
    for (const batch of batches) {
      const executableIds: string[] = []
      for (const nodeId of batch) {
        const node = wf.graph.nodes.find((n) => n.id === nodeId)
        if (!node) continue
        if (node.kind === "text" || node.kind === "config") continue // audio/film 不跳过：执行由 runNode 诚实回报上游可用性
        if (wf.nodeStatus[nodeId] === "success" && wf.nodeContent[nodeId]) continue // R5-B 恢復語義：沿用既有成果，不重跑成功節點
        executableIds.push(nodeId)
      }
      if (!executableIds.length) continue
      // R9 中途閘：批間重查餘額（詳見 midBatchBudgetGate 註）。
      const pausedReason = await this.midBatchBudgetGate(wf)
      if (pausedReason) {
        wf.status = "paused_insufficient_quota"
        this.dirty(wf)
        return { ok: false, status: pausedReason }
      }
      for (const nodeId of executableIds) {
        wf.nodeStatus[nodeId] = "running"
        this.dirty(wf) // running 落盘：重启后该节点被标 error（服务重启中断），不伪造还在跑
        this.opts.emit(wf.owner, "canvas.node.generating", { unit_id: workflowId, node_id: nodeId, status: "running" })
      }
      // 批内节点只读自己上游（前批已写入）的结果，批内互不依赖 → 并发安全；成功结果批末统一写入供下游批参考
      const results = await Promise.all(
        executableIds.map((nodeId) => {
          const node = wf.graph.nodes.find((n) => n.id === nodeId)!
          return this.runNodeWithRetry(node, upstreamContent, wf.graph).then((result) => ({ nodeId, result }))
        }),
      )
      for (const { nodeId, result } of results) {
        if (result.ok && result.content) {
          wf.nodeStatus[nodeId] = "success"
          wf.nodeContent[nodeId] = result.content
          if (result.costCoins) wf.nodeCost[nodeId] = result.costCoins
          upstreamContent.set(nodeId, result.content)
          this.dirty(wf) // 节点成功 + 结果落盘
          this.opts.emit(wf.owner, "canvas.node.updated", {
            unit_id: workflowId,
            node_id: nodeId,
            patch: { status: "success", content: result.content, ...((result as { message?: string }).message ? { message: (result as { message?: string }).message } : {}), ...(result.costCoins ? { cost_coins: result.costCoins } : {}) },
            url: result.content,
            cost_coins: result.costCoins,
          })
        } else {
          wf.nodeStatus[nodeId] = "error"
          this.dirty(wf) // 节点失败落盘
          console.log(`[workflow] ${workflowId} node ${nodeId} failed: ${String(result.error ?? "").slice(0, 160)} — continuing downstream batches (skip-failed, partial semantics)`)
          this.opts.emit(wf.owner, "canvas.node.updated", {
            unit_id: workflowId,
            node_id: nodeId,
            patch: { status: "error", errorDetails: result.error, ...((result as { lastAttempt?: Record<string, unknown> }).lastAttempt ? { last_attempt: (result as { lastAttempt?: Record<string, unknown> }).lastAttempt } : {}), ...(this.opts.humanize ? { human_message: this.opts.humanize(result.error ?? "") } : {}) },
          })
        }
      }
      // R5-B：節點失敗不再中斷後續批——下游節點照跑（跳過失敗節點繼續下游），
      // 下游能否成功由其餘上游/自身條件決定；終態由可執行節點統計判定（partial 語義）。
    }

    // R5-B：三態終判——無 error = success；有 error 有 success = partial（成功成果保留）；
    // 全 error = failed。統計只看可執行節點（text/config 恆 success，不參與判定）。
    // R10（2026-08-31）：此三態只判定 execution 維度（節點是否跑完），不代表交付完整性
    //（宣告4鏡頭只跑成1鏡頭時，此處仍會是 success——delivery 維度的完整性檢查見 status() 的
    // delivery 陣列，兩個維度刻意分離，不在此處混入）。
    const executableNodes = wf.graph.nodes.filter((n) => n.kind !== "text" && n.kind !== "config")
    const okCount = executableNodes.filter((n) => wf.nodeStatus[n.id] === "success").length
    const errCount = executableNodes.filter((n) => wf.nodeStatus[n.id] === "error").length
    wf.status = errCount === 0 ? "success" : okCount === 0 ? "failed" : "partial"
    console.log(`[workflow] ${workflowId} finished: status=${wf.status} success=${okCount} error=${errCount} (of ${executableNodes.length} executable)`)
    this.dirty(wf) // 终态落盘
    return { ok: wf.status !== "failed", status: wf.status }
  }

  status(workflowId: string) {
    const wf = this.workflows.get(workflowId)
    if (!wf) return null
    // R10（2026-08-31）交付誠實：final_cut（film 節點）存在時，統計其上游 video
    // 節點的宣告數 vs 實際成功數，暴露「execution success 但 delivery 不完整」
    // 這類假成功（本次事故：宣告4鏡頭實得1鏡頭，status 仍回 success）。不改變既有
    // status 三態語義（execution 維度），只新增只讀統計，向後兼容。
    const filmNodes = wf.graph.nodes.filter((n) => n.kind === "film")
    const delivery = filmNodes.map((filmNode) => {
      const upstreamVideoIds = wf.graph.connections.filter((c) => c.to === filmNode.id).map((c) => c.from)
      const upstreamVideoNodes = wf.graph.nodes.filter((n) => upstreamVideoIds.includes(n.id) && n.kind === "video")
      const expectedShots = upstreamVideoNodes.length
      const actualShots = upstreamVideoNodes.filter((n) => wf.nodeStatus[n.id] === "success").length
      const expectedDuration = upstreamVideoNodes.reduce((sum, n) => {
        const d = n.metadata.duration_seconds
        return sum + (typeof d === "number" && d > 0 ? d : 0)
      }, 0)
      return {
        film_node_id: filmNode.id,
        expected_shots: expectedShots,
        actual_shots: actualShots,
        expected_duration_seconds: expectedDuration,
        film_status: wf.nodeStatus[filmNode.id],
        delivery_complete: actualShots === expectedShots && wf.nodeStatus[filmNode.id] === "success",
      }
    })
    return {
      workflowId: wf.workflowId,
      templateId: wf.templateId,
      status: wf.status,
      nodes: wf.graph.nodes.map((n) => ({
        id: n.id,
        role: n.role,
        kind: n.kind,
        title: n.title,
        status: wf.nodeStatus[n.id],
        content: wf.nodeContent[n.id],
        costCoins: wf.nodeCost[n.id],
      })),
      connections: wf.graph.connections,
      ...(delivery.length ? { delivery } : {}),
    }
  }

  /** 单节点增量上画布：按 node id 去重，重复呼叫幂等（generate 兜底重发安全）。 */
  private emitNodeDelta(wf: ActiveWorkflow, node: WorkflowNode): void {
    if (wf.emittedNodes.has(node.id)) return
    wf.emittedNodes.add(node.id)
    // 泳道座標：81 节点重算是微秒级，幂等安全（也可在 emitGraph 算一次传入，取简单）。
    const pos = computeSwimlanePositions(wf.graph.nodes, wf.graph.connections).get(node.id) ?? { x: 0, y: 0 }
    // 衍生卡（pipelineCard tool/note/gate 或 role 含 __）用小尺寸；主節點尺寸對齊 SWIM_CARD_W=300，徹底防止第 0 列與第 1 列卡片水平重疊（440 擠佔 360）。
    const isDerived =
      (typeof node.metadata.pipelineCard === "string" && ["tool", "note", "gate"].includes(node.metadata.pipelineCard as string)) ||
      node.role.includes("__")
    const size = isDerived ? { width: 300, height: 150 } : { width: 300, height: 220 }
    this.opts.emit(wf.owner, "canvas.node.created", {
      unit_id: wf.workflowId,
      node: { id: node.id, type: node.kind, title: node.title, position: pos, moved: true, ...size, metadata: node.metadata },
    })
  }

  /** 单连线增量上画布：按 from->to 边去重（id 由 workflowId+边派生，天然稳定）。 */
  private emitConnectionDelta(wf: ActiveWorkflow, c: { from: string; to: string }): void {
    const key = `${c.from}->${c.to}`
    if (wf.emittedConnections.has(key)) return
    wf.emittedConnections.add(key)
    this.opts.emit(wf.owner, "canvas.node.connected", { unit_id: wf.workflowId, connection: { id: `wf-${wf.workflowId}-${c.from}-${c.to}`, fromNodeId: c.from, toNodeId: c.to } })
  }

  /** emit 节点流增量（plan 只发一次；节点/连线只补没发过的）。start 即时调用＝流式搭建；generate 再调用＝漏网兜底。 */
  private emitGraph(wf: ActiveWorkflow): void {
    if (!wf.planEmitted) {
      wf.planEmitted = true
      // S4 规格2（2026-08-27）：cost_hint 从 null 改为真实估算（币）。
      // R5-D2（2026-08-29 價目表糾偏）：估算鏈全走本地錨點（與 /pricing 同源）——
      // image = unit_price_coins（pixai 系 0.001 幣/張）/ video = 檔位秒價 × 秒
      //（MiniMax H3：720P 5 幣/秒、1080P 10 幣/秒，預設時長 5s）；0.05 幣/秒舊
      // 口徑與目錄 0.25 髒價已廢。取不到錨點保持 null（不許編數）。
      let costHint: number | null = null
      try {
        // R5-D2：本地錨點優先；目錄僅在純圖且無本地錨點時回落（video 圖禁回落）。
        costHint = this.estimateTotalCoins(wf.graph)
      } catch {
        costHint = null // 估价故障不挡工作流搭建
      }
      this.opts.emit(wf.owner, "canvas.plan", { unit_id: wf.workflowId, tool: `workflow:${wf.templateId}`, label: `工作流 ${wf.templateId}`, prompt: "", model: "", size: "", count: 1, kind: "workflow", source_image: null, cost_hint: costHint })
    }
    for (const n of wf.graph.nodes) this.emitNodeDelta(wf, n)
    for (const c of wf.graph.connections) this.emitConnectionDelta(wf, c)
  }

  /**
   * S3（2026-08-27）：重跑指定节点及其全部下游节点。
   * 与 generate 的差异：①只执行 downstream 闭包（root 沿连线 BFS 可达的节点）；
   * ②未受影响节点的既有内容预填进 upstreamContent 当参考（重跑角色图时，
   * 不相干的场景图不必重生成）；③受影响节点先重置 pending、清掉旧结果。
   * 执行/事件/落盘语义与 generate 完全一致（emitGraph 幂等兜底、逐节点 dirty）。
   */
  async rerun(workflowId: string, rootNodeId: string): Promise<{ ok: boolean; status: string }> {
    const wf = this.workflows.get(workflowId)
    if (!wf) return { ok: false, status: "workflow not found" }
    const root = wf.graph.nodes.find((n) => n.id === rootNodeId)
    if (!root) return { ok: false, status: "node not found" }
    if (root.kind === "text" || root.kind === "config") {
      return { ok: false, status: "text/config 节点是参考资料，无需重跑" }
    }

    // downstream 闭包：root + 沿连线可达的全部节点（BFS 至不变）
    const affected = new Set<string>([rootNodeId])
    for (let changed = true; changed; ) {
      changed = false
      for (const c of wf.graph.connections) {
        if (affected.has(c.from) && !affected.has(c.to) && wf.graph.nodes.some((n) => n.id === c.to)) {
          affected.add(c.to)
          changed = true
        }
      }
    }

    wf.status = "running"
    const { order, cycle } = topologicalSort(wf.graph)
    if (cycle.length) {
      wf.status = "failed"
      return { ok: false, status: `cycle: ${cycle.join(",")}` }
    }
    this.emitGraph(wf) // 幂等兜底（重启后补发漏网节点）

    // 未受影响节点的既有内容 → upstream 参考；受影响可执行节点重置 pending
    const upstreamContent = new Map<string, string>()
    for (const [id, content] of Object.entries(wf.nodeContent)) {
      if (!affected.has(id) && content) upstreamContent.set(id, content)
    }
    for (const id of affected) {
      const n = wf.graph.nodes.find((x) => x.id === id)
      if (!n || n.kind === "text" || n.kind === "config") continue
      wf.nodeStatus[id] = "pending"
      delete wf.nodeContent[id]
      delete wf.nodeCost[id]
    }
    this.dirty(wf)

    // 逐节点执行（只跑受影响者；顺序仍按全域 topo，保证上游先完成；同层并行语义与 generate 一致）
    const batches = splitIntoBatches(order, wf.graph)
    for (const batch of batches) {
      const executableIds: string[] = []
      for (const nodeId of batch) {
        if (!affected.has(nodeId)) continue
        const node = wf.graph.nodes.find((n) => n.id === nodeId)
        if (!node) continue
        if (node.kind === "text" || node.kind === "config") continue
        executableIds.push(nodeId)
      }
      if (!executableIds.length) continue
      for (const nodeId of executableIds) {
        wf.nodeStatus[nodeId] = "running"
        this.dirty(wf)
        this.opts.emit(wf.owner, "canvas.node.generating", { unit_id: workflowId, node_id: nodeId, status: "running" })
      }
      const results = await Promise.all(
        executableIds.map((nodeId) => {
          const node = wf.graph.nodes.find((n) => n.id === nodeId)!
          return this.runNodeWithRetry(node, upstreamContent, wf.graph).then((result) => ({ nodeId, result }))
        }),
      )
      for (const { nodeId, result } of results) {
        if (result.ok && result.content) {
          wf.nodeStatus[nodeId] = "success"
          wf.nodeContent[nodeId] = result.content
          if (result.costCoins) wf.nodeCost[nodeId] = result.costCoins
          upstreamContent.set(nodeId, result.content)
          this.dirty(wf)
          this.opts.emit(wf.owner, "canvas.node.updated", {
            unit_id: workflowId,
            node_id: nodeId,
            patch: { status: "success", content: result.content, ...((result as { message?: string }).message ? { message: (result as { message?: string }).message } : {}), ...(result.costCoins ? { cost_coins: result.costCoins } : {}) },
            url: result.content,
            cost_coins: result.costCoins,
          })
        } else {
          wf.nodeStatus[nodeId] = "error"
          this.dirty(wf)
          console.log(`[workflow] rerun ${workflowId} node ${nodeId} failed: ${String(result.error ?? "").slice(0, 160)} — continuing downstream (skip-failed, partial semantics)`)
          this.opts.emit(wf.owner, "canvas.node.updated", {
            unit_id: workflowId,
            node_id: nodeId,
            patch: { status: "error", errorDetails: result.error, ...((result as { lastAttempt?: Record<string, unknown> }).lastAttempt ? { last_attempt: (result as { lastAttempt?: Record<string, unknown> }).lastAttempt } : {}), ...(this.opts.humanize ? { human_message: this.opts.humanize(result.error ?? "") } : {}) },
          })
        }
      }
      // R5-B：同 generate——節點失敗不中斷後續批（partial 語義）
    }

    // R5-B：三態終判（與 generate 同口徑）——partial 時成功節點成果原樣保留
    const executableNodes = wf.graph.nodes.filter((n) => n.kind !== "text" && n.kind !== "config")
    const okCount = executableNodes.filter((n) => wf.nodeStatus[n.id] === "success").length
    const errCount = executableNodes.filter((n) => wf.nodeStatus[n.id] === "error").length
    wf.status = errCount === 0 ? "success" : okCount === 0 ? "failed" : "partial"
    console.log(`[workflow] rerun ${workflowId} finished: status=${wf.status} success=${okCount} error=${errCount} (of ${executableNodes.length} executable)`)
    this.dirty(wf)
    return { ok: wf.status !== "failed", status: wf.status }
  }
}

// ── 泳道座標（2026-09-21 分層重排）─────────────────────────────────────────
// 舊版「每主節點獨佔一行、衍生卡向右排」會讓主鏈長距離跳線（feature_film 的
// script→shot1 跨 10 行、char_view1→shot1_gen 跨 8 行）縱貫切穿整列卡片。
// 新版改 DAG 分層：主鏈按最長路徑深度分欄（欄間距＝一跳），欄內 barycenter
// 排序壓交叉；每個工序的衍生卡（工具/配方/門禁）垂直掛在該工序正下方，
// 行內串聯線走乾淨垂直脊柱。所有主鏈連線＝相鄰欄位短跳線，零長距離貫穿。
const SWIM_CARD_W = 300 // 与前端 CARD_W 同值
const SWIM_MAIN_H = 220 // 主節點高
const SWIM_GAP_X = 80 // 欄間距（一跳連線的呼吸空間）
const SWIM_DERIVED_H = 150 // 衍生卡高
const SWIM_DERIVED_GAP = 24 // 衍生卡間距
const SWIM_BLOCK_GAP_Y = 60 // 同欄相鄰工序塊的間距

const isDerivedRole = (role: string) => /__tool_\d+$/.test(role) || /__note_\d+$/.test(role) || /__gate$/.test(role)

// 导出供 E2E 断言用（2026-09-20 Route A 验收；09-21 簽名加 connections 參數）。
export function computeSwimlanePositions(
  nodes: { id: string; role: string }[],
  connections: { from: string; to: string }[] = [],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const conns = (Array.isArray(connections) ? connections : []).filter(
    (c) => byId.has(c.from) && byId.has(c.to),
  )

  const mains = nodes.filter((n) => !isDerivedRole(n.role))

  // 衍生卡按 role 前綴歸到父工序（nodes 陣列序＝tools→notes→gate 的鋪卡序）
  const derivedByParent = new Map<string, { id: string }[]>()
  const mainByRole = new Map(mains.map((n) => [n.role, n]))
  for (const n of nodes) {
    if (!isDerivedRole(n.role)) continue
    const parentRole = n.role.slice(0, n.role.lastIndexOf("__"))
    if (!mainByRole.has(parentRole)) continue
    const list = derivedByParent.get(parentRole) ?? []
    list.push(n)
    derivedByParent.set(parentRole, list)
  }

  // 最長路徑分層（只看主鏈連線；衍生卡不在 depth 表裡，自動被排除）
  const depth = new Map<string, number>()
  for (const n of mains) depth.set(n.id, 0)
  for (let iter = 0; iter < mains.length; iter++) {
    let changed = false
    for (const c of conns) {
      const fd = depth.get(c.from)
      if (fd === undefined) continue
      const nd = fd + 1
      if (nd > (depth.get(c.to) ?? 0)) {
        depth.set(c.to, nd)
        changed = true
      }
    }
    if (!changed) break
  }

  const maxDepth = Math.max(0, ...mains.map((n) => depth.get(n.id) ?? 0))
  const columns: { id: string; role: string }[][] = Array.from({ length: maxDepth + 1 }, () => [])
  for (const n of mains) columns[depth.get(n.id) ?? 0].push(n)

  // barycenter：向左欄看齊排序，壓低跨欄連線交叉（無上游者保持原序）
  const upstreamOf = new Map<string, string[]>()
  for (const c of conns) {
    if (depth.has(c.from) && depth.has(c.to)) {
      upstreamOf.set(c.to, [...(upstreamOf.get(c.to) ?? []), c.from])
    }
  }
  for (let d = 1; d < columns.length; d++) {
    const refIndex = new Map(columns[d - 1].map((n, i) => [n.id, i]))
    const scored = columns[d].map((n, i) => {
      const ups = (upstreamOf.get(n.id) ?? [])
        .map((id) => refIndex.get(id))
        .filter((v): v is number => v !== undefined)
      return { n, i, bary: ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : i }
    })
    scored.sort((a, b) => a.bary - b.bary || a.i - b.i)
    columns[d] = scored.map((s) => s.n)
  }

  // 座標：欄 x 按深度推進；欄內工序塊（主節點＋下方衍生脊柱）垂直堆疊
  const blockH = (role: string) => {
    const derived = derivedByParent.get(role) ?? []
    return derived.length
      ? SWIM_MAIN_H + SWIM_DERIVED_GAP + derived.length * (SWIM_DERIVED_H + SWIM_DERIVED_GAP)
      : SWIM_MAIN_H
  }
  for (let d = 0; d < columns.length; d++) {
    let y = 0
    for (const n of columns[d]) {
      positions.set(n.id, { x: d * (SWIM_CARD_W + SWIM_GAP_X), y })
      let cy = y + SWIM_MAIN_H + SWIM_DERIVED_GAP
      for (const dc of derivedByParent.get(n.role) ?? []) {
        positions.set(dc.id, { x: d * (SWIM_CARD_W + SWIM_GAP_X), y: cy })
        cy += SWIM_DERIVED_H + SWIM_DERIVED_GAP
      }
      y += blockH(n.role) + SWIM_BLOCK_GAP_Y
    }
  }
  return positions
}
