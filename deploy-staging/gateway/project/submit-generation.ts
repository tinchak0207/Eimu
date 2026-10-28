// S5：工程图的网关侧生成提交（SubmitGenerationFn）。
// 基底 = workflow-gw-submit.ts submitWorkflowNode（模型解析/F2 failover/排队换道/轮询/取消退款原样复用其导出函数），
// 载荷字段按 opencode-runtime/tools/image_generate.ts:495-511 逐栏对齐，另补四样：
//   Idempotency-Key（pg:<pid>:<sig40>:t<take>:a<attempt>）、generation_receipts 登记、项目预算预留、workflow.metadata 带 node_id/signature。
// 不碰 workflow-gw-submit.ts 的导出签名；不重写 failover/排队换道逻辑，只是把“换道后重投”改成“取消 → 返回可重试，下一 attempt 走新模型”
// （同一 Idempotency-Key 换模型会被上游去重回原任务）。
import { createHash } from "node:crypto"
import { PLATFORM_BASE } from "../constants-gateway.ts"
import { catalogUnitCoins, catalogVideoPerSecondCoins, resolveVideoSubmissionOptions, videoNodeCoinsSync } from "../pricing-gateway.ts"
import { hasEntityToken, resolveEntityTokens, sanitizeEntityReferences } from "../entity-resolve.ts"
import { acknowledgeGeneration, completeGenerationReceipt, registerGenerationReceipt } from "../job-store.ts"
import { QUEUE_SWITCH_MS, cancelPlatformJob, formatNodeFailure, pickSamePriceVideoAlternative, registerWorkflowTask, resolveActiveModel } from "../workflow-gw-submit.ts"
import type { SessionState } from "../types-gateway.ts"
import type { ExecErrorCode, LedgerEntryProjectFields, LedgerWriter, SubmitGenerationFn, SubmitGenerationReq, SubmitGenerationRes } from "./types.ts"
import type { ProjectBudgetPort } from "./ledger.ts"

export interface SubmitGenerationDeps {
  session: Pick<SessionState, "sessionId" | "opencodeSessionId" | "apiKey"> & { sessionTasks?: SessionState["sessionTasks"] }
  ledger: LedgerWriter
  budget: ProjectBudgetPort
  /** 轮询间隔，默认 3000ms（与 submitWorkflowNode 相同）。 */
  pollIntervalMs?: number
}

export const idempotencyKeyOf = (r: Pick<SubmitGenerationReq, "projectId" | "signature" | "take" | "attempt">): string =>
  `pg:${r.projectId}:${r.signature.slice(0, 40)}:t${r.take}:a${r.attempt}`

// 图片档位价。选择规则与 image_generate.ts:403 相同：hd 取 hd ?? standard，其余取 standard ?? hd。
// 不抄工具本体。非 hd 在目录行缺失时回退 catalogUnitCoins，避免把 standard 报价抬成 hd。
type ImageTiers = { standard?: number; hd?: number }
let imageTierCache: { at: number; byModel: Record<string, ImageTiers> } | null = null
const IMAGE_TIER_TTL_MS = 10 * 60 * 1000

function pickImageUnit(tiers: ImageTiers | undefined, quality: string | undefined): number | null {
  if (!tiers) return null
  const unit = quality === "hd" ? (tiers.hd ?? tiers.standard) : (tiers.standard ?? tiers.hd)
  return typeof unit === "number" && Number.isFinite(unit) && unit >= 0 ? unit : null
}

