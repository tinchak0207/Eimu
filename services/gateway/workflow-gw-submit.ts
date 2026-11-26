import { parseShotCandidate, compileShotPrompt, normalizeShotCamera, shotOutputParams, validateMotionContract, type ShotJson } from "./video-prompt-schema"
import { emitToSession } from "./sse-core.ts"
import { catalogVideoPerSecondCoins, resolveVideoSubmissionOptions, resolveNodeModel } from "./pricing-gateway.ts"
import { PLATFORM_BASE } from "./constants-gateway.ts"
import { VIDEO_FALLBACK_MODEL, pickVideoModel, rankVideoModels, videoDisqualifyReason, type ModelStatusEntryLike } from "./video-model-select.ts"
import { applyCanvasNodeUpdated } from "./canvas-cascade-state.ts"
import type { SessionState, TaskStatus } from "./types-gateway.ts"
import { hasEntityToken, resolveEntityTokens, sanitizeEntityReferences } from "./entity-resolve.ts"
import { workflowOwnerBySession, workflowJobs, workflowWake } from "./workflow-gw-state.ts"

/** H11 补完：workflow 路径生成任务登记进 state.sessionTasks（与聊天路径 attachCanvasTask 同表）。 */
export function registerWorkflowTask(
  state: { sessionTasks?: SessionState["sessionTasks"] },
  taskId: string,
  label: string,
  status: "queued" | "succeeded" | "failed",
  url?: string,
): void {
  try {
    if (!taskId) return
    if (!state.sessionTasks) state.sessionTasks = new Map()
    const prev = state.sessionTasks.get(taskId)
    state.sessionTasks.set(taskId, {
      task_id: taskId,
      label: prev?.label ?? label,
      status,
      submitted_at: prev?.submitted_at ?? Date.now(),
      ...(url ? { url } : prev?.url ? { url: prev.url } : {}),
    })
  } catch { /* 登记失败不得影响生成 */ }
}
// TODO(整合 Wave2): 以下为「仍住 index.ts 且未在 16 个 export 内」符号的 declare 占位（stage1 记忆 subagent 占位符法，bun build 不查名可过）。
// 整合阶段换成真 import（bun build 硬查 named import，已实锤）。注：CommandResult 是 index.ts 既有基线错误（tsc-baseline-0919 第 12–18 行 TS2304 ×7），如实不补宣告。
/**
 * H8（2026-10-02）：节点失败文案必须带 failure_class + 上游原文首句。
 * 旧文案把本地配置/解析错与上游错一律洗成「执行侧无可用供应商/上游渠道未能执行」，
 * orchestrator 据此对用户说「瓶颈不在我们这边」。现在 class 与原文原样外露，
 * 归因只准引用它们（见 AGENTS.md 4.8）。
 */
export function firstSentence(raw: unknown, max = 160): string {
  const t = String(raw ?? "").trim()
  if (!t) return ""
  const m = t.split(/[。！？!?\n]/)[0].trim()
  return (m || t).slice(0, max)
}
export function formatNodeFailure(failureClass: unknown, raw: unknown, lead: string, tail = ""): string {
  const cls = typeof failureClass === "string" && failureClass ? failureClass : "unknown"
  const first = firstSentence(raw)
  return `${lead} [failure_class=${cls}]${first ? `，原文：「${first}」` : "，原文：（无）"}${tail}`
}
/** 排队超过此时长提示并尝试换同价通道（PM 死线：5 分钟）。 */
export const QUEUE_SWITCH_MS = Number.parseInt(process.env.WORKFLOW_QUEUE_SWITCH_MS || "300000", 10) || 300_000

export function wfidFromNodeId(nodeId: string): string {
  const m = nodeId.match(/^(.+)-[^-]+-\d+$/)
  return m ? m[1] : ""
}
/** 取消控面 job（排队/租约中全额退款，已在飞的由控面 reconcile 兜底）。永不抛。 */
export async function cancelPlatformJob(apiKey: string, taskId: string): Promise<{ cancelled: boolean; note: string }> {
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/generation-jobs/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as { previous_status?: string; refund?: unknown }
    const note = `http=${res.status} previous=${body.previous_status ?? "-"} refund=${JSON.stringify(body.refund ?? null)}`
    console.log(`[gateway] cancel platform job ${taskId}: ${note}`)
    return { cancelled: res.ok, note }
  } catch (e) {
    console.error(`[gateway] cancel platform job ${taskId} failed:`, e)
    return { cancelled: false, note: String((e as Error)?.message ?? e) }
  }
}

