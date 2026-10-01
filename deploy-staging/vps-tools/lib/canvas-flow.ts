// 畫布 Agent 操作的共用輔助（Wave C）：
// - compactCanvasState：canvas_get_state 回傳前壓縮（截斷長文本，只留骨架欄位）
// - compileGenerationFlow：canvas_create_generation_flow / canvas_generate_image
//   的 ops 編譯器（文本節點 + 配置節點 + 連線 + 選中 + 可選 run_generation）
// - gatewayReadSnapshot / gatewayDispatchOps：對 gateway loopback 端點的薄封裝
// 此檔不是 tool，不得 export tool 定義，必須放在 tools/ 之外（見 client.ts 頂部說明）。

const TRUNCATE_AT = 240
const TRUNCATE_KEEP = 120

/** 超過 240 字的字串截為前 120 字 + …（給模型看的摘要，不動畫布本體）。 */
export function truncateText(text: string): string {
  return text.length > TRUNCATE_AT ? text.slice(0, TRUNCATE_KEEP) + "…" : text
}

function compactMetadata(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? truncateText(v) : v
  }
  return out
}

export interface CompactNode {
  id: unknown
  type: unknown
  title: unknown
  position: unknown
  width: unknown
  height: unknown
  metadata?: Record<string, unknown>
}

export interface CompactCanvasState {
  nodes: CompactNode[]
  connections: unknown[]
  selected_node_ids: unknown[]
  viewport: unknown
}

/** 壓縮快照：每節點只留 id/type/title/position/width/height/metadata 摘要。 */
export function compactCanvasState(state: unknown): CompactCanvasState {
  const s = (state ?? {}) as Record<string, unknown>
  const rawNodes = Array.isArray(s.nodes) ? s.nodes : []
  const nodes: CompactNode[] = rawNodes.map((raw) => {
    const n = (raw ?? {}) as Record<string, unknown>
    const meta = compactMetadata(n.metadata)
    return {
      id: n.id,
      type: n.type,
      title: typeof n.title === "string" ? truncateText(n.title) : n.title,
      position: n.position,
      width: n.width,
      height: n.height,
      ...(meta ? { metadata: meta } : {}),
    }
  })
  return {
    nodes,
    connections: Array.isArray(s.connections) ? s.connections : [],
    selected_node_ids: Array.isArray(s.selectedNodeIds)
      ? s.selectedNodeIds
      : Array.isArray(s.selected_node_ids)
        ? (s.selected_node_ids as unknown[])
        : [],
    viewport: s.viewport ?? null,
  }
}

// ---------------------------------------------------------------------------
// 生成流編譯
// ---------------------------------------------------------------------------

export interface GenerationFlowInput {
  prompt: string
  model?: string
  size?: string
  count?: number
  reference_node_ids?: string[]
  auto_run?: boolean
}

export interface CompiledGenerationFlow {
  ops: Record<string, unknown>[]
  text_node_id: string
  config_node_id: string
  model: string
  size: string
  count: number
}

/** 從快照算新節點起點：最右節點右緣 + 120；無快照/無節點 = (40, 40)。 */
export function nextFlowOrigin(state: unknown): { x: number; y: number } {
  const s = (state ?? {}) as Record<string, unknown>
  const nodes = Array.isArray(s.nodes) ? s.nodes : []
  let rightmost = -Infinity
  for (const raw of nodes) {
    const n = (raw ?? {}) as Record<string, unknown>
    const pos = (n.position ?? {}) as Record<string, unknown>
    const px = typeof pos.x === "number" && Number.isFinite(pos.x) ? pos.x : null
    if (px === null) continue
    const w = typeof n.width === "number" && Number.isFinite(n.width) ? n.width : 340
    rightmost = Math.max(rightmost, px + w)
  }
  if (!Number.isFinite(rightmost)) return { x: 40, y: 40 }
  return { x: rightmost + 120, y: 40 }
}

/** prompt 摘要當節點標題（量級對齊 gateway summarizeCanvasTitle）。 */
function flowTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim()
  return clean.length > 18 ? clean.slice(0, 18) + "…" : clean || "提示词"
}

/**
 * 把生成需求編譯成畫布 ops（節點形狀對齊 gateway autoCreateCanvasUnit 與前端
 * CanvasAgentOp 契約）：
 *   ① add_node 文本節點（content=prompt，位置 = nextFlowOrigin）
 *   ② add_node 配置節點（其右 +460，metadata: prompt/model/size/count）
 *   ③ connect 文本→配置 + 每個 reference→配置
 *   ④ select_nodes 配置
 *   ⑤ auto_run 時 run_generation{node_id: 配置id, prompt, model, size, count}
 */