async function loadImageTiers(apiKey: string): Promise<Record<string, ImageTiers> | null> {
  const now = Date.now()
  if (imageTierCache && now - imageTierCache.at <= IMAGE_TIER_TTL_MS) return imageTierCache.byModel
  try {
    const res = await fetch(`${PLATFORM_BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return imageTierCache?.byModel ?? null
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const byModel: Record<string, ImageTiers> = {}
    for (const m of body.data ?? []) {
      const id = typeof m.id === "string" ? m.id : null
      if (!id) continue
      const raw = m.x_coins_per_image
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) byModel[id] = { standard: raw, hd: raw }
      else if (raw && typeof raw === "object") {
        const o = raw as Record<string, unknown>
        const tiers: ImageTiers = {}
        if (typeof o.standard === "number" && Number.isFinite(o.standard) && o.standard >= 0) tiers.standard = o.standard
        if (typeof o.hd === "number" && Number.isFinite(o.hd) && o.hd >= 0) tiers.hd = o.hd
        if (tiers.standard !== undefined || tiers.hd !== undefined) byModel[id] = tiers
      }
    }
    imageTierCache = { at: now, byModel }
    return byModel
  } catch {
    return imageTierCache?.byModel ?? null
  }
}

async function imageUnitCoins(model: string, apiKey: string, quality: string | undefined): Promise<number | null> {
  const table = await loadImageTiers(apiKey)
  const fromTiers = pickImageUnit(table?.[model], quality)
  if (fromTiers !== null) return fromTiers
  if (quality === "hd") return null
  return catalogUnitCoins(model, apiKey)
}

// ↓ 逐字复制自 opencode-runtime/lib/video-prompt-schema.ts:255-263（网关与 runtime 是两棵树，不能互相 import）。
const VIDEO_MOTION_FALLBACK =
  "Continuous physical action drives the shot: the subject's position, pose, and silhouette change measurably from the first frame to the last, with at least one change in the environment or staging along the way. The camera move follows that change instead of replacing it."
function hasMotionContract(text: string): boolean {
  if (/^integrated_multimodal_description\s*:/m.test(text) && /^overall_soundscape\s*:/m.test(text) && /^non_diegetic_music\s*:/m.test(text)) return true
  if (/^subject_definitions\s*:/m.test(text) && /^detailed_description\s*:/m.test(text) && /^overall_soundscape\s*:/m.test(text)) return true
  return /(state change|action beat|visibly changed|measurably|by the final frame)/i.test(text)
}
const sha256Json = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_REFERENCE_IMAGES = 5 // image_generate.ts:57
const SAFETY = /safety|moderation|content[_ ]policy|blocked|违规|敏感/i

// 进程内记忆：已受理的 task（同 key 重入不再 POST）、已写过 submitted 行的 key、节点级 failover 状态（__triedModels/model_swap 等）。
const MEMORY_MAX = 2000
const acceptedTask = new Map<string, string>()
const submittedLogged = new Set<string>()
const nodeMemory = new Map<string, Record<string, unknown>>()
function bound<K, V>(m: Map<K, V>) { while (m.size > MEMORY_MAX) m.delete(m.keys().next().value as K) }
export function __resetSubmitGenerationMemory(): void {
  acceptedTask.clear()
  submittedLogged.clear()
  nodeMemory.clear()
  imageTierCache = null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve() }
    signal.addEventListener("abort", done, { once: true })
  })
}

export function createSubmitGeneration(deps: SubmitGenerationDeps): SubmitGenerationFn {
  return (req) => submitGeneration(deps, req)
}

async function submitGeneration(deps: SubmitGenerationDeps, req: SubmitGenerationReq): Promise<SubmitGenerationRes> {
  const { session, ledger, budget } = deps
  const bad = (message: string): SubmitGenerationRes => ({ ok: false, code: "bad_input", message, retryable: false })
  if (!req.projectId || !req.nodeId || !req.signature || !req.runId) return bad("projectId/nodeId/signature/runId 必填；未提交。")
  if (!Number.isInteger(req.attempt) || req.attempt < 0 || !Number.isInteger(req.take) || req.take < 0) return bad("attempt/take 必须是非负整数；未提交。")
  if (req.kind !== "image" && req.kind !== "video") return bad(`kind 必须是 image|video，收到 ${String(req.kind)}；未提交。`)
  if (!req.prompt || !req.prompt.trim()) return bad("缺少提示词：${} 引用必须在提交前解析完；未提交。")
  if (!req.apiKey || req.sessionId !== session.sessionId) return bad("会话与凭证不匹配；未提交。")

  const idemKey = idempotencyKeyOf(req)
  const kind = req.kind
  const nodeKey = `${req.projectId}:${req.nodeId}`
  const mem = nodeMemory.get(nodeKey) ?? {}
  nodeMemory.set(nodeKey, mem); bound(nodeMemory)
  const swap = mem.model_swap as { from?: string; to?: string } | undefined
  let model = swap?.from === req.model && typeof swap.to === "string" ? swap.to : req.model

  const common = { project_id: req.projectId, node_id: req.nodeId, signature: req.signature, run_id: req.runId, attempt: req.attempt, take: req.take, idem_key: idemKey }
  const row = (event: "submitted" | "completed" | "failed" | "refunded", extra: { cost_coins?: number; task_id?: string; result_url?: string } = {}) =>
    ledger.write({ ...common, event, model, ...extra })
  const fail = (code: ExecErrorCode, message: string, retryable: boolean, extra: { taskId?: string; submitUnknown?: boolean } = {}): SubmitGenerationRes => ({ ok: false, code, message, retryable, ...extra })

  // ---- 模型：F2 failover（原函数）----
  const fnode = { id: req.nodeId, kind, metadata: mem }
  const resolved = await resolveActiveModel(model, kind, req.apiKey, fnode)
  if (resolved.exhausted) return fail("provider_error", resolved.error!, false)
  if (resolved.switched) { model = resolved.model; mem.model = model; console.log(resolved.note) }

  // ---- 规格校验（对齐 image_generate.ts:381-398）----
  const size = req.size ?? (kind === "video" ? "16:9" : "1024x1024")
  const n = req.n ?? 1
  const maxRefs = kind === "video" && model === "minimax-h3" ? 9 : MAX_REFERENCE_IMAGES
  const refs = (req.referenceImages ?? []).map((r) => (typeof r === "string" ? r.trim() : r))
  if (refs.some((r) => typeof r !== "string" || !/^https?:\/\//i.test(r))) return bad("参考图必须是 http(s) URL；请先入库取公网地址。未提交。")
  if (refs.length > maxRefs) return bad(`模型 ${model} 最多接受 ${maxRefs} 张参考图，本次未提交且未扣费。`)
  if (kind === "video") {
    if (typeof req.seconds !== "number" || !(req.seconds > 0)) return bad("视频缺少时长（seconds）：按条统一计费，缺时长会被按默认秒数出片。未提交。")
    if (req.seconds < 5) return bad(`视频时长 ${req.seconds} 秒过短：上游按条计费，视频最少 5 秒。未提交。`)
  }

  // ---- 报价（缺价 = 拒绝，不以未知价格开跑）----
  let cost: number
  let videoResolution: string | null = null
  let generateAudio = req.generateAudio
  if (kind === "image") {
    const unit = await imageUnitCoins(model, req.apiKey, req.quality)
    if (unit === null) return fail("price_unknown", "没有本次模型档位的权威报价，未提交。", true)
    cost = Math.round(unit * n * 1e6) / 1e6
  } else {
    await catalogVideoPerSecondCoins(model, req.apiKey)
    const meta: Record<string, unknown> = { model, ...(req.resolution ? { resolution: req.resolution } : {}), ...(req.generateAudio !== undefined ? { generate_audio: req.generateAudio } : {}) }
    const options = resolveVideoSubmissionOptions({ id: req.nodeId, metadata: meta }, undefined, model)
    if (options.error) return bad(options.error)
    videoResolution = options.resolution
    generateAudio = options.generateAudio
    const coins = videoNodeCoinsSync({ id: req.nodeId, metadata: meta }, undefined, req.seconds!)
    if (coins === null) return fail("price_unknown", "目录没有本次完整提交档位的币值报价；未提交。", true)
    cost = coins
  }

  // ---- 提示词：style_lock 前置 → 实体 tag → 视频动作兜底（image_generate.ts:461-494）----
  let finalPrompt = req.styleLock ? `${req.styleLock}\n${req.prompt}` : req.prompt
  let finalRefs = refs as string[]
  if (hasEntityToken(finalPrompt)) {
    const r = await resolveEntityTokens(finalPrompt, finalRefs, undefined, { apiKey: req.apiKey }) // fail-open：解析失败回原值
    finalPrompt = r.prompt
    finalRefs = kind === "video" ? [...finalRefs, ...r.reference_images.filter((u) => !finalRefs.includes(u))] : sanitizeEntityReferences([...r.reference_images, ...finalRefs])
    if (finalRefs.length > maxRefs) return bad(`角色卡补图后共 ${finalRefs.length} 张，超过 ${maxRefs} 张；未截断、未提交。`)
  }
  if (kind === "video" && !hasMotionContract(finalPrompt)) finalPrompt = `${finalPrompt} ${VIDEO_MOTION_FALLBACK}`

  // ---- 项目预算：任何生成 POST 之前先预留 ----
  const reserved = await budget.reserve({ projectId: req.projectId, idemKey, coins: cost })
  if (reserved.ok === false) return fail(reserved.code === "budget_exceeded" ? "bad_input" : "provider_error", reserved.message, reserved.code === "budget_unavailable")

  // ---- 载荷（字段集 = image_generate.ts:495-511）----
  const referenceVersion = sha256Json(finalRefs)
  const styleVersion = sha256Json(req.styleLock ?? "")
  const payload: Record<string, unknown> =
    kind === "video"
      ? { prompt: finalPrompt, model, size, duration_seconds: req.seconds, generate_audio: generateAudio, ...(videoResolution ? { resolution: videoResolution } : {}), ...(finalRefs.length ? { reference_images: finalRefs } : {}) }
      : { prompt: finalPrompt, model, size, n, response_format: "url", ...(req.quality ? { quality: req.quality } : {}), ...(finalRefs.length ? { reference_images: finalRefs } : {}) }
  payload.workflow = {
    metadata: {
      // image_generate 的既有键（旧读者 trackedLegacySubmission 等按这些键取）
      budget_version: reserved.version, session_id: session.sessionId, project: req.projectId, request_id: idemKey, size,
      reference_version: referenceVersion, style_version: styleVersion, style_lock: req.styleLock ?? "",
      // 契约新增（§3 SubmitGenerationFn 注释）
      project_id: req.projectId, node_id: req.nodeId, signature: req.signature, run_id: req.runId, attempt: req.attempt, take: req.take,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    },
  }
  payload.cap_coins = cost // image_generate.ts:511：单次实扣不得高于预留；目录变价由平台拒绝而非穿透预算

  const endpoint = kind === "video" ? "/videos/generations" : "/images/generations"
  const release = () => budget.release(idemKey)
  let taskId = acceptedTask.get(idemKey) ?? ""

  if (!taskId) {
    if (!submittedLogged.has(idemKey)) {
      submittedLogged.add(idemKey)
      if (submittedLogged.size > MEMORY_MAX) submittedLogged.delete(submittedLogged.values().next().value as string)
      await row("submitted", { cost_coins: cost })
    }
    let res: Response
    let data: Record<string, any>
    try {
      res = await fetch(`${PLATFORM_BASE}/v1${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idemKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
      })
      data = (await res.json().catch(() => ({}))) as Record<string, any>
    } catch (e) {
      // 网络/超时：订单可能已被受理。保留预留与 key，不假装没发出去，不盲重投。
      return fail("submit_unknown", `提交状态不确定（${(e as Error).message}）；已保留 Idempotency-Key=${idemKey} 与预算预留，请用同一 key 恢复。`, false, { submitUnknown: true })
    }
    const id = data?.task_id ?? data?.id
    if (res.status === 202 || (res.ok && id)) {
      if (typeof id !== "string" || !UUID.test(id))
        return fail("submit_unknown", `上游接受但未给完整 task_id；保留 Idempotency-Key=${idemKey} 与预算预留。`, false, { submitUnknown: true })
      taskId = id
    } else if (res.ok) {
      // 同步回图兜底（submitWorkflowNode:641-643）：无 job 的同步产物，没有 task 可登记。
      const syncUrls = urlsOf(data)
      if (syncUrls.length) return finishSuccess(deps, { common, model, kind, n, size, cost, idemKey, taskId: "", urls: syncUrls, actual: Number.isFinite(data?.cost_coins) ? Number(data.cost_coins) : cost, req, referenceVersion, styleVersion, registered: false })
      return fail("submit_unknown", `上游 ${res.status} 未给 task_id 也无产物；保留 Idempotency-Key=${idemKey} 与预算预留。`, false, { submitUnknown: true })
    } else if (res.status >= 400 && res.status < 500) {
      // 明确拒收：没有订单，释放预留。
      release()
      const message = String(data?.error?.message ?? `submit ${res.status}`)
      await row("failed", { cost_coins: 0 })
      return fail(SAFETY.test(message) ? "safety_blocked" : res.status === 400 || res.status === 422 ? "bad_input" : "provider_error", message, res.status === 429)
    } else {
      // 5xx：上游可能已落单，按未知处理，不释放。
      return fail("submit_unknown", `上游 ${res.status}；订单状态不确定，已保留 Idempotency-Key=${idemKey} 与预算预留。`, false, { submitUnknown: true })
    }
    acceptedTask.set(idemKey, taskId); bound(acceptedTask)
  }

  // ---- 收据登记（失败不阻断：task 已在手，继续轮询；回报里列为风险）----
  let registered = false
  try {
    registerGenerationReceipt({
      task_id: taskId, parent_gw: session.sessionId, producer_oc: session.opencodeSessionId, consumer_oc: session.opencodeSessionId, kind,
      model, cost_coins: cost, request_id: idemKey, requested_count: n, size, project: req.projectId,
      reference_version: referenceVersion, style_version: styleVersion,
      node_id: req.nodeId, signature: req.signature, run_id: req.runId, attempt: req.attempt, take: req.take,
    })
    registered = true
  } catch (e) { console.error(`[project] receipt register failed task=${taskId}: ${(e as Error).message}`) }
  if (session.sessionTasks) registerWorkflowTask(session, taskId, req.nodeId, "queued")

  // ---- 轮询（submitWorkflowNode:502-640，间隔可注入）----
  const interval = deps.pollIntervalMs ?? 3000
  const pollEndpoint = kind === "video" ? `/videos/${taskId}` : `/images/${taskId}`
  const pollBudget = kind === "video" ? 200 : 60
  let queuedSinceMs = 0
  let queueHinted = false
  let consecutiveErrors = 0
  for (let i = 0; i < pollBudget; i++) {
    await sleep(interval, req.signal)
    if (req.signal.aborted) return abandon(deps, { common, model, taskId, cost, idemKey, registered, why: "cancelled", cancel: true, req })
    let pd: Record<string, any>
    let status: number
    try {
      const poll = await fetch(`${PLATFORM_BASE}/v1${pollEndpoint}`, { headers: { Authorization: `Bearer ${req.apiKey}` }, signal: AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]) })
      status = poll.status
      pd = (await poll.json().catch(() => ({}))) as Record<string, any>
    } catch {
      if (req.signal.aborted) continue
      if (++consecutiveErrors >= 5) return fail("submit_unknown", `任务 ${taskId} 状态连续 5 次不可读；任务仍在上游，保留预算预留，用 task_id 续查。`, false, { taskId, submitUnknown: true })
      continue
    }
    consecutiveErrors = 0
    const failSignal = typeof pd?.failure_class === "string" && pd.failure_class ? pd.failure_class : typeof pd?.failure_detail === "string" && pd.failure_detail ? pd.failure_detail : ""
    const saturation = /capacity|saturat|overload|concurr|too many/i.test(failSignal)
    const queueLike = pd?.status === "queued" || (saturation && pd?.status !== "succeeded" && pd?.status !== "failed")

    // 排队超时换道（submitWorkflowNode:550-578）：同价位备选 → 取消原单 → 下一 attempt 用新模型。
    if (kind === "video" && queueLike) {
      if (!queuedSinceMs) queuedSinceMs = Date.now()
      if (!queueHinted && Date.now() - queuedSinceMs > QUEUE_SWITCH_MS) {
        queueHinted = true
        const alt = Number(mem.__queueSwitches ?? 0) < 1 ? await pickSamePriceVideoAlternative(model, req.apiKey, fnode) : null
        console.log(`[project] node ${req.nodeId} queued >${Math.round(QUEUE_SWITCH_MS / 60000)}min model=${model} alt=${alt ?? "none"}`)
        if (alt) {
          const c = await cancelPlatformJob(req.apiKey, taskId)
          if (c.cancelled) {
            mem.__queueSwitches = Number(mem.__queueSwitches ?? 0) + 1
            mem.__triedModels = [...new Set([...(Array.isArray(mem.__triedModels) ? (mem.__triedModels as string[]) : []), model])]
            mem.model_swap = { from: req.model, to: alt, reason: "queued", proven: true }
            return abandon(deps, { common, model, taskId, cost, idemKey, registered, why: `排队超过 ${Math.round(QUEUE_SWITCH_MS / 60000)} 分钟，已取消原单；下一次尝试将改用同价位通道 ${alt}`, cancel: false, cancelled: true, retryable: true, req })
          }
        }
      }
    } else queuedSinceMs = 0

    if (pd?.status === "succeeded") {
      const urls = urlsOf(pd)
      if (urls.length < n) {
        // 成功却缺产物：任务已成功（可能已扣费），绝不取消；保留预留，交调度器按 task_id 核对。
        return fail("submit_unknown", `任务 ${taskId} 已成功但只返回 ${urls.length}/${n} 个产物；保留预算预留，需核对。`, false, { taskId, submitUnknown: true })
      }
      const actual = Number.isFinite(Number(pd.cost_coins)) && pd.cost_coins != null ? Number(pd.cost_coins) : cost
      return finishSuccess(deps, { common, model, kind, n, size, cost, idemKey, taskId, urls, actual, req, referenceVersion, styleVersion, registered })
    }
    if (pd?.status === "failed") {
      const message = String(pd?.error?.message || "generation failed")
      return failedTerminal(deps, { common, model, taskId, cost, idemKey, registered, message, code: SAFETY.test(`${message} ${failSignal}`) ? "safety_blocked" : "provider_error", retryable: !SAFETY.test(message), refunded: Number(pd?.refunded_coins ?? pd?.refund?.coins ?? cost), req })
    }
    if (failSignal && pd?.status !== "succeeded") {
      const withinWindow = queuedSinceMs > 0 && Date.now() - queuedSinceMs <= QUEUE_SWITCH_MS
      if (saturation && withinWindow && Number(mem.__queueSwitches ?? 0) < 1) continue // 可等待的背压
      // 放弃即取消：否则 job 在控面继续排队、日后成功扣费＝孤儿镜。
      const c = pd?.status === "queued" || pd?.status === "running" ? await cancelPlatformJob(req.apiKey, taskId) : { cancelled: true, note: "" }
      const message = formatNodeFailure(pd?.failure_class, pd?.failure_detail ?? failSignal, "生成失败：任务已提交但上游渠道未能执行", "；若已扣款以平台账单为准")
      return c.cancelled
        ? failedTerminal(deps, { common, model, taskId, cost, idemKey, registered, message, code: "provider_error", retryable: true, refunded: cost, req })
        : fail("submit_unknown", `${message}；取消未确认，任务保留，预算预留未释放。`, false, { taskId, submitUnknown: true })
    }
    if (status >= 400 && status !== 404) return fail("submit_unknown", `任务 ${taskId} 轮询 ${status}；任务仍在上游，保留预算预留。`, false, { taskId, submitUnknown: true })
  }
  // 轮询预算耗尽：放弃即取消，取消成功才算可重试，否则保留。
  return abandon(deps, { common, model, taskId, cost, idemKey, registered, why: "生成超时：任务已提交但上游渠道未能执行（供应商并发满或排队超时）；若已扣款以平台账单为准", cancel: true, retryable: true, req })
}