/** 同价位（每秒币价逐档不高于当前）且活的备选视频通道；无则 null（明确降级＝继续排队至预算耗尽后取消退款）。 */
export async function pickSamePriceVideoAlternative(model: string, apiKey: string, node: CanvasNode): Promise<string | null> {
  try {
    const models = await fetchModelStatusCached(apiKey)
    if (!models) return null
    const tried = new Set<string>(Array.isArray(node.metadata?.__triedModels) ? (node.metadata!.__triedModels as string[]) : [])
    tried.add(model)
    const cur = await catalogVideoPerSecondCoins(model, apiKey)
    if (!cur) return null
    for (const cand of rankVideoModels(models as ModelStatusEntryLike[], tried)) {
      const p = await catalogVideoPerSecondCoins(cand.id, apiKey)
      if (!p) continue
      const keys = Object.keys(p).filter((k) => k in cur)
      if (keys.length && keys.every((k) => p[k] <= cur[k])) return cand.id
    }
  } catch (e) {
    console.error("[gateway] pickSamePriceVideoAlternative failed:", e)
  }
  return null
}
/** execute_command 工具回应形状（waveform.ts/master.ts 同款；stage2 整合时改共用汇出）。 */
export interface CommandResult { stdout: string; stderr: string; exit_code: number }

/** 画布节点的宽松形状（graph.nodes 是 unknown[]，消费端逐点收窄）。 */
type CanvasNode = { id?: unknown; kind?: unknown; metadata?: Record<string, unknown> }
/** 谓词收窄形状：graph.nodes 元素（id/role/kind/metadata）去除 undefined 的真子类型。 */
export type VideoUpstream = { id: string; role: string; kind: string; metadata: Record<string, unknown> }
export type AudioUpstream = VideoUpstream
type ImageUpstream = VideoUpstream

export type PersistableWorkflow = {
  workflowId: string
  templateId: string
  graph: { nodes: CanvasNode[]; connections: unknown[] }
  status: string
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
}

/** ActiveWorkflow → 可 JSON 化快照（Set 去重状态不持久——恢复后全部视为已发过，避免重启后重推前端）。 */
export function workflowSnapshotOf(wf: {
  workflowId: string
  templateId: string
  graph: { nodes: CanvasNode[]; connections: unknown[] }
  status: string
  nodeStatus: Record<string, string>
  nodeContent: Record<string, string>
  nodeCost: Record<string, number>
}): PersistableWorkflow {
  return {
    workflowId: wf.workflowId,
    templateId: wf.templateId,
    graph: { nodes: wf.graph.nodes, connections: wf.graph.connections },
    status: wf.status,
    nodeStatus: { ...wf.nodeStatus },
    nodeContent: { ...wf.nodeContent },
    nodeCost: { ...wf.nodeCost },
  }
}
/**
 * 提交单一节点生成：image → /v1/images/generations；video → /v1/videos/generations。
 * 非同步提交后轮询（202 → task_id → GET {id} → succeeded → result url）。
 * 回传 OpenAI 相容结果 {ok, content(url), costCoins?}。
 */