export function compileGenerationFlow(input: GenerationFlowInput, snapshotState: unknown): CompiledGenerationFlow {
  const stamp = Date.now().toString(36)
  const textId = `agent-${stamp}-t`
  const configId = `agent-${stamp}-c`
  const model = typeof input.model === "string" && input.model ? input.model : "gpt-image-2"
  const size = typeof input.size === "string" && input.size ? input.size : "1024x1024"
  const rawCount = typeof input.count === "number" && Number.isFinite(input.count) ? Math.floor(input.count) : 1
  const count = Math.max(1, Math.min(4, rawCount))
  const origin = nextFlowOrigin(snapshotState)
  const references = Array.isArray(input.reference_node_ids)
    ? input.reference_node_ids.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 20)
    : []

  const ops: Record<string, unknown>[] = [
    {
      type: "add_node",
      node: {
        id: textId,
        type: "text",
        title: flowTitle(input.prompt),
        position: { x: origin.x, y: origin.y },
        width: 340,
        height: 240,
        metadata: { content: input.prompt, status: "idle" },
      },
    },
    {
      type: "add_node",
      node: {
        id: configId,
        type: "config",
        title: `${model} · ${size}`,
        position: { x: origin.x + 460, y: origin.y },
        width: 440,
        height: 240,
        metadata: { prompt: input.prompt, model, size, count, kind: "image", status: "idle" },
      },
    },
    {
      type: "connect_nodes",
      connections: [
        { fromNodeId: textId, toNodeId: configId },
        ...references.map((ref) => ({ fromNodeId: ref, toNodeId: configId })),
      ],
    },
    { type: "select_nodes", ids: [configId] },
  ]
  if (input.auto_run === true) {
    ops.push({ type: "run_generation", node_id: configId, prompt: input.prompt, model, size, count })
  }
  return { ops, text_node_id: textId, config_node_id: configId, model, size, count }
}

// ---------------------------------------------------------------------------
// gateway loopback 封裝
// ---------------------------------------------------------------------------

export interface SnapshotReadOutcome {
  has_state: boolean
  state: unknown
  updated_at: number | null
}

/** 讀 gateway 暫存的畫布快照。讀不到（斷線/無快照）回 has_state:false，不 throw。 */
export async function gatewayReadSnapshot(gateway: string, sessionID: string): Promise<SnapshotReadOutcome> {
  // 通道 B：前端 300ms 防抖 POST /canvas/state 的完整快照（canvas_get_state 主讀這份）。
  try {
    const res = await fetch(`${gateway}/internal/canvas/snapshot?session_id=${encodeURIComponent(sessionID)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok && data?.ok === true && data.has_state === true && data.state !== null) {
      return {
        has_state: true,
        state: data.state,
        updated_at: typeof data.updated_at === "number" ? data.updated_at : null,
      }
    }
  } catch {
    // 快照僅用於感知/定位，讀不到就當無快照
  }
  // 通道 A 回退：快照未上報（新會話快照推播延遲/失敗）時，讀隨消息體上送的
  // canvasSummary（GET /internal/canvas/state）。兩通道不同源——只餵了通道 A
  // 的客戶端不該被當成「畫布尚未上報」。摘要節點無 position/width/height，
  // 定位用 nextFlowOrigin 的 40,40 兜底，但畫布「有內容」這件事必須讓 agent 看到。
  try {
    const res = await fetch(`${gateway}/internal/canvas/state?session_id=${encodeURIComponent(sessionID)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.ok && data?.ok === true && data.canvas_state !== null && data.canvas_state !== undefined) {
      return {
        has_state: true,
        state: data.canvas_state,
        updated_at: typeof data.updated_at === "number" ? data.updated_at : null,
      }
    }
  } catch {
    // 摘要也讀不到：真正沒有畫布狀態
  }
  return { has_state: false, state: null, updated_at: null }
}

export interface DispatchOutcome {
  ok: boolean
  status?: number
  request_id: string | null
  code?: string
  error?: string
  result?: { ok?: boolean; error?: string; created_node_ids?: string[] }
}

/** 下發 ops 到 gateway 並等前端回執（gateway 端最長 30s；本地 fetch 35s 兜底）。 */
export async function gatewayDispatchOps(
  gateway: string,
  sessionID: string,
  ops: unknown[],
  label?: string,
): Promise<DispatchOutcome> {
  try {
    const res = await fetch(`${gateway}/internal/canvas/dispatch-ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionID, ops, ...(label ? { label } : {}) }),
      signal: AbortSignal.timeout(35_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const errRaw = data?.error as unknown
    const errMsg =
      typeof errRaw === "string"
        ? errRaw
        : errRaw && typeof errRaw === "object" && typeof (errRaw as { message?: unknown }).message === "string"
          ? ((errRaw as { message: string }).message)
          : undefined
    return {
      ok: data?.ok === true,
      status: res.status,
      request_id: typeof data?.request_id === "string" ? data.request_id : null,
      code: typeof data?.code === "string" ? data.code : undefined,
      error: errMsg,
      result: data?.result && typeof data.result === "object" ? (data.result as DispatchOutcome["result"]) : undefined,
    }
  } catch (e) {
    return { ok: false, request_id: null, error: (e as Error)?.message || String(e) }
  }
}
