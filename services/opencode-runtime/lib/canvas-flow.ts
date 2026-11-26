// 画布 Agent 操作的共用辅助（Wave C）：
// - compactCanvasState：canvas_get_state 回传前压缩（截断长文本，只留骨架栏位）
// - compileGenerationFlow：canvas_create_generation_flow / canvas_generate_image
//   的 ops 编译器（文本节点 + 配置节点 + 连线 + 选中 + 可选 run_generation）
// - gatewayReadSnapshot / gatewayDispatchOps：对 gateway loopback 端点的薄封装
// 此档不是 tool，不得 export tool 定义，必须放在 tools/ 之外（见 client.ts 顶部说明）。

const TRUNCATE_AT = 240
const TRUNCATE_KEEP = 120

/** 超过 240 字的字串截为前 120 字 + …（给模型看的摘要，不动画布本体）。 */
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
  /**
   * 人机共笔读面（2026-10-03）：前端从**全量** reducer state 反推的
   * `WorkflowDslSource[]`（图＝声明的可逆表达）。agent 靠它「像改代码一样」读回自己
   * 铺的产线；本层只透传、不重算（重算会用到被压缩掉的 workflow_ns/stepId）。
   */
  dsl?: unknown[]
  /** 节点版本索引（node_id/title/versions[]）：agent 读版本并经 revert_node 回退。 */
  node_versions?: unknown[]
}

/** 压缩快照：每节点只留 id/type/title/position/width/height/metadata 摘要。 */
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
    // 读面透传（2026-10-03）：dsl/node_versions 原样带过（不截断——它们已是紧凑形态，
    // dsl 是 agent 改图的唯一输入，截断＝把可逆声明变残档）。
    ...(Array.isArray(s.dsl) ? { dsl: s.dsl } : {}),
    ...(Array.isArray(s.node_versions) ? { node_versions: s.node_versions } : {}),
  }
}

// ---------------------------------------------------------------------------
// 生成流编译
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

/** 从快照算新节点起点：最右节点右缘 + 120；无快照/无节点 = (40, 40)。 */
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

/** prompt 摘要当节点标题（量级对齐 gateway summarizeCanvasTitle）。 */
function flowTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim()
  return clean.length > 18 ? clean.slice(0, 18) + "…" : clean || "提示词"
}

/**
 * 把生成需求编译成画布 ops（节点形状对齐 gateway autoCreateCanvasUnit 与前端
 * CanvasAgentOp 契约）：
 *   ① add_node 文本节点（content=prompt，位置 = nextFlowOrigin）
 *   ② add_node 配置节点（其右 +460，metadata: prompt/model/size/count）
 *   ③ connect 文本→配置 + 每个 reference→配置
 *   ④ select_nodes 配置
 *   ⑤ auto_run 时 run_generation{node_id: 配置id, prompt, model, size, count}
 */
export function compileGenerationFlow(input: GenerationFlowInput, snapshotState: unknown): CompiledGenerationFlow {
  const stamp = Date.now().toString(36)
  const textId = `agent-${stamp}-t`
  const configId = `agent-${stamp}-c`
  const model = typeof input.model === "string" && input.model ? input.model : "gpt-image-2.5-flare"
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
// gateway loopback 封装
// ---------------------------------------------------------------------------

export interface SnapshotReadOutcome {
  has_state: boolean
  state: unknown
  updated_at: number | null
}

/** 读 gateway 暂存的画布快照。读不到（断线/无快照）回 has_state:false，不 throw。 */
export async function gatewayReadSnapshot(gateway: string, sessionID: string): Promise<SnapshotReadOutcome> {
  // 通道 B：前端 300ms 防抖 POST /canvas/state 的完整快照（canvas_get_state 主读这份）。
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
    // 快照仅用于感知/定位，读不到就当无快照
  }
  // 通道 A 回退：快照未上报（新会话快照推播延迟/失败）时，读随消息体上送的
  // canvasSummary（GET /internal/canvas/state）。两通道不同源——只喂了通道 A
  // 的客户端不该被当成「画布尚未上报」。摘要节点无 position/width/height，
  // 定位用 nextFlowOrigin 的 40,40 兜底，但画布「有内容」这件事必须让 agent 看到。
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
    // 摘要也读不到：真正没有画布状态
  }
  return { has_state: false, state: null, updated_at: null }
}

export interface DispatchOutcome {
  ok: boolean
  status?: number
  request_id: string | null
  code?: string
  error?: string
  result?: { ok?: boolean; error?: string; created_node_ids?: string[]; queued?: boolean; queued_reason?: "no_client" | "ack_timeout" }
}

/** 下发 ops 到 gateway 并等前端回执（gateway 端最长 30s；本地 fetch 35s 兜底）。 */
export async function gatewayDispatchOps(
  gateway: string,
  sessionID: string,
  ops: unknown[],
  label?: string,
  deviation?: { deviate_from_template?: boolean; deviate_reason?: string; deviate_token?: string },
): Promise<DispatchOutcome> {
  try {
    const res = await fetch(`${gateway}/internal/canvas/dispatch-ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionID,
        ops,
        ...(label ? { label } : {}),
        ...(deviation?.deviate_from_template === true
          ? { deviate_from_template: true, deviate_reason: deviation.deviate_reason ?? "" }
          : {}),
        // 2026-10-02：网关签发的偏离 token——模型原样带回才放行。
        ...(typeof deviation?.deviate_token === "string" && deviation.deviate_token
          ? { deviate_token: deviation.deviate_token }
          : {}),
      }),
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