// INC-0830：沿连线找视频节点上游连接的视频 config 节点（kind=config 且 metadata.kind==="video"），
// 取其 duration_seconds——模板把时长配在 config 节点上，submit 时与 meta/shot 同为时长真源。
export function resolveConnectedVideoDuration(
  nodeId: string,
  graph?: { nodes: { id: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): number | undefined {
  if (!graph) return undefined
  const cfgIds = graph.connections.filter((c) => c.to === nodeId).map((c) => c.from)
  for (const cid of cfgIds) {
    const cfg = graph.nodes.find((n) => n.id === cid)
    if (cfg && cfg.kind === "config" && cfg.metadata.kind === "video") {
      const d = cfg.metadata.duration_seconds
      if (typeof d === "number" && d > 0) return d
    }
  }
  return undefined
}
// F2（2026-08-31）：model-status 15s TTL 快取——旧版每个节点提交前都重新打一次
// /v1/model-status，长 workflow 节点多时等于每节点多一次探测延迟+一次上游打扰。
export const MODEL_STATUS_TTL_MS = 15_000
export let modelStatusCache: { at: number; models: Array<Record<string, unknown>> } | null = null

export async function fetchModelStatusCached(apiKey: string): Promise<Array<Record<string, unknown>> | null> {
  const now = Date.now()
  if (modelStatusCache && now - modelStatusCache.at < MODEL_STATUS_TTL_MS) return modelStatusCache.models
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/model-status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    const data = await res.json().catch(() => null)
    const models = Array.isArray((data as { models?: unknown })?.models) ? ((data as { models: Array<Record<string, unknown>> }).models) : null
    if (models) {
      modelStatusCache = { at: now, models }
      return models
    }
  } catch {
    // 探测不可达：沿用旧快取（fail-open），完全没快取则回 null 由呼叫方决定
  }
  return modelStatusCache?.models ?? null
}

/** M4：近 24h 影片零交付判定（available>0 且 delivered>0 者为 0）。探测不可达回 null（fail-open）。 */
export async function videoZeroDelivery24h(apiKey: string): Promise<{ available: string[] } | null> {
  const models = await fetchModelStatusCached(apiKey)
  if (!models) return null
  const vids = (models as Array<{ id?: string; media_type?: string; availability?: string; last_24h?: { delivered?: unknown } }>).filter((m) => m.media_type === "video")
  const available = vids.filter((m) => m.availability === "available")
  if (available.length === 0) return null
  const proven = available.filter((m) => Number(m.last_24h?.delivered ?? 0) > 0)
  return proven.length === 0 ? { available: available.map((m) => String(m.id)) } : null
}
/**
 * F2（2026-08-31）路由单真源 + 强制跨 provider failover：原逻辑发现模型
 * unavailable 就直接报错要人手动换模型——这里改成主动在同 media_type、不同
 * channel_id 的候选里挑一个接著跑，找不到候选才诚实报错（不编造成功）。
 * node.metadata.__triedChannels 记录本节点已知死的渠道，跨重试/跨崩溃恢复
 * （随 workflow 快照持久化）都不会再选回去。
 */
export async function resolveActiveModel(
  model: string,
  kind: "image" | "video",
  apiKey: string,
  node: CanvasNode,
): Promise<{ model: string; switched: boolean; note?: string; exhausted?: boolean; error?: string }> {
  const models = await fetchModelStatusCached(apiKey)
  if (!models) return { model, switched: false } // 探测端不可达：fail-open，行为与旧版一致
  const entry = models.find((m) => (m as { id?: string }).id === model) as
    | { id: string; media_type?: string; availability?: string; channel_id?: string; note?: string; last_24h?: { success_rate?: number } }
    | undefined
  // 2026-10-02 MODEL-SELECT：视频不再只认 availability==="unavailable"——断路器 open、
  // 近 24h 足量单 0 交付也视为死模型，生成前换成 proven 最高者并留回执（node.metadata.model_swap）。
  if (kind === "video") {
    const reason = entry ? videoDisqualifyReason(entry as ModelStatusEntryLike) : "不在 model-status 目录（无可用路由证据）"
    if (!reason) return { model, switched: false }
    const triedModels = new Set<string>(Array.isArray(node.metadata.__triedModels) ? (node.metadata.__triedModels as string[]) : [])
    triedModels.add(model)
    const chosenV = pickVideoModel(models as ModelStatusEntryLike[], triedModels)
    node.metadata.__triedModels = [...triedModels]
    if (!chosenV) {
      return {
        model,
        switched: false,
        exhausted: true,
        error: formatNodeFailure(
          (entry as { failure_class?: unknown } | undefined)?.failure_class ?? "model_unavailable",
          typeof entry?.note === "string" ? entry.note : reason,
          `模型 ${model} 不可选（${reason}）`,
          "；且没有其他有真实交付证据的视频模型可自动切换。请稍后重试",
        ),
      }
    }
    const note = `[gateway] 视频模型自动替换：${model}（${reason}）→ ${chosenV.id}（${chosenV.proven ? "近 24h 有真实交付" : "无近期失败样本"}）`
    node.metadata.model_swap = { from: model, to: chosenV.id, reason, proven: chosenV.proven }
    return { model: chosenV.id, switched: true, note }
  }
  if (!entry || entry.availability !== "unavailable") return { model, switched: false }
  const tried = new Set<string>(Array.isArray(node.metadata.__triedChannels) ? (node.metadata.__triedChannels as string[]) : [])
  const currentChannel = typeof entry.channel_id === "string" ? entry.channel_id : undefined
  if (currentChannel) tried.add(currentChannel)
  const pool = (models as Array<{ id: string; media_type?: string; availability?: string; channel_id?: string; last_24h?: { success_rate?: number } }>)
    .filter((m) => m.media_type === kind && m.availability === "available")
    .filter((m) => !tried.has(typeof m.channel_id === "string" ? m.channel_id : `unknown:${m.id}`))
  if (pool.length === 0) {
    node.metadata.__triedChannels = [...tried]
    return {
      model,
      switched: false,
      exhausted: true,
      error: formatNodeFailure(
        (entry as { failure_class?: unknown }).failure_class ?? "model_unavailable",
        typeof entry.note === "string" ? entry.note : "渠道故障",
        `模型 ${model} 不可用`,
        "；且没有其他可用渠道可自动切换。请稍后重试或在画布上更换模型",
      ),
    }
  }
  pool.sort((a, b) => (b.last_24h?.success_rate ?? 0.5) - (a.last_24h?.success_rate ?? 0.5))
  const chosen = pool[0]
  tried.add(typeof chosen.channel_id === "string" ? chosen.channel_id : `unknown:${chosen.id}`)
  node.metadata.__triedChannels = [...tried]
  return {
    model: chosen.id,
    switched: true,
    note: `[gateway] F2 failover: ${model}(${currentChannel ?? "?"}) unavailable -> ${chosen.id}(${chosen.channel_id ?? "?"})`,
  }
}
export async function submitWorkflowNode(
  session: SessionState,
  node: CanvasNode & { id?: string },
  upstream: Map<string, string>,
  graph?: { nodes: { id: string; role: string; kind: string; metadata: Record<string, unknown> }[]; connections: { from: string; to: string }[] },
): Promise<{ nodeId: string; ok: boolean; content?: string; costCoins?: number; error?: string; lastAttempt?: Record<string, unknown> }> {
  const nodeId = (node as { id?: string }).id || ""
  if ((node.kind as string) === "director") {
    return { nodeId, ok: false, error: "预演节点不执行生图" }
  }
  if (!node.metadata) node.metadata = {}
  const meta = node.metadata

  // 解析 prompt：优先 node.metadata，其次沿上游连线 BFS 找第一个有内容的 text 节点
  // （大片模板：角色描述 text → 四视图 config → 各视图 image；image 的 prompt 继承自角色描述）
  function collectUpstreamPrompt(startId: string, depth = 0): string {
    if (depth > 4) return ""
    const direct = graph?.connections.filter((c) => c.to === startId).map((c) => graph.nodes.find((n) => n.id === c.from)).filter(Boolean)
    for (const n of direct ?? []) {
      const content = typeof n.metadata.content === "string" ? n.metadata.content : typeof n.metadata.prompt === "string" ? n.metadata.prompt : ""
      if (content.trim()) return content
    }
    for (const n of direct ?? []) {
      const found = collectUpstreamPrompt(n.id, depth + 1)
      if (found) return found
    }
    return ""
  }
  // prompt 解析移到 model/size 之后（shot JSON 需要 model 做按族编译）

  // 模型解析三级：节点自身 metadata.model → 沿上游 config 节点链（与 estimateNodeCoins 报价同口径）→ 兜底。
  // 视频兜底必须是活路由模型（metaso/minimax-h3）；seedance-2.0 的唯一供应商 filmera 已 degraded，写死即死单。
  // 2026-10-12 暴君裁定：影片默认模型认知改为 minimax-h3（miaowuai 渠道上游 minimax-h3-max，稳定快速、约 45s 出片、单镜 5-15s、推荐 15s）。
  let model = typeof meta.model === "string" && meta.model ? meta.model : resolveNodeModel(nodeId, node, graph ?? { nodes: [], connections: [] })
  if (node.kind === "video" && (!model || model === "pixai-tsubaki2")) model = VIDEO_FALLBACK_MODEL // 2026-10-02：不再写死 minimax-h3（断路器 open）；resolveActiveModel 再按交付证据校正
  // F2（2026-08-31）：提交前主动查活性+跨 provider failover（取代旧的「探测到
  // unavailable 就报错」）。放在 shot 编译之前——编译要按实际会用的模型族来。
  const failoverResolved = await resolveActiveModel(model, node.kind === "video" ? "video" : "image", session.apiKey, node)
  if (failoverResolved.exhausted) {
    console.error(`[workflow] node ${nodeId} ${failoverResolved.error}`)
    return { nodeId: node.id, ok: false, error: failoverResolved.error! }
  }
  if (failoverResolved.switched) {
    console.log(failoverResolved.note)
    model = failoverResolved.model
    ;(node.metadata as Record<string, unknown>).model = model // 诚实纪律：后续重试/画布显示/计费都用实际路由到的模型
  }
  const size = typeof meta.size === "string" ? meta.size : "1024x1024"
  // 参考图：上游中已完成且有 content 的 image 节点（角色图/场景图 → 影片参考）
  // 2026-10-20：原样上移到 shot 编译之前，让 minimax 首行参考图对齐指令拿到真实参考图数量。
  const refImages = graph
    ? graph.connections
        .filter((c) => c.to === nodeId)
        .map((c) => graph.nodes.find((n) => n.id === c.from))
        .filter((n): n is ImageUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "image" && Boolean(upstream.get(n.id)))
        .map((n) => upstream.get(n.id)!)
    : []

  // 结构化 shot JSON 优先：video 节点 prompt 来自 shot JSON 时按模型族编译成模型最爱的格式。
  let prompt = meta.prompt || meta.content || collectUpstreamPrompt(nodeId) || ""
  let shotSize = size
  let payloadDurationHint: number | undefined = undefined
  const shotCandidate = (parseShotCandidate(meta.shot) ?? parseShotCandidate(prompt)) as ShotJson | null
  if (node.kind === "video" && shotCandidate) {
    // 2026-10-20 影片范式硬闸：没有状态变化（beats/state_change）的镜头直接拒收，不再退化成 PPT 慢推。
    const motionGate = validateMotionContract(shotCandidate)
    if (motionGate.ok === false) return { nodeId: node.id, ok: false, error: `invalid_shot: ${motionGate.error}` }
    const explicitRefCount =
      (typeof meta.first_frame_url === "string" ? 1 : 0) +
      (typeof meta.last_frame_url === "string" ? 1 : 0) +
      (Array.isArray(meta.reference_images) ? meta.reference_images.length : 0) +
      (typeof meta.reference === "string" ? 1 : 0) +
      // 3D 预演关键帧也是参考条件：shot.previz.keyframes 必须计入首行对齐说明，
      // 否则模型不知道后面几张图是同一镜头的预演帧。
      (shotCandidate.previz?.keyframes?.filter((ref) => typeof ref === "string" && ref.trim()).length ?? 0)
    try { prompt = compileShotPrompt(shotCandidate, model, { referenceImages: refImages.length + explicitRefCount }) }
    catch (error) { return { nodeId: node.id, ok: false, error: `invalid_shot: ${error instanceof Error ? error.message : String(error)}` } }
    const shotParams = shotOutputParams(shotCandidate)
    if (shotParams.duration_seconds !== undefined && typeof meta.duration_seconds !== "number") payloadDurationHint = shotParams.duration_seconds
    if (shotParams.aspect_ratio && typeof meta.size !== "string") shotSize = shotParams.aspect_ratio
  }

  if (node.kind === "video" && !shotCandidate && ["camera", "cam", "trajectory", "keyframes", "start", "end", "timing", "parallax", "cameraTrajectory", "camera_trajectory", "cameraStart", "camera_start", "startPosition", "start_position", "cameraEnd", "camera_end", "endPosition", "end_position", "cameraKeyframes", "camera_keyframes"].some(key => meta[key] !== undefined)) {
    try {
      const duration = typeof meta.duration_seconds === "number" ? meta.duration_seconds : undefined
      const camera = normalizeShotCamera(meta, duration)
      const motion = compileShotPrompt({ subject: "", action: "", camera, output: { duration_seconds: duration } }, model)
      const combined = `${prompt}\n${motion}`
      if (combined.length > 3800) throw new Error(`镜头提示词共 ${combined.length} 字超过 3800；未截断、未提交`)
      prompt = combined
    } catch (error) { return { nodeId: node.id, ok: false, error: `invalid_shot: ${error instanceof Error ? error.message : String(error)}` } }
  }

  const endpoint = node.kind === "video" ? "/videos/generations" : "/images/generations"
  const payload: Record<string, unknown> = {
    prompt,
    model,
    size: shotSize,
    n: 1,
    response_format: "url",
  }
  if (node.kind === "video") {
    await catalogVideoPerSecondCoins(model, session.apiKey)
    const videoOptions = resolveVideoSubmissionOptions(
      { id: typeof node.id === "string" ? node.id : nodeId, metadata: node.metadata ?? undefined },
      graph,
      model,
    )
    if (videoOptions.error) return { nodeId: node.id, ok: false, error: videoOptions.error }
    payload.generate_audio = videoOptions.generateAudio
    // 当前API无resolution/quality输入；显式非默认档已拒绝，不提交会被静默忽略的字段。
    // INC-0830：时长三级解析 meta → shot → 连线的视频 config；全部缺失时拒绝提交。
    // 旧版静默 `?? 5` 是 5 秒片事故根因之一：暴君指定 15s、上游照 5s 出、按条统一价照收。
    const cfgDuration = resolveConnectedVideoDuration(nodeId, graph)
    const duration =
      typeof meta.duration_seconds === "number" && meta.duration_seconds > 0
        ? meta.duration_seconds
        : (payloadDurationHint ?? cfgDuration)
    if (typeof duration !== "number" || !(duration > 0)) {
      return {
        nodeId: node.id,
        ok: false,
        error:
          "视频节点缺少时长（duration_seconds）：节点参数、shot JSON output、连线的视频配置节点均未提供。上游按条统一计费（5s/15s 同价），缺时长会被按 5 秒出片。请在任一来源补上 duration_seconds 后重跑",
      }
    }
    payload.duration_seconds = duration
    // 显式关键帧优先，连线图片随后；保序传递整组，不再只发第一张。
    if (meta.reference_images !== undefined && !Array.isArray(meta.reference_images)) {
      return { nodeId: node.id, ok: false, error: "视频 reference_images 必须是图片 URL 数组。" }
    }
    if ([meta.first_frame_url, meta.last_frame_url, meta.reference].some((ref) => ref !== undefined && typeof ref !== "string")) {
      return { nodeId: node.id, ok: false, error: "视频起止帧及 reference 必须是图片 URL 字符串。" }
    }
    const explicitRefs = Array.isArray(meta.reference_images) ? meta.reference_images : []
    // 3D 预演关键帧（shot.previz.keyframes）进参考图：预演是条件不是装饰，
    // 否则 3D 导演席位交出的 blocking/机位帧根本到不了视频模型。
    const previzRefs = (shotCandidate?.previz?.keyframes ?? []).filter(
      (ref): ref is string => typeof ref === "string" && ref.trim().length > 0 && !explicitRefs.includes(ref),
    )
    const orderedRefs = [
      ...(typeof meta.first_frame_url === "string" ? [meta.first_frame_url] : []),
      ...(typeof meta.last_frame_url === "string" ? [meta.last_frame_url] : []),
      ...explicitRefs,
      ...previzRefs,
      ...(typeof meta.reference === "string" ? [meta.reference] : []),
      ...refImages,
    ]
    const invalidRef = orderedRefs.some((ref) => typeof ref !== "string" || !/^https?:\/\//i.test(ref.trim()))
    if (invalidRef) return { nodeId: node.id, ok: false, error: "视频参考图必须是 http(s) URL；请先上传本地关键帧。" }
    // 首尾可以刻意使用同一张图；帧位置仍须保留，不能按 URL 去重抹掉止帧。
    const videoRefs = orderedRefs.map((ref) => (ref as string).trim())
    if (videoRefs.length) payload.reference_images = videoRefs
  } else if (refImages.length) {
    payload.reference = refImages[0]
  }

  // 2026-09-25：行内实体 tag（`@[种类:名称]`）展开——工作流节点提示词里的 token 到这里才被
  // 解析。此前闸道整包零 `reference_images` 通道，token 原封不动送上游＝「画布没有实体卡节点、
  // 四视图各生各的、脸不一致」的结构缺口。
  //
  // 插入点刻意选在**最终 prompt 定案之后、payload.reference 写入之后**：
  //   ① video 分支的 prompt 可能已被上方 `compileShotPrompt` 重编（本档 L866）——提早展开会被
  //      重编打散（编译器按模型族重排版面，token 片段会被当普通文本重排）；
  //   ② 合并规则要用到 `payload.reference`（连线上游 image 节点那张，上面 video/image 两分支
  //      才写入），在此处才能一次算完「卡参考图 ∪ 既有 reference」；
  //   ③ 放在 `if (!prompt)` 空提示词守卫之前：零 token 时本块整段跳过（原值、零 HTTP），
  //      空 prompt 走原守卫报错——既有语义逐字不变。
  //
  // 解析器是站点端点 `/api/biz/character-resolve` 的薄客户端（不重写解析）；零 token 零 HTTP；
  // 任何失败 fail-open（原 prompt + 空 refs），解析失败永不阻断生成。
  // meta.prompt/meta.content 是 unknown（payload 袋）→ token 判定前先收敛成字串。
  const promptForTokens = typeof prompt === "string" ? prompt : ""
  if (hasEntityToken(promptForTokens)) {
    // 解析用这位使用者的 key（`session.apiKey`，同下方提交用的 Bearer）：卡库按使用者隔离。
    const resolved = await resolveEntityTokens(promptForTokens, refImages, undefined, { apiKey: session.apiKey })
    payload.prompt = resolved.prompt
    // 视频关键帧在前，实体参考随后；不以实体解析器的 5 张上限截断视频输入。
    // 模型上限交给控制面校验，超限明确拒绝，不能静默丢帧。
    const mergedRefs = node.kind === "video"
      ? [
          ...(Array.isArray(payload.reference_images) ? payload.reference_images as string[] : []),
          ...resolved.reference_images.filter((ref) => !(Array.isArray(payload.reference_images) && payload.reference_images.includes(ref))),
        ]
      : sanitizeEntityReferences([
          ...resolved.reference_images,
          ...(typeof payload.reference === "string" ? [payload.reference] : []),
        ])
    if (mergedRefs.length) payload.reference_images = mergedRefs
  }

  if (!prompt) {
    console.error(`[workflow] node ${nodeId} (${node.kind}) has no prompt`)
    return { nodeId: node.id, ok: false, error: "缺少提示词：上游文本节点未填写内容" }
  }

  // F2（2026-08-31）：旧的「提交前探测 unavailable 就报错」后置检查已移到函式
  // 前段的 resolveActiveModel（主动 failover，不再是单纯报错）——此处不再重复探测。
  let taskSubmitted = false
  // INC-0830：轮询响应里的 attempts 明细（片A 加的 /v1/videos/{id} attempts 阵列）
  // 就地快取——失败时随节点错误回带，画布错误卡能看到真话（上游成没成、谁的锅）。
  // F1 修（2026-08-31）：声明必须在函式级——原困在 poll 分支块内，poll 预算耗尽后
  // 的 taskSubmitted 兜底引用它 → ReferenceError → 误判 non-retryable → 死错。
  let lastAttempt: Record<string, unknown> | undefined = undefined
  let submittedTaskId = ""
  let queuedSinceMs = 0
  let queueHinted = false
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, any>
    if (res.status === 202 || (res.ok && (data?.task_id || data?.id))) {
      taskSubmitted = true
      const taskId = data?.task_id ?? data?.id
      // INC-0830：把上游作业 id 记到节点 metadata.last_job_id——rerun 防重门与节点
      // error 真相都消费它，agent 不再盲跑重复扣费（事故根因之三）。
      try {
        ;(node.metadata as Record<string, unknown>).last_job_id = String(taskId)
      } catch {}
      submittedTaskId = String(taskId)
      {
        // 2026-10-02：登记进工作流 job 表——终态向控面结算实扣、放弃/停滞时据此取消。
        const jwf = workflowOwnerBySession.get(session.sessionId) ?? wfidFromNodeId(nodeId)
        if (jwf) {
          if (!workflowJobs.has(jwf)) workflowJobs.set(jwf, new Map())
          workflowJobs.get(jwf)!.set(submittedTaskId, { nodeId, kind: node.kind === "video" ? "video" : "image" })
        }
      }
      // H11 补完：workflow 生成任务同样登记进会话任务表（/internal/session-tasks、image_get_result 读它）。
      registerWorkflowTask(session, String(taskId), node.id, "queued")
      const pollEndpoint = node.kind === "video" ? `/videos/${taskId}` : `/images/${taskId}`
      // 轮询：间隔 3s；图最多 120s、影片最多 300s（seedance 5 秒片可能排队较久）
      // 2026-08-21（PM 要求）：预算按真实耗时放宽——实测 image 60-90s、kling 8s 影片 >300s
      // （Kling 标准模式约 2-6 分钟）。video 200 次=600s，image 60 次=180s。
      const pollBudget = node.kind === "video" ? 200 : 60
      const startedAtMs = Date.now()
      const etaSeconds = node.kind === "video" ? 360 : 120
      const wfIdMatch = nodeId.match(/^(.+)-[^-]+-\d+$/)
      for (let i = 0; i < pollBudget; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        // 进度条：每 15s 推一次 elapsed/ETA（percent 封顶 95%，成功事件才是 100%）
        if (i % 5 === 4) {
          const elapsedSec = Math.round((Date.now() - startedAtMs) / 1000)
          const percent = Math.min(95, Math.round((elapsedSec / etaSeconds) * 100))
          const patch = { status: "running" satisfies TaskStatus, progress: { elapsed_seconds: elapsedSec, eta_seconds: etaSeconds, percent } }
          emitToSession(session, "canvas.node.updated", {
            node_id: nodeId,
            ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}),
            patch,
          })
          // 2026-10-02：轮询打点直发 emitToSession 绕过 emit hook，停滞时钟不刷新 → 长排队被误判 stuck。
          {
            // 节点 id 形如 single_image-result-2（不含 wfid），故 wfIdMatch 对模板节点恒不命中；改按会话属主工作流刷新。
            const pw = workflowOwnerBySession.get(session.sessionId) ?? (wfIdMatch ? wfIdMatch[1] : "")
            if (pw && workflowWake.has(pw)) workflowWake.get(pw)!.lastProgressAt = Date.now()
          }
          applyCanvasNodeUpdated(session.sessionId, { node_id: nodeId, patch })
        }
        const poll = await fetch(`${PLATFORM_BASE}/v1${pollEndpoint}`, {
          headers: { Authorization: `Bearer ${session.apiKey}` },
          signal: AbortSignal.timeout(10000),
        })
        const pd = (await poll.json().catch(() => ({}))) as Record<string, any>
        const pdAttempts = (pd as { attempts?: unknown })?.attempts
        if (Array.isArray(pdAttempts) && pdAttempts.length > 0) lastAttempt = pdAttempts[pdAttempts.length - 1] as Record<string, unknown>
        // 2026-10-02：上游「并发/容量饱和」是可等待的背压（status 仍是 queued/running），不是硬失败。
        // 提前辨识，让下方排队换道块接手；只有超过换道门槛或明确硬失败才在后面翻面。
        const pdSig = pd as { failure_class?: unknown; failure_detail?: unknown; status?: unknown } | undefined
        const upstreamFailSignal =
          typeof pdSig?.failure_class === "string" && pdSig.failure_class
            ? pdSig.failure_class
            : typeof pdSig?.failure_detail === "string" && pdSig.failure_detail
              ? pdSig.failure_detail
              : ""
        const saturationSignal = /capacity|saturat|overload|concurr|too many/i.test(upstreamFailSignal)
        const queueLike = pd?.status === "queued" || (saturationSignal && pd?.status !== "succeeded" && pd?.status !== "failed")
        // 2026-10-02 排队超 5 分钟（或容量饱和同样视为排队）：提示 + 换同价位通道
        //（无则明确降级＝续等至预算耗尽后取消退款）。
        if (node.kind === "video" && queueLike) {
          if (!queuedSinceMs) queuedSinceMs = Date.now()
          if (!queueHinted && Date.now() - queuedSinceMs > QUEUE_SWITCH_MS) {
            queueHinted = true
            const qMin = Math.round(QUEUE_SWITCH_MS / 60000)
            const alt = (Number(meta.__queueSwitches ?? 0) < 1) ? await pickSamePriceVideoAlternative(model, session.apiKey, node) : null
            const hintPatch = {
              status: "running" satisfies TaskStatus,
              human_message: alt
                ? `上游通道排队已超过 ${qMin} 分钟，正在自动切换到同价位通道 ${alt}`
                : `上游通道排队已超过 ${qMin} 分钟（当前无同价位的可用备选通道），继续等待；超过上限将自动取消并全额退款`,
            }
            emitToSession(session, "canvas.node.updated", { node_id: nodeId, ...(wfIdMatch ? { workflow_id: wfIdMatch[1] } : {}), patch: hintPatch })
            applyCanvasNodeUpdated(session.sessionId, { node_id: nodeId, patch: hintPatch })
            console.log(`[workflow] node ${nodeId} queued >${qMin}min model=${model} alt=${alt ?? "none"}`)
            if (alt) {
              const c = await cancelPlatformJob(session.apiKey, submittedTaskId)
              if (c.cancelled) {
                registerWorkflowTask(session, submittedTaskId, node.id, "failed")
                const tried = new Set<string>(Array.isArray(meta.__triedModels) ? (meta.__triedModels as string[]) : [])
                tried.add(model)
                meta.__triedModels = [...tried]
                meta.__queueSwitches = Number(meta.__queueSwitches ?? 0) + 1
                meta.model = alt
                meta.model_swap = { from: model, to: alt, reason: `queued>${qMin}min`, proven: true }
                return await submitWorkflowNode(session, node, upstream, graph)
              }
            }
          }
        } else {
          queuedSinceMs = 0
        }
        if (pd?.status === "succeeded") {
          const rawUrl = pd?.data?.[0]?.url || pd?.result_url || pd?.url
          // 结果可能是相对 /v1/images/{id}/result，转成绝对公开 URL（沿用 resolveResultUrl 语义）
          const url = rawUrl
            ? /^https?:\/\//.test(rawUrl)
              ? rawUrl
              : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
            : ""
          if (url) {
            registerWorkflowTask(session, String(taskId), node.id, "succeeded", url)
            return { nodeId: node.id, ok: true, content: url, costCoins: pd?.cost_coins }
          }
          break
        }
        if (pd?.status === "failed") {
          console.error(`[workflow] node ${nodeId} generation failed: ${pd?.error?.message}`)
          registerWorkflowTask(session, String(taskId), node.id, "failed")
          return { nodeId: node.id, ok: false, error: pd?.error?.message || "generation failed", lastAttempt }
        }
        // R7-A（2026-08-29）失败即翻面：供应商并发饱和时上游 job 会以 queued +
        // failure_detail（如 "capacity_saturated: ..."）反覆重试、迟迟不到终态 failed；
        // 旧逻辑只认 status==="failed"，明知上游已报失败信号仍继续发 running 进度帧，
        // 直到轮询预算耗尽才报假话术。收到失败信号立即翻面，不再空转。
        const pdFail = pdSig
        const failSignal = upstreamFailSignal
        if (failSignal && pdFail?.status !== "succeeded") {
          // 2026-10-02：容量/并发饱和是可等待背压——在 WORKFLOW_QUEUE_SWITCH_MS 换道窗口内
          // 不翻面，让上方排队块在门槛到达时「换同价位通道＋5 分钟提示」；超过窗口或已换过
          // 道仍饱和才 fail-fast（fail-fast 路径同样 cancelPlatformJob 全额退款，快速止损语义不变）。
          const withinSwitchWindow = queuedSinceMs > 0 && Date.now() - queuedSinceMs <= QUEUE_SWITCH_MS
          const alreadySwitched = Number(meta.__queueSwitches ?? 0) >= 1
          if (saturationSignal && withinSwitchWindow && !alreadySwitched) {
            console.warn(
              `[workflow] node ${nodeId} saturation backpressure within ${Math.round(QUEUE_SWITCH_MS / 1000)}s switch window (${pdFail?.status}): ${failSignal}`,
            )
            continue
          }
          console.error(`[workflow] node ${nodeId} upstream failure signal (${pdFail?.status}): ${failSignal}`)
          registerWorkflowTask(session, String(taskId), node.id, "failed")
          // 放弃即取消：否则 job 在控面继续排队、日后成功扣费＝孤儿镜（评测 4ea050fe 多扣 130 币根因）。
          if (pdFail?.status === "queued" || pdFail?.status === "running") await cancelPlatformJob(session.apiKey, String(taskId))
          return {
            nodeId: node.id,
            ok: false,
            error: formatNodeFailure(
              pdFail?.failure_class,
              pdFail?.failure_detail ?? failSignal,
              "生成失败：任务已提交但上游渠道未能执行",
              "；可在画布上稍后重试或更换模型。若已扣款以平台账单为准（归因以 failure_class 与原文为准，勿自行推断供应商并发满/排队超时）",
            ),
            lastAttempt,
          }
        }
        if (poll.status >= 400 && poll.status !== 404) {
          console.error(`[workflow] node ${nodeId} poll ${poll.status}: ${(pd as { error?: { message?: string } })?.error?.message}`)
          return { nodeId: node.id, ok: false, error: `poll ${poll.status}`, lastAttempt }
        }
      }
    }
    // 同步回图兜底
    const url = data?.data?.[0]?.url || data?.result_url || data?.url
    if (res.ok && url) return { nodeId: node.id, ok: true, content: url, costCoins: data?.cost_coins }
    if (taskSubmitted) {
      console.error(`[workflow] node ${nodeId} poll timeout`)
      // 放弃即取消（同上）：排队中的 job 全额退款，避免迟到成功成孤儿镜。
      if (submittedTaskId) await cancelPlatformJob(session.apiKey, submittedTaskId)
      return {
        nodeId: node.id,
        ok: false,
        error: "生成超时：任务已提交但上游渠道未能执行（供应商并发满或排队超时）；可在画布上稍后重试或更换模型。若已扣款以平台账单为准",
        lastAttempt,
      }
    }
    console.error(`[workflow] node ${nodeId} submit failed: ${JSON.stringify(data)}`)
    return { nodeId: node.id, ok: false, error: data?.error?.message || `submit ${res.status}` }
  } catch (e) {
    console.error(`[workflow] node ${nodeId} exception: ${(e as Error).message}`)
    return { nodeId: node.id, ok: false, error: (e as Error).message }
  }
}