function urlsOf(pd: Record<string, any>): string[] {
  const raw: unknown[] = Array.isArray(pd?.data) ? pd.data.map((d: any) => d?.url) : [pd?.result_url ?? pd?.url]
  return raw
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .map((u) => (/^https?:\/\//.test(u) ? u : `${PLATFORM_BASE}${u.startsWith("/") ? "" : "/"}${u}`))
}

type Terminal = {
  common: LedgerEntryProjectFields; model: string; taskId: string; cost: number; idemKey: string; registered: boolean; req: SubmitGenerationReq
}

async function finishSuccess(
  deps: SubmitGenerationDeps,
  t: Terminal & { kind: "image" | "video"; n: number; size: string; urls: string[]; actual: number; referenceVersion: string; styleVersion: string },
): Promise<SubmitGenerationRes> {
  const { ledger, budget, session } = deps
  budget.settle(t.idemKey, t.actual)
  if (t.taskId && t.registered) {
    try {
      completeGenerationReceipt(t.taskId, "succeeded", t.urls.map((url) => ({ url })), { cost_coins: t.actual })
      // 工程引擎同步消费了结果：observed 记账，免得 drain 把完成当作“待取件”去唤醒模型。图片的 downloaded 由入库后 ackProjectArtifacts 记。
      acknowledgeGeneration(t.taskId, "observed", { consumed_by: "project-engine" })
    } catch (e) { console.error(`[project] receipt complete failed task=${t.taskId}: ${(e as Error).message}`) }
  }
  if (t.taskId && session.sessionTasks) registerWorkflowTask(session, t.taskId, t.req.nodeId, "succeeded", t.urls[0])
  await ledger.write({ ...t.common, event: "completed", model: t.model, cost_coins: t.actual, task_id: t.taskId || undefined, result_url: t.urls[0] })
  return { ok: true, taskId: t.taskId, urls: t.urls, costCoins: t.actual, requestId: t.idemKey, executedModel: t.model }
}

async function failedTerminal(
  deps: SubmitGenerationDeps,
  t: Terminal & { message: string; code: ExecErrorCode; retryable: boolean; refunded: number },
): Promise<SubmitGenerationRes> {
  const { ledger, budget, session } = deps
  budget.release(t.idemKey)
  if (t.registered) {
    try { completeGenerationReceipt(t.taskId, "failed", [], { reason: t.message, cost_coins: 0 }); acknowledgeGeneration(t.taskId, "observed", { consumed_by: "project-engine" }) }
    catch (e) { console.error(`[project] receipt fail-complete failed task=${t.taskId}: ${(e as Error).message}`) }
  }
  if (session.sessionTasks) registerWorkflowTask(session, t.taskId, t.req.nodeId, "failed")
  await ledger.write({ ...t.common, event: "failed", model: t.model, cost_coins: 0, task_id: t.taskId })
  await ledger.write({ ...t.common, event: "refunded", model: t.model, cost_coins: Number.isFinite(t.refunded) ? t.refunded : t.cost, task_id: t.taskId })
  return { ok: false, code: t.code, message: t.message, taskId: t.taskId, retryable: t.retryable }
}

/** 放弃一个在途任务（取消/超时/换道）：取消确认才释放预算并记 refunded；取消未确认＝订单仍可能在跑，保留预留（submit_unknown）。 */
async function abandon(
  deps: SubmitGenerationDeps,
  t: Terminal & { why: string; cancel: boolean; cancelled?: boolean; retryable?: boolean },
): Promise<SubmitGenerationRes> {
  const confirmed = t.cancelled ?? (t.cancel ? (await cancelPlatformJob(t.req.apiKey, t.taskId)).cancelled : false)
  if (!confirmed) return { ok: false, code: "submit_unknown", message: `${t.why}；取消未确认，任务保留，预算预留未释放。`, taskId: t.taskId, submitUnknown: true, retryable: false }
  acceptedTask.delete(t.idemKey)
  const code: ExecErrorCode = t.why === "cancelled" ? "cancelled" : "timeout"
  return failedTerminal(deps, { ...t, message: t.why, code, retryable: code === "cancelled" ? false : t.retryable ?? true, refunded: t.cost })
}
