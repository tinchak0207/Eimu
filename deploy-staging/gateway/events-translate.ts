// events-translate.ts —— 自 index.ts 第二阶段 Wave2 抽取：opencode 事件翻译层——eventSessionId/boundMap/boundSet/isAssistantMessage/parseToolOutput、resolveResultUrl、emitImageDone/emitVideoDone/emitAudioDone、自动制画布（canvasUnitId/readGenerateInput/autoCreateCanvasUnit/attachCanvasTask/emitCanvasResult）、toolErrorPayload、bash deny 归因（bashDenyCache）、findUploadsByBasename/resolveInvisibleUploadPaths/deniedOperationLabel、trackTurnNodeTerminal、workflowStartSchemaHint、handleToolPartUpdate、idle-step breaker（finalizeIdleStep/triggerIdleStepBreaker）。
// 原 index.ts 2708–3618 行，逐行原样搬运（仅顶层宣告加 export 前缀）。
import { readFileSync, readdirSync, statSync, appendFileSync } from "node:fs"
import path from "node:path"
import type { SessionState } from "./types-gateway.ts"
import { PLATFORM_BASE, WORKSPACE_DIR, UPLOADS_DIR, TURN_RETRY_DELAY_MS, IDLE_STEP_ABORT_THRESHOLD, IDLE_STEP_NUDGE, IMAGE_URL_DEDUP_CAP, TOOL_STATUS_DEDUP_CAP } from "./constants-gateway.ts"
// 2026-10-04 W：守卫家族文案（空转止损 nudge／deny 守卫等）书写体镜像已整体拆除——一律简体。
import { sessions, markDirty } from "./sessions-core.ts"
import { opencodeFetch, revertDeadTail } from "./opencode-client.ts"
import { emitToSession, stripStaleTurnTextFromReplay } from "./sse-core.ts"
import { estimateNodeCoins } from "./pricing-gateway.ts"
import { applyCanvasNodeCreated, applyCanvasNodeConnected, applyCanvasNodeUpdated, claimTemplateSlot, canvasResultNodeId } from "./canvas-cascade-state.ts"
import { humanMessageFor, summarizeArgs } from "./humanize-gw.ts"
import { emitQuotaChanged, appendLedgerFor } from "./quota-ledger.ts"
import { emitSessionError } from "./emit-helpers.ts"
import { workflowService } from "./workflow-gw.ts"
import { emitQuestionRequest } from "./questions-gw.ts"
import { maybeEnqueueLyricAlignFromTool } from "./lyric-align-hook.ts"
import { isSuccessfulWorkflowWrite } from "./canvas-write-gate.ts"
import { armWatchdogTimer } from "./timers-gw.ts"
import { TAIL_PAYLOAD_MARKER, ensureGatewayNonce } from "./messages-gw.ts"
// TODO(整合 Wave2)：以下为「仍住 index.ts 且尚未 export」符号的 declare 占位（stage1 记忆「subagent 占位符法」，bun build 不查名可过）。
// 整合阶段于 index.ts 补 export 后换成真 import、删除全部 declare，即完成桥接：
// import { workflowService, emitQuestionRequest, armWatchdogTimer } from "./index.ts"

// ---- opencode event translation -> frontend events ----

// sessionID lives in different properties depending on event type:
//   session.*            -> properties.sessionID
//   message.updated      -> properties.sessionID AND properties.info.sessionID
//   message.part.updated -> properties.part.sessionID (NO properties.sessionID)
//   message.part.delta   -> properties.sessionID
export function eventSessionId(event: any): string | undefined {
  const p = event?.properties
  return p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID
}

export function boundMap<T>(map: Map<string, T>, max: number): void {
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

export function boundSet<T>(set: Set<T>, max: number): void {
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest !== undefined) set.delete(oldest)
}

// Text parts carry no role, so the only way to tell the assistant's reply from
// the user's own prompt is the messageID -> role map built from message.updated.
// Unknown messageID => false: message.updated for a message always precedes its
// parts, so an unknown id means something is off and dropping is the safe side.
export function isAssistantMessage(state: SessionState, messageID: unknown): boolean {
  if (typeof messageID !== "string" || messageID.length === 0) return false
  return state.messageRole.get(messageID) === "assistant"
}

// tool state.output arrives as a JSON string (e.g. an HTTP 401 with ok:false).
// Parse defensively; malformed/absent output yields null so callers fall back to
// ok:false instead of throwing.
export function parseToolOutput(
  output: unknown,
): { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown } | null {
  if (typeof output === "string") {
    try {
      const parsed: unknown = JSON.parse(output)
      if (parsed && typeof parsed === "object") {
        return parsed as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
      }
      return null
    } catch {
      return null
    }
  }
  if (output && typeof output === "object") {
    return output as { ok?: boolean; url?: string; cost_coins?: number; task_id?: string; error?: unknown }
  }
  return null
}

// 2026-10-02：有界巢状成品 URL 提取器（自 translateToolStatus completed 分支抽出，零行为变更；
// subagent.ts 的子代理工具结果路径共用同一提取器）。真实取件工具回的是**巢状**形状——
// video_result_fetch 回 {jobs:[{video_url}]}、last_frame_video_chain 回 {shots:[{mp4_url}]}；
// 旧版只认顶层 url/video_url/audio_url 与字面 videos[]/audios[]，两者都不命中（模型手动查到
// 成品、把 URL 贴进文字时，网关不发卡，用户只看到泡泡里一条纯文字连结）。
// 走访有界（深度 ≤3、节点 ≤200，防病态大 payload），逐层认候选键；判定仍只认既有副档名正则，
// 不因工具名放宽（不猜）。cost_coins 优先用候选项自己那颗物件的，没有才退回顶层（照原写法）。
// 纯函式、无副作用。
export function collectToolOutputMediaUrls(parsed: unknown): {
  video: { url: string; cost_coins?: number; title?: string }[]
  audio: { url: string; cost_coins?: number; title?: string; cover?: string }[]
} {
  const video: { url: string; cost_coins?: number; title?: string }[] = []
  const audio: { url: string; cost_coins?: number; title?: string; cover?: string }[] = []
  if (parsed === null || typeof parsed !== "object") return { video, audio }
  const isVideoUrl = (u: unknown): u is string =>
    typeof u === "string" && u.length > 0 && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)
  const isAudioUrl = (u: unknown): u is string =>
    typeof u === "string" && u.length > 0 && /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?|$)/i.test(u)
  // 候选键：顶层 url/video_url/audio_url 保留，新增 mp4_url/output_url；容器项再收 file_url。
  const CANDIDATE_URL_KEYS = new Set(["url", "video_url", "mp4_url", "output_url", "audio_url", "file_url"])
  const MAX_SCAN_DEPTH = 3
  const MAX_SCAN_NODES = 200
  const vidCands: { url: string; cost_coins?: number; title?: string }[] = []
  const audCands: { url: string; cost_coins?: number; title?: string; cover?: string }[] = []
  let visited = 0
  const walk = (node: unknown, depth: number): void => {
    if (node === null || depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_NODES) return
    if (Array.isArray(node)) {
      visited++
      for (const el of node) {
        if (visited >= MAX_SCAN_NODES) break
        walk(el, depth + 1)
      }
      return
    }
    if (typeof node !== "object") return
    visited++
    const obj = node as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v !== "object") {
        if (CANDIDATE_URL_KEYS.has(k) && typeof v === "string" && v.length > 0) {
          // cost_coins 优先用候选项自己那颗物件的，没有才退回顶层（照现有写法）。
          const cc = typeof obj.cost_coins === "number" ? obj.cost_coins : undefined
          // 真歌名/封面：候选物件自己带 title/cover 才认（缺省不带键，事件形状不变）。
          const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined
          const cover = typeof obj.cover === "string" && obj.cover.trim() ? obj.cover.trim() : undefined
          if (isVideoUrl(v)) vidCands.push({ url: v, cost_coins: cc, ...(title ? { title } : {}) })
          if (isAudioUrl(v)) audCands.push({ url: v, cost_coins: cc, ...(title ? { title } : {}), ...(cover ? { cover } : {}) })
        }
        continue
      }
      walk(v, depth + 1)
    }
  }
  walk(parsed, 0)
  const topCost =
    typeof (parsed as Record<string, unknown>).cost_coins === "number"
      ? ((parsed as Record<string, unknown>).cost_coins as number)
      : undefined
  for (const c of vidCands) video.push({ url: c.url, cost_coins: c.cost_coins ?? topCost, ...(c.title ? { title: c.title } : {}) })
  for (const c of audCands) audio.push({ url: c.url, cost_coins: c.cost_coins ?? topCost, ...(c.title ? { title: c.title } : {}), ...(c.cover ? { cover: c.cover } : {}) })
  return { video, audio }
}

// Shared image.done emission path, deduped per session by url (bounded Set, cap
// 100, evict oldest). Both the opencode tool-result translation and the
// /internal/emit entry point go through here, so the same image can never be
// announced twice to the frontend in one session.
// The platform hands back /v1/images/<id>/result — relative, Bearer-authed, and
// a 302 to a public store.tinchak0207.xyz .webp. An <img src> can send neither a
// host nor an auth header, and the frontend must never hold a backend key, so
// that URL is unrenderable as-is. Resolve the redirect here, server-side, and
// publish the terminal public URL instead.
//
// Verified 2026-08-07: GET the result path with the session key -> 302; Location
// is an unsigned, query-less, publicly readable image/webp (200 without auth).
// Because it carries no signature there is nothing to expire or leak.
export async function resolveResultUrl(rawUrl: string, key: string): Promise<string> {
  if (!rawUrl) return rawUrl
  // Already a public asset URL (poller/tool may hand one over directly).
  if (/^https?:\/\//i.test(rawUrl) && !/\/v1\/images\/[^/]+\/result\/?$/.test(rawUrl)) return rawUrl
  const absolute = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${PLATFORM_BASE}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
  // 平台 /v1/images/{id}/result 预设回 JSON，带 ?format=redirect 才 302 到公开 blob URL。
  const target = /\/v1\/images\/[^/]+\/result\/?$/.test(absolute) ? absolute + "?format=redirect" : absolute
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    })
    const loc = res.headers.get("location")
    if (loc && /^https?:\/\//i.test(loc)) return loc
    // Some deployments may serve the bytes directly instead of redirecting; the
    // absolute URL is then still wrong for the frontend, but it is the best we
    // have and at least names the right host.
    return absolute
  } catch {
    return absolute
  }
}

export async function emitImageDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  recipe?: { prompt?: string; model?: string; size?: string; lora?: string },
): Promise<void> {
  if (!url) return
  // Dedup on the RAW url: the same task resolved twice yields two different
  // public URLs only if the platform regenerates, but the raw form is stable.
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  const publicUrl = await resolveResultUrl(url, state.apiKey)
  emitToSession(state, "image.done", { url: publicUrl, cost_coins, task_id, ...(recipe ? { recipe } : {}) })
  // 自动制画布：task 挂过 unit 就更新该 unit 的结果图片节点。
  if (task_id) {
    emitCanvasResult(state, task_id, publicUrl, cost_coins)
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: "done",
    task_id,
    cost_coins,
    result_url: publicUrl,
  })
  void emitQuotaChanged(state)
}

/**
 * 2026-10-05：把「已经到手的成片类成品」登记进会话任务表。
 * 为什么需要：任务表此前只由 image_* 的 attachCanvasTask 写（task_id）与 poller 的
 * emitCanvasResult 更新；非 image 工具（music_gen / video_upload / run_py）回的是成品
 * URL 而非 task_id，任何路径都不登记 ⇒ 卡片发了（用户看得见）、任务表仍是空的——父模型
 * 呼叫 image_get_result / delivery_assets 一律查不到这批成品。此处是唯一咽喉点：每张
 * video.done / audio.done 卡片都在此登记，主会话/子代理/poller 三条入口自动全覆盖。
 * 键＝task_id 优先，缺 task_id 时用 URL 本身（该键只用于去重覆盖，不出现在
 * /internal/session-tasks 的回传值里）。刻意**不含 image**：子代理会产大量中间关键帧，
 * 一并登记会灌爆清单（与 FIX-A「新图片一律不出卡」的既有不对称一致）。
 */
export function registerSessionArtifact(
  state: SessionState,
  entry: { url: string; kind: string; label?: string; task_id?: string },
): void {
  if (!entry.url) return
  const key = entry.task_id || entry.url
  const prev = state.sessionTasks.get(key)
  state.sessionTasks.set(key, {
    ...(prev ?? {}),
    ...(entry.task_id ? { task_id: entry.task_id } : {}),
    ...(entry.label ? { label: entry.label } : {}),
    status: "succeeded",
    url: entry.url,
    kind: entry.kind,
    submitted_at: prev?.submitted_at ?? Date.now(),
  })
  boundMap(state.sessionTasks, TOOL_STATUS_DEDUP_CAP)
}

export async function emitVideoDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "video" | "film",
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  registerSessionArtifact(state, { url, kind: media_kind === "film" ? "film" : "video", task_id })
  // 影片/成片 content 已是绝对公开 URL，无需 resolveResultUrl（它只重写 /v1/images/.../result 形态）。
  emitToSession(state, "video.done", { url, cost_coins, task_id, media_kind })
  void appendLedgerFor(state, {
    kind: "video",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

/** audio.done 的可选元数据：真歌名 / 封面 / 歌词对齐状态。
 *  全部缺席时事件与改动前逐位元相同（老前端不受影响）；缺哪个不带哪个。 */
export interface AudioDoneMeta {
  title?: string
  cover?: string
  lyric_status?: string
}

export async function emitAudioDone(
  state: SessionState,
  url: string,
  cost_coins?: number,
  task_id?: string,
  media_kind?: "audio",
  meta?: AudioDoneMeta,
): Promise<void> {
  if (!url) return
  if (state.announcedUrls.has(url)) return
  state.announcedUrls.add(url)
  boundSet(state.announcedUrls, IMAGE_URL_DEDUP_CAP)
  registerSessionArtifact(state, { url, kind: "audio", task_id })
  // 音频 content 已是绝对公开 URL（平台 uploads），无需 resolveResultUrl（它只重写 /v1/images/.../result 形态）。
  // 可选元数据只带非空值：缺参数＝事件形状一字不变（向后兼容）。
  emitToSession(state, "audio.done", {
    url,
    cost_coins,
    task_id,
    media_kind,
    ...(meta?.title ? { title: meta.title } : {}),
    ...(meta?.cover ? { cover: meta.cover } : {}),
    ...(meta?.lyric_status ? { lyric_status: meta.lyric_status } : {}),
  })
  void appendLedgerFor(state, {
    kind: "audio",
    event: "done",
    task_id,
    cost_coins,
    result_url: url,
  })
  void emitQuotaChanged(state)
}

// ---- 自动制画布（Auto Canvas Builder） ----
//
// 暴君立场：deepseek 不「思考」画布的事。它只提交生图/改图请求，
// gateway 拦截每个 image_* 工具的参数与结果，自动在画布上重现：
//   文本节点(prompt) → 配置节点(model/size/n) → [执行] → 图片节点(结果)
// 每次请求建立一个「画布单元」(unit)，unit 内节点用相同 unit_id 前缀，
// 前端以 unit_id 关联成组；task_id 挂在同一 unit 上，完成时更新该组。

export function canvasUnitId(): string {
  return `cu_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
}

export function summarizeCanvasTitle(model: string, prompt: string): string {
  const m = model || "生成"
  const p = prompt.trim().slice(0, 18)
  return p ? `${m} · ${p}${prompt.trim().length > 18 ? "…" : ""}` : m
}

// 从工具 input 抽取生成参数（deepseek 送哪栏就用哪栏，缺失给安全预设）。
export function readGenerateInput(input: unknown): {
  prompt: string
  model: string
  size: string
  n: number
  kind: string
  quality?: string
  image?: string // edit/upscale 的来源 mediaId/URL
  lora?: string // P1-E1：聊天「存为资产」带真 LoRA（loraModelVersionIds 首位）
} {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const prompt =
    typeof obj.prompt === "string"
      ? obj.prompt
      : typeof obj.content === "string"
        ? obj.content
        : ""
  const model = typeof obj.model === "string" && obj.model ? obj.model : "gpt-image-2"
  const size = typeof obj.size === "string" && obj.size ? obj.size : "1024x1024"
  const nNum = typeof obj.n === "number" ? obj.n : typeof obj.count === "number" ? obj.count : 1
  const n = Number.isFinite(nNum) ? Math.max(1, Math.min(15, Math.floor(nNum))) : 1
  const kind = typeof obj.kind === "string" && obj.kind === "video" ? "video" : "image"
  const quality = typeof obj.quality === "string" ? obj.quality : undefined
  const image = typeof obj.image === "string" && obj.image ? obj.image : undefined
  const loraRaw = obj.loraModelVersionIds ?? obj.lora ?? obj.lora_id
  const lora =
    typeof loraRaw === "string" && loraRaw
      ? loraRaw
      : Array.isArray(loraRaw) && loraRaw.length > 0
        ? String(loraRaw[0])
        : undefined
  return { prompt, model, size, n, kind, quality, image, lora }
}

// 建立一个画布单元并 emit 节点/连线事件。回传 unit id。
// S4：cost_hint 需查平台目录（async），函数签名改 async；两处呼叫点
//（tool status running / completed 补发）均改 await，行为语义不变。
// 自动制画布只给「真的会出图」的工具（2026-09-29 e2e 像素实锤）：原本 startsWith("image_")
// 让 image_quote／image_get_result／image_upload 也各铺一组「(未填写内容) + gpt-image-2 · 1024x1024
// 待处理」空节点，永远不会跑，还一路带到用户之后开的新对话画布上。
const AUTO_CANVAS_TOOLS = new Set(["image_generate", "image_edit", "image_upscale"])

export async function autoCreateCanvasUnit(
  state: SessionState,
  toolName: string,
  input: unknown,
  callID: string,
): Promise<string> {
  const cfg = readGenerateInput(input)
  const unitId = canvasUnitId()

  // 计画卡：一句话让暴君知道他会被怎么对待。
  const planLabel =
    toolName === "image_edit"
      ? "改图（图生图）"
      : toolName === "image_upscale"
        ? "放大"
        : toolName === "image_generate"
          ? cfg.kind === "video"
            ? "生影片"
            : "生图"
          : "生成"
  // S4 规格2（2026-08-27）：cost_hint 从 null 改为真实估算（币）。估算链：
  // ① 工具 input 自带 cost_coins（上游工具已按目录算好，最准）→
  // ② 平台目录单价 × 数量（image）/ 档位价 5/10 币每秒（video，R5-C）→
  // ③ 两者都取不到保持 null（不许编数）。
  let costHint: number | null = null
  if (input && typeof input === "object") {
    const inline = (input as Record<string, unknown>).cost_coins
    if (typeof inline === "number" && Number.isFinite(inline)) costHint = inline
    else if (typeof inline === "string" && inline && Number.isFinite(Number(inline))) costHint = Number(inline)
  }
  if (costHint === null) {
    const inputObj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const estimated = await estimateNodeCoins(
      {
        kind: cfg.kind,
        metadata: {
          model: cfg.model,
          count: cfg.n,
          ...(cfg.quality ? { quality: cfg.quality } : {}),
          ...(typeof inputObj.duration_seconds === "number" ? { duration_seconds: inputObj.duration_seconds } : {}),
        },
      },
      state.apiKey,
    )
    if (estimated !== null) costHint = estimated
  }
  emitToSession(state, "canvas.plan", {
    unit_id: unitId,
    tool: toolName,
    label: planLabel,
    prompt: cfg.prompt,
    model: cfg.model,
    size: cfg.size,
    count: cfg.n,
    kind: cfg.kind,
    source_image: cfg.image ?? null,
    cost_hint: costHint,
  })

  // 模板权威（2026-10-02）：画布上有用户配的模板且还有同类型空位 → 这次生成落在模板节点，不另铺 cu_* 单元。
  if (toolName === "image_generate") {
    const slot = claimTemplateSlot(state.sessionId, unitId, cfg.kind === "video" ? "video" : "image")
    if (slot) {
      const patch = { status: "loading", prompt: cfg.prompt, model: cfg.model, size: cfg.size, count: cfg.n }
      emitToSession(state, "canvas.node.updated", { unit_id: unitId, node_id: slot.id, patch })
      applyCanvasNodeUpdated(state.sessionId, { node_id: slot.id, patch })
      console.log(`[gateway] template_guard: generation bound to template slot ${slot.id} (skip cu_ unit) session=${state.sessionId} call=${callID}`)
      state.canvasUnitByCall.set(callID, unitId)
      boundMap(state.canvasUnitByCall, TOOL_STATUS_DEDUP_CAP)
      markDirty(state)
      return unitId
    }
  }

  // 文本节点：承载 prompt（source_image 存在时并���提示，编辑语义）。
  const textNode = {
    id: `${unitId}-text`,
    type: "text",
    title: summarizeCanvasTitle(cfg.model, cfg.prompt),
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      content: cfg.prompt,
      status: "idle",
      source_image: cfg.image ?? (toolName === "image_edit" || toolName === "image_upscale" ? cfg.image ?? null : null),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: textNode })
  applyCanvasNodeCreated(state.sessionId, { node: textNode })

  // 配置节点：model/size/n/kind。
  const configNode = {
    id: `${unitId}-config`,
    type: "config",
    title: `${cfg.model} · ${cfg.size}`,
    position: { x: 0, y: 0 },
    width: 440,
    height: 240,
    metadata: {
      content: "",
      status: "idle",
      model: cfg.model,
      size: cfg.size,
      count: cfg.n,
      kind: cfg.kind,
      ...(cfg.quality ? { quality: cfg.quality } : {}),
    },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: configNode })
  applyCanvasNodeCreated(state.sessionId, { node: configNode })

  // 连线：文本 → 配置。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id },
  })
  applyCanvasNodeConnected(state.sessionId, { connection: { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id } })

  // 预留图片节点（结果落地时更新同一节点）。
  const imageNode = {
    id: `${unitId}-image`,
    type: "image",
    title: "生成中…",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: "", status: "loading" },
  }
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: imageNode, target_kind: "result" })
  applyCanvasNodeCreated(state.sessionId, { node: imageNode })
  // 连线：配置 → 图片。
  emitToSession(state, "canvas.node.connected", {
    unit_id: unitId,
    connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id },
    target_kind: "result",
  })
  applyCanvasNodeConnected(state.sessionId, { connection: { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: imageNode.id } })

  state.canvasUnitByCall.set(callID, unitId)
  boundMap(state.canvasUnitByCall, TOOL_STATUS_DEDUP_CAP)
  markDirty(state) // 画布快照已套用：随 session 防抖落盘，重启后可恢复
  return unitId
}

// 为已建立的 unit 挂上 task_id（submit 完成阶段），供结果更新。
export function attachCanvasTask(state: SessionState, callID: string, taskId: string, unitId?: string): void {
  const target = unitId ?? state.canvasUnitByCall.get(callID)
  // 0831：本轮任务登记（权威 task_id 来源 + 压缩在途闸依据）。置于 unit 判断之前：
  // 即使画布 unit 尚未就绪（autoCreateCanvasUnit 异步），已提交的 task 也必须被追踪，
  // 否则在途闸漏放 → 压缩照样踩中摘要 tool-call 死锁。
  if (taskId) {
    state.sessionTasks.set(taskId, { task_id: taskId, status: "queued", submitted_at: Date.now() })
  }
  if (!target || !taskId) return
  state.canvasUnitByTask.set(taskId, target)
  boundMap(state.canvasUnitByTask, TOOL_STATUS_DEDUP_CAP)
}

// task_id → unit 存在时，emit 完成事件；返回命中与否。
export function emitCanvasResult(
  state: SessionState,
  taskId: string,
  url: string,
  cost_coins?: number,
): boolean {
  // 0831：任务终态登记（成功）。置于 unit 判断前：无画布 unit 也要如实记 succeeded+url。
  const t = state.sessionTasks.get(taskId)
  if (t) {
    t.status = "succeeded"
    t.url = url
  }
  const unitId = state.canvasUnitByTask.get(taskId)
  if (!unitId) return false
  const patch = { status: "success", content: url, ...(typeof cost_coins === "number" ? { cost_coins } : {}) }
  emitToSession(state, "canvas.node.updated", {
    unit_id: unitId,
    node_id: canvasResultNodeId(state.sessionId, unitId),
    patch,
    url,
    cost_coins,
  })
  applyCanvasNodeUpdated(state.sessionId, { node_id: canvasResultNodeId(state.sessionId, unitId), patch })
  return true
}

/**
 * S2a：从结构化工具输出抽失败载荷，组出三栏位错误合同
 * {code, message, human_message}。兼容三种输入形态：
 *  - 工具层 fail()：{error:{code,hint}}
 *  - gateway jsonError 透传：{error:{message,type,code}}（code 可能被工具层
 *    塞成物件——workflow_rerun 旧裂缝的实际形态）
 *  - 纯字串/无 error：fallback message。
 */
export function toolErrorPayload(
  parsed: { error?: unknown } | null,
  fallbackMessage: string,
): { code: string; message: string; human_message: string } {
  let code = "tool_failed"
  let message = fallbackMessage
  const e = parsed && typeof parsed === "object" ? parsed.error : null
  if (typeof e === "string" && e) {
    message = e
  } else if (e && typeof e === "object") {
    const o = e as { code?: unknown; message?: unknown; hint?: unknown }
    if (o.code && typeof o.code === "object") {
      const inner = o.code as { message?: unknown; code?: unknown }
      if (typeof inner.message === "string" && inner.message) message = inner.message
      if (typeof inner.code === "string" && inner.code) code = inner.code
    } else {
      if (typeof o.message === "string" && o.message) message = o.message
      else if (typeof o.hint === "string" && o.hint) message = o.hint
      if (typeof o.code === "string" && o.code) code = o.code
    }
  }
  return { code, message, human_message: humanMessageFor(message, code) }
}

/**
 * 取第一个非空字串。本机档案授权的附带栏位（root／reason）可能落在顶层或 error 内
 * （不同上游版本形状不同），统一收敛。
 */
function firstNonEmptyString(...values: unknown[]): string {
  for (const v of values) if (typeof v === "string" && v.length > 0) return v
  return ""
}

// ── R8-B 工单 #2（2026-08-29）：拒单报因 ──
// R8 实锤：grep BRE 交替 \| 撞 deny 的 *|* 被拒，报错不说命中哪条规则，
// 模型花 78s 人肉逆向权限表。修法：被拒 bash 命令对 permission.bash 的
// deny glob 求匹配，error 帧附 matched_pattern + 一句替代写法。
export let bashDenyCache: { at: number; patterns: string[] } | null = null

/** 从 opencode.json 原文解析 deny glob（纯函式；载入路径与测试共用同一解析，避免测试用假表）。 */
export function parseBashDenyPatterns(raw: string): string[] {
  try {
    const cfg = JSON.parse(raw) as { permission?: { bash?: Record<string, string> } }
    return Object.entries(cfg.permission?.bash ?? {})
      .filter(([, v]) => v === "deny")
      .map(([k]) => k)
  } catch {
    return []
  }
}

export function loadBashDenyPatterns(): string[] {
  const now = Date.now()
  if (bashDenyCache && now - bashDenyCache.at < 60_000) return bashDenyCache.patterns
  let patterns: string[] = []
  try {
    // 路径可 env 覆写（测试喂真实表；生产不设即为既有 WORKSPACE_DIR 路径）。
    const cfgPath = process.env.BASH_DENY_CONFIG_PATH || path.join(WORKSPACE_DIR, ".opencode", "opencode.json")
    const raw = readFileSync(cfgPath, "utf-8")
    patterns = parseBashDenyPatterns(raw)
  } catch {
    // 配置读不到就不归因——报错退回短句，不阻塞工具错误透传
  }
  bashDenyCache = { at: now, patterns }
  // 需求2（2026-10-02）：启动／每次 60s 重载后做一次被遮蔽规则侦测并以结构化日志告警。
  logShadowedBashDenyRules(patterns)
  return patterns
}

/** deny glob → RegExp（* 通配任意字元含换行，其余按字面量）。 */
export function denyGlobToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*")
  return new RegExp(`^${body}$`)
}

/** 替代写法提示（按命中规则类型给一句可操作的话；出站文案一律简体，书写体镜像已拆）。 */
export function denyHintFor(pattern: string): string {
  if (pattern === "*|*")
    return "BRE 交替 \\| 含禁止符 |。改用宽匹配后自行筛选（如 grep -n \"第.*章\"），或改用 run_py 工具写脚本处理"
  if (pattern === "*&&*" || pattern === "*||*" || pattern === "*;*")
    return "执行环境只允许单条命令。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  if (pattern === "*>*" || pattern === "*>>*" || pattern === "*<*")
    return "执行环境禁止重定向/输入改向。拆成多次单命令调用，或改用 run_py 工具写脚本一次完成"
  return "请改用允许的命令（ls/cat/grep/sed -n/awk/find 等），或改用 run_py 工具写脚本"
}

/** 对 deny glob 求匹配；命中多条时取最具体的（非 * 字面量最长者），跳过全捕 *。
 *  patterns 可注入（测试直接喂真实 opencode.json 解析出的表）；省略时走 60s 快取载入。 */
export function bashDenyAttribution(cmd: string, patterns?: string[]): { pattern: string; hint: string } | null {
  if (!cmd) return null
  let best: { pattern: string; score: number } | null = null
  for (const p of patterns ?? loadBashDenyPatterns()) {
    if (p === "*") continue // 全捕规则不报因（零信息量）
    if (!denyGlobToRegExp(p).test(cmd)) continue
    const score = p.replace(/\*/g, "").length
    if (!best || score > best.score) best = { pattern: p, score }
  }
  if (!best) return null
  return { pattern: best.pattern, hint: denyHintFor(best.pattern) }
}

// ── 需求1（2026-10-02）：拒绝决策的 provenance ──
// 设计取自 Claude Code PermissionDecisionReason（带型别联合 rule/mode/hook/classifier/
// sandboxOverride/safetyCheck，见 teacher-repo src/types/permissions.ts:271-324）；
// **未复制任何程式码**，只取其「拒绝原因须为结构化带型别物件，而非自由字串」的设计。
// 向下相容：既有 error 帧栏位 matched_pattern / hint 语义一字不改，只新增 deny_provenance。
export type DenySource = "deny_glob" | "path_gate" | "sandbox_unavailable" | "unknown"

export interface DenyProvenance {
  /** 拒绝成因类别。当前网关此分支只会真正产生 deny_glob（与 unknown）；其余为其他层预留。 */
  source: DenySource
  /** 命中的 deny glob 原文；无明确归因时为 null。 */
  pattern: string | null
  /** 机器可读的结构化理由。 */
  reason: string
  /** 给模型的可操作替代写法；无则 null。 */
  hint: string | null
}

/** 依 opencode 拒绝讯息判定成因类别（为 path gate / sandbox 层预留同一 provenance 型别）。 */
export function classifyDenySource(message: string): DenySource {
  if (/\bsandbox\b|bwrap|operation not permitted/i.test(message)) return "sandbox_unavailable"
  if (/(^|[^A-Za-z])path([^A-Za-z]|$)|路径|不可见|outside the workspace/i.test(message)) return "path_gate"
  if (/specified a rule which prevents|relevant rules/i.test(message)) return "deny_glob"
  return "unknown"
}

/** 拒绝决策的结构化 provenance；与 bashDenyAttribution 同源，不改变其结果。 */
export function bashDenyProvenance(cmd: string, patterns?: string[], message?: string): DenyProvenance | null {
  const cls = message ? classifyDenySource(message) : "deny_glob"
  const att = bashDenyAttribution(cmd, patterns)
  if (!att) {
    if (!cmd) return null
    return {
      source: cls === "deny_glob" ? "unknown" : cls,
      pattern: null,
      reason: "bash 被拒但未匹配到 deny 表任何具体 glob（表可能已漂移）",
      hint: denyHintFor(""),
    }
  }
  return {
    source: cls === "unknown" ? "deny_glob" : cls,
    pattern: att.pattern,
    reason: `bash 命中${cls === "deny_glob" ? " deny 表规则" : cls} ${att.pattern}`,
    hint: att.hint,
  }
}

// 持久稽核：沿用既有日志落点（gateway stdout → journald）＋ append-only jsonl；
// 落盘失败一律 fail-open，绝不阻塞拒单。路径可用 env 覆写（测试注入 tmp 档）。
export const DENY_AUDIT_PATH = process.env.DENY_AUDIT_PATH || "/opt/agent-harness/deny-audit.jsonl"

export interface DenyAuditRecord {
  ts: string
  session_id: string
  call_id: string
  tool: string
  operation: string
  source: DenySource
  pattern: string | null
  reason: string
  hint: string | null
}

export function appendDenyAudit(
  record: DenyAuditRecord,
  // 预设路径于呼叫时解析（env 可于执行期覆写，供测试把稽核导入 tmp；生产不设＝DENY_AUDIT_PATH）。
  auditPath: string = process.env.DENY_AUDIT_PATH ?? DENY_AUDIT_PATH,
): void {
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    return
  }
  console.log(`[gateway] deny-audit ${line}`)
  if (auditPath === "") return
  try {
    appendFileSync(auditPath, line + "\n")
  } catch {
    // 稽核落盘失败不得阻塞拒单
  }
}

// ── 需求2（2026-10-02）：被遮蔽规则侦测 ──
// 设计取自 Claude Code shadowedRuleDetection（侦测 tool-wide deny/ask 使更具体的 allow
// 永不生效，见 teacher-repo src/utils/permissions/shadowedRuleDetection.ts:193-234）；
// **未复制任何程式码**。
//
// 语义界定（现场证据 opencode-runtime/opencode.json）：我方 permission.bash 是 deny-only
// 表＝ 44 条 deny ＋ 唯一一条 tool-wide "*": "allow"。**没有 allow/ask 分层**，故 teacher 的
// 缺陷类（specific allow 被 tool-wide deny 遮蔽 ⇒ 有人意图放行却被永久挡住）在此形态下
// **真空不成立**：不 deny 即 allow，不存在「意图放行的 allow 规则」可被遮蔽。硬套 allow/deny
// 对抗模型只会做出无意义的假缺陷。可计算的真实类比有两类（皆为 lint 级，非安全缺陷）：
//   (a) subsumed：更窄的 deny 规则其匹配集是某更宽 deny 规则的子集 ⇒ 该规则对拒绝覆盖面
//       零贡献（冗余），删除不改变行为；
//   (b) pathological_breadth：匹配面病态过宽的样式（`*` 全捕，或 `*x*` 内容级子串扫描）——
//       这是 08-29 橘猫事件的真实病灶（`*curl*` 扫描封死免费池）。
export interface ShadowedRule {
  rule: string
  kind: "subsumed" | "pathological_breadth"
  /** 遮蔽它的更宽规则（subsumed 时非 null；过宽类为 null）。 */
  shadowedBy: string | null
  reason: string
}

/** glob 首个 `*` 之前的字面前缀（首字元即 * 时为 ""）。 */
function globLeadLiteral(glob: string): string {
  const i = glob.indexOf("*")
  return i < 0 ? glob : glob.slice(0, i)
}

/** 病态过宽判定（保守门槛，避免把常规短前缀误报成缺陷）。 */
function pathologicalBreadth(glob: string): string | null {
  if (glob === "*") return "全捕规则（*）：覆盖全部命令，等于禁用 bash 工具"
  if (glob.length > 2 && glob.startsWith("*") && glob.endsWith("*")) {
    return `内容级子串扫描（${glob}）：任何命令参数含该子串即被拒——08-29 橘猫事件的病灶形态`
  }
  if (/^.\*$/.test(glob)) return `前缀仅 1 个字元的宽匹配（${glob}）：覆盖面极大，易误伤合法命令`
  return null
}

/**
 * 声音式（不误报）子集判定：规则 r 的匹配集 ⊆ 规则 b 的匹配集。
 * 仅对「单尾星」宽规则（b = P*，匹配一切以 P 开头的字串）做证明；其余形态一律回 false
 * （宁可漏报不可误报——lint 警告不能造假缺陷）。
 */
function isPatternSubset(r: string, b: string): boolean {
  if (r === b) return false
  if (b === "*") return true
  if (!b.endsWith("*") || b.indexOf("*") !== b.length - 1) return false
  const prefix = b.slice(0, -1)
  if (prefix === "") return true
  if (r.startsWith("*")) return false // 首字元即 * ⇒ 可匹配不以 prefix 开头的字串，无法证明
  return globLeadLiteral(r).startsWith(prefix)
}

/**
 * 侦测 deny 表中被遮蔽／病态过宽的规则。纯函式，供载入路径与测试共用。
 * 回传顺序：先全部 pathological_breadth，再全部 subsumed（各自按输入序）。
 */
export function detectShadowedBashDenyRules(patterns: string[]): ShadowedRule[] {
  const uniq = [...new Set(patterns)]
  const out: ShadowedRule[] = []
  for (const p of uniq) {
    const verdict = pathologicalBreadth(p)
    if (verdict) out.push({ rule: p, kind: "pathological_breadth", shadowedBy: null, reason: verdict })
  }
  for (const p of uniq) {
    let best: string | null = null
    for (const q of uniq) {
      if (q === p || !isPatternSubset(p, q)) continue
      if (best === null) {
        best = q
        continue
      }
      const bq = globLeadLiteral(q).length
      const bb = globLeadLiteral(best).length
      if (bq < bb || (bq === bb && q < best)) best = q
    }
    if (best !== null) {
      out.push({
        rule: p,
        kind: "subsumed",
        shadowedBy: best,
        reason: `规则 ${p} 的匹配集是 ${best} 的子集，对拒绝覆盖面零贡献（冗余规则，删除不改变行为）`,
      })
    }
  }
  return out
}

/** 载入／重载时呼叫：结构化日志告警；回传侦测结果供测试与呼叫方使用。 */
export function logShadowedBashDenyRules(patterns: string[]): ShadowedRule[] {
  const shadowed = detectShadowedBashDenyRules(patterns)
  if (patterns.length === 0) return shadowed // 表读不到：不报「0 findings」误导（与 parse 失败区分）
  if (shadowed.length === 0) {
    console.log(
      "[gateway] shadowed-deny scan: 0 findings（deny-only 表无 allow 层，teacher 的 allow-shadowed 缺陷类真空）",
    )
    return shadowed
  }
  for (const s of shadowed) {
    console.log(
      `[gateway] shadowed-deny ${s.kind} rule=${JSON.stringify(s.rule)} shadowed_by=${JSON.stringify(
        s.shadowedBy,
      )} reason=${s.reason}`,
    )
  }
  return shadowed
}

/** R8-B 工单 #5：uploads 目录递归找同名文件，取 mtime 最新者。 */
export function findUploadsByBasename(basename: string): string | null {
  let found: string | null = null
  let foundMtime = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean }>
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      if (e.name === basename || e.name.toLowerCase() === basename.toLowerCase()) {
        try {
          const m = statSync(p).mtimeMs
          if (m > foundMtime) {
            foundMtime = m
            found = p
          }
        } catch {
          // stat 失败的文件跳过
        }
      }
    }
  }
  walk(UPLOADS_DIR, 0)
  return found
}

// R8-B 工单 #5：消息文本里的绝对路径 token（≥2 段，含 /tmp/daming-book.pdf 形态）。
export const ABS_PATH_RE = /\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g

/** R8-B 工单 #5：用户给的路径在沙箱视图（workspace）不存在但 uploads/** 有同名
 *  文件 → 返回系统注文本（拼进送模型的 message 前面）；解析不到回 null。 */
export function resolveInvisibleUploadPaths(content: string): string | null {
  const candidates = new Set(content.match(ABS_PATH_RE) ?? [])
  const notes: string[] = []
  for (const raw of candidates) {
    const p = raw.replace(/[.,;:!?)）】"'，。；：]+$/, "")
    if (p.startsWith(WORKSPACE_DIR)) continue // 沙箱视图内本来就可见
    const basename = p.split("/").pop() ?? ""
    if (!basename) continue
    const hit = findUploadsByBasename(basename)
    if (hit) notes.push(`[系统] 路径 ${p} 执行环境不可见，同名文件已解析到 ${hit}，后续操作请使用解析后的路径`)
  }
  return notes.length > 0 ? notes.join("\n") : null
}

/** R4-A S10：被拒操作的可读标签——bash 取命令前缀（截 80 字符），其他工具取工具名。 */
export function deniedOperationLabel(toolName: string, input: unknown): string {
  let op = ""
  if (input && typeof input === "object") {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === "string" && cmd.trim()) {
      const firstLine = cmd.trim().split("\n")[0] ?? ""
      op = `bash 命令 "${firstLine.slice(0, 80)}${firstLine.length > 80 ? "…" : ""}"`
    }
  }
  if (!op) op = toolName || "未知操作"
  return `（被拒操作：${op}）`
}

/** R4-A S8：采集本 turn 内到达终态的节点（emitToSession 中央出口调用）。 */
export function trackTurnNodeTerminal(state: SessionState, data: unknown): void {
  const d = (data ?? {}) as {
    node_id?: unknown
    nodeId?: unknown
    id?: unknown
    patch?: { status?: unknown }
    status?: unknown
  }
  const nodeId =
    typeof d.node_id === "string" ? d.node_id : typeof d.nodeId === "string" ? d.nodeId : typeof d.id === "string" ? d.id : ""
  const status = typeof d.patch?.status === "string" ? d.patch.status : typeof d.status === "string" ? d.status : ""
  if (!nodeId || (status !== "success" && status !== "error")) return
  if (!state.turnTerminalNodes) state.turnTerminalNodes = []
  const key = `${nodeId}:${status}`
  if (state.turnTerminalNodes.some((n) => `${n.id}:${n.status}` === key)) return
  state.turnTerminalNodes.push({ id: nodeId, status })
  if (state.turnTerminalNodes.length > 64) state.turnTerminalNodes.shift()
}

/** 修 4（2026-09-01）：workflow_start 载荷形状示例。opencode 工具层把 gateway
 *  400 丢成裸「tool failed」，模型只能拿用户的币和时间盲猜形状（实测连错 2 张
 *  失败卡才中）。从模板注册表取该模板 text role 的真实栏位，回一段可照抄的
 *  紧凑 JSON 示例；注册表不可得时用 single_video 的 canonical 形状兜底。 */
export function workflowStartSchemaHint(input: unknown): string {
  const templateId =
    input && typeof input === "object" && typeof (input as { template_id?: unknown }).template_id === "string"
      ? (input as { template_id: string }).template_id
      : ""
  const roles: string[] = []
  if (templateId) {
    try {
      const tpl = (workflowService.templates() as Array<{ id?: unknown; nodes?: { role?: unknown; kind?: unknown }[] }>).find(
        (t) => t.id === templateId,
      )
      for (const n of tpl?.nodes ?? []) {
        if (n.kind === "text" && typeof n.role === "string") roles.push(n.role)
      }
    } catch {
      // 注册表不可得：走通用示例兜底
    }
  }
  const contentShape = roles.length
    ? JSON.stringify(Object.fromEntries(roles.map((r) => [r, { content: "…" }])))
    : '{"shot":{"content":"…"}}'
  return (
    `workflow_start 载荷形状不对（参数被拒，不是上游故障）。content 必须按「文本角色名 → {content: 提示词文本}」组织` +
    `${templateId ? `（模板 ${templateId} 的文本角色：${roles.length ? roles.join("、") : "未知"}）` : ""}。` +
    `照此形状重试一次即可：{"template_id":"${templateId || "single_video"}","content":${contentShape}}`
  )
}

export function handleToolPartUpdate(state: SessionState, part: any): void {
  const toolName = typeof part?.tool === "string" ? part.tool : ""
  const callId = typeof part?.callID === "string" ? part.callID : ""
  const st = part?.state
  if (!st || typeof st !== "object") return
  const status = typeof st.status === "string" ? st.status : ""
  if (!callId || !status) return

  // Dedup by callID + status so a repeated identical status does not re-emit.
  const dedupKey = `${callId}:${status}`
  if (state.toolStatusSeen.has(dedupKey)) return
  state.toolStatusSeen.add(dedupKey)
  boundSet(state.toolStatusSeen, TOOL_STATUS_DEDUP_CAP)

  // R2-A 看门狗：工具真实开跑 = turn 已启动，喂狗。（question 工具的
  // pending 也要算——它在等用户回答，turn 显然活著。）
  if (status === "pending" || status === "running" || status === "completed") {
    state.turnToolStarted = true
  }

if (status === "pending" || status === "running") {
    // question is not a generic running tool. The agent is blocked on a
    // que_* request; emit question.request so the frontend can reply.
    if (toolName === "question") {
      void emitQuestionRequest(state, callId, st.input)
      return
    }
    // 只在拿到工具输入后才发 invoke。opencode 的 pending 状态常只有
    // {status:"pending"} 而没有 input；等 running（input 完整）再发，
    // 前端工具卡才显示得出「在做什么」，不是黑盒。
    const argsSummary = summarizeArgs(st.input)
    if (state.toolInvokeSeen.has(callId)) return
    if (!argsSummary && status === "pending") return
    state.toolInvokeSeen.add(callId)
    boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
    emitToSession(state, "tool.invoke", {
      tool: toolName,
      args_summary: argsSummary,
    })
    // 自动制画布：image_* 工具首次建立画布单元。deepseek 完全不知道——
    // 它只是提交请求，gateway 拦截参数自动建文本/配置/图片节点。
    if (AUTO_CANVAS_TOOLS.has(toolName) && !state.canvasUnitByCall.has(callId) && st.input != null) {
      void autoCreateCanvasUnit(state, toolName, st.input, callId)
    }
  } else if (status === "completed") {
    // 若 running 阶段因 input 缺失没发过 invoke，这里补发一次（completed 的
    // input 一定完整），确保前端工具卡必定有说明、不黑盒。
    if (!state.toolInvokeSeen.has(callId) && st.input != null) {
      state.toolInvokeSeen.add(callId)
      boundSet(state.toolInvokeSeen, TOOL_STATUS_DEDUP_CAP)
      emitToSession(state, "tool.invoke", {
        tool: toolName,
        args_summary: summarizeArgs(st.input),
      })
      // 同上：跑到 completed 才见到 input 的工具（理论上不会，但保险起见）。
      if (AUTO_CANVAS_TOOLS.has(toolName) && !state.canvasUnitByCall.has(callId)) {
        void autoCreateCanvasUnit(state, toolName, st.input, callId)
      }
    }
    const parsed = parseToolOutput(st.output)
    // 只认明确带 ok 栏位的结构化输出；没有 ok 栏位（原生工具文字输出）一律视为成功。
    const hasOkFlag = parsed !== null && typeof parsed === "object" && typeof (parsed as { ok?: unknown }).ok === "boolean"
    // 缺陷 A（2026-10-04 本机档案桥，真壳实锤）：未授权路径的读取**不是成功**。冻结契约下
    // gateway 对 needs_authorization 回 HTTP 200，local_files 把它包成
    // {ok:true, action_required:"authorize_local_files", root, reason, options}（授权发生在对话里）。
    // 旧码只看 bool ok ⇒ 折成 ok:true 并丢掉 action_required／options／root ⇒ 前端卡片显示
    // 「完成」（实锤：助手文字「读取被拦下了」而卡片「读取本机文件 完成」）。此处把它正规化为
    // needs_authorization，并把 code／root／reason／options 原样带进 SSE。装置桥原生
    // {ok:false,error:{code:"needs_authorization",…}} 亦收敛到同一条路。
    const parsedRecord = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    const parsedErrorRecord =
      parsedRecord && parsedRecord.error && typeof parsedRecord.error === "object"
        ? (parsedRecord.error as Record<string, unknown>)
        : null
    const authActionRequired =
      typeof parsedRecord?.action_required === "string" ? (parsedRecord.action_required as string) : ""
    const needsAuthorization =
      authActionRequired === "authorize_local_files" ||
      parsedErrorRecord?.code === "needs_authorization" ||
      parsedRecord?.code === "needs_authorization"
    const authRoot = firstNonEmptyString(parsedRecord?.root, parsedRecord?.auth_root, parsedErrorRecord?.root)
    const authReason = firstNonEmptyString(parsedRecord?.reason, parsedRecord?.auth_reason, parsedErrorRecord?.reason)
    const authOptionsRaw = parsedRecord?.options ?? parsedRecord?.auth_options ?? parsedErrorRecord?.options
    const ok = needsAuthorization ? false : hasOkFlag ? (parsed as { ok: boolean }).ok === true : true
    // 2026-10-11 修画布：记账真写穿（非 dry_run），供 session.idle 收盘硬闸。
    if (toolName === "workflow_write" && isSuccessfulWorkflowWrite(parsed, ok)) {
      state.workflowWriteSucceeded = true
      markDirty(state)
      console.log(`[gateway] canvas-write-gate: workflow_write succeeded — session=${state.sessionId}`)
    }
    // S2a（2026-08-27）：ok 语义收紧为「已执行且成功」。失败必落
    // {ok:false, error:{code,message,human_message}}——human_message 中文短句必填。
    // 旧代码非 image_ 工具无条件回 ok:true，导致 workflow_rerun_node 等失败工具
    // 在 SSE 上伪成功（评测 event 687-690 实锤）。
    const toolErr = needsAuthorization
      ? {
          code: "needs_authorization",
          message: authReason || "此路径尚未授权。",
          human_message:
            firstNonEmptyString(parsedErrorRecord?.human_message) ||
            "读取此路径需要你的授权，请选择授权范围。",
          action_required: "authorize_local_files",
          ...(authRoot ? { root: authRoot } : {}),
          ...(authReason ? { reason: authReason } : {}),
          ...(Array.isArray(authOptionsRaw) ? { options: authOptionsRaw } : {}),
        }
      : !ok
        ? toolErrorPayload(parsed, "tool failed")
        : null
    // artifact_pending：已提交、成品未到——回包给了 task_id 但还没有成品 url。
    const artifactPending =
      ok && typeof parsed?.task_id === "string" && !!parsed.task_id && !(typeof parsed?.url === "string" && parsed.url.length > 0)
    if (toolName.startsWith("image_")) {
      // 自动制画布：submit 完成后把 task_id 挂回 unit，完成事件才够关联。
      if (ok && typeof parsed?.task_id === "string" && parsed.task_id) {
        attachCanvasTask(state, callId, parsed.task_id)
      }
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        cost_coins: typeof parsed?.cost_coins === "number" ? parsed.cost_coins : undefined,
        ...(artifactPending ? { task_id: parsed.task_id, artifact_pending: true } : {}),
        // 落位回灌（2026-10-02）：若这次生成被绑到模板节点，如实回报落在哪颗 tpl-node
        // （前端 tool 卡可见；模型侧由 messages-gw 的 templateLandingFact 下一回合注入）。
        ...((): Record<string, string> => {
          const uid = state.canvasUnitByCall.get(callId)
          const nodeId = uid ? canvasResultNodeId(state.sessionId, uid) : ""
          return nodeId.startsWith("tpl-") ? { tpl_landing_node_id: nodeId } : {}
        })(),
      })
      if (ok && typeof parsed?.url === "string" && parsed.url.length > 0) {
        // P1-E1：image.done 附带真实配方（prompt/model/size/lora），前端
        // 「存为资产」直接拿，不必再从 transcript 对应。
        const cfg = st.input != null ? readGenerateInput(st.input) : undefined
        void emitImageDone(state, parsed.url, parsed.cost_coins, parsed.task_id, cfg ? { prompt: cfg.prompt, model: cfg.model, size: cfg.size, lora: cfg.lora } : undefined)
      }
    } else {
      // R1（2026-09-11）刀4：非 image_ 工具的 tool.result 补回填载荷。评测实锤 10 条
      // result 全为 {tool,ok,event_id} 空壳（前端契约的 cost_coins / error.human_message
      // / summary 全部拿不到）。有成本数字就带 cost_coins（quote/generate 类）；报价类
      // 工具再带一句 summary 短文案；同步子代理 deadline 超时补 partial/reason。
      const parsedObj =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
      // 缺陷 B（2026-10-04 本机档案桥）：local_files 的 read_file 结果把装置/闸道算好的
      // binary／bytes_read／size／truncated 放在 result 内；这里原样带进 SSE，前端据此
      // 显示「这是二进制文件」并正确报「已读 X / 文件 Y 字节（已截断）」。成功判定不变
      // （仍由 ok 决定），只是把后设栏位补齐，不改其他工具语义。
      const readFileResult =
        toolName === "local_files" &&
        parsedObj?.op === "read_file" &&
        parsedObj.result !== null &&
        typeof parsedObj.result === "object"
          ? (parsedObj.result as Record<string, unknown>)
          : null
      const readBinary = readFileResult ? readFileResult.binary === true || parsedObj?.binary === true : false
      const readBytesTotal = readFileResult && typeof readFileResult.size === "number" ? readFileResult.size : undefined
      const readBytesRead = readFileResult
        ? typeof readFileResult.bytes_read === "number"
          ? readFileResult.bytes_read
          : typeof parsedObj?.bytes === "number"
            ? parsedObj.bytes
            : undefined
        : undefined
      const readTruncated = readFileResult ? parsedObj?.truncated === true : undefined
      const costCoins =
        parsedObj && typeof parsedObj.cost_coins === "number"
          ? parsedObj.cost_coins
          : parsedObj && typeof parsedObj.total_coins === "number"
            ? parsedObj.total_coins
            : parsedObj && typeof parsedObj.confirmed_subtotal_coins === "number"
              ? parsedObj.confirmed_subtotal_coins
              : undefined
      let quoteSummary: string | undefined
      if (parsedObj && /quote/i.test(toolName)) {
        if (typeof parsedObj.summary === "string" && parsedObj.summary) {
          quoteSummary = parsedObj.summary
        } else {
          const bits: string[] = []
          // 余额查询（balance_only）没有合计：工具刻意用 total_coins=null 表达「不适用」而非 0 币。
          // 空明细求和出的 confirmed_subtotal_coins 会是 0，照旧显示就变成「已定价小计 0 币」，
          // 用户问余额却看到一句可读成报价的数字——正是该工具注释要挡的误读，故此处据余额报数。
          const balanceOnly =
            parsedObj.mode === "balance_only" ||
            (parsedObj.total_coins === null && typeof parsedObj.balance_coins === "number")
          if (balanceOnly) {
            if (typeof parsedObj.balance_coins === "number")
              bits.push(`余额 ${Math.round(parsedObj.balance_coins * 100) / 100} 币`)
          } else if (typeof parsedObj.total_coins === "number") bits.push(`合计 ${parsedObj.total_coins} 币`)
          else if (typeof parsedObj.confirmed_subtotal_coins === "number")
            bits.push(`已定价小计 ${parsedObj.confirmed_subtotal_coins} 币`)
          if (typeof parsedObj.unknown_price_count === "number" && parsedObj.unknown_price_count > 0)
            bits.push(`${parsedObj.unknown_price_count} 项待确认`)
          if (Array.isArray(parsedObj.available_models)) bits.push(`可用模型 ${parsedObj.available_models.length} 个`)
          if (bits.length) quoteSummary = bits.join("，")
        }
      }
      const subagentTimeout = toolName === "subagent_dispatch" && !ok && /超过预定时间/.test(toolErr?.message ?? "")
      emitToSession(state, "tool.result", {
        tool: toolName,
        ok,
        ...(toolErr ? { error: toolErr } : {}),
        // 报价类的 total_coins 是估价不是扣费：不挂 cost_coins（前端会当「已用/消耗」累加，
        // 2026-09-29 e2e 实锤「已用 614 币」而帐户只有 7 币）；金额已在 summary 里。
        ...(typeof costCoins === "number" && !/quote/i.test(toolName) ? { cost_coins: costCoins } : {}),
        ...(quoteSummary ? { summary: quoteSummary } : {}),
        ...(subagentTimeout ? { partial: true, reason: "timeout" } : {}),
        ...(artifactPending ? { task_id: parsed.task_id, artifact_pending: true } : {}),
        // 缺陷 A：授权请求的载荷原样带进 SSE（前端 needs_auth 态渲染三选一）。
        ...(needsAuthorization
          ? {
              action_required: "authorize_local_files",
              ...(authRoot ? { auth_root: authRoot } : {}),
              ...(authReason ? { auth_reason: authReason } : {}),
              ...(Array.isArray(authOptionsRaw) ? { auth_options: authOptionsRaw } : {}),
            }
          : {}),
        // 缺陷 B：二进位／截断后设栏位（前端 binary 面板与 bytes 显示）。
        ...(readFileResult
          ? {
              ...(readBinary ? { binary: true } : {}),
              ...(readBytesRead !== undefined ? { bytes_read: readBytesRead } : {}),
              ...(readBytesTotal !== undefined ? { bytes_total: readBytesTotal } : {}),
              ...(readTruncated === true ? { truncated: true } : {}),
            }
          : {}),
      })
      // 原生工具（bash 等）可能回传的是「含图片 URL 的 JSON」——例如引擎用
      // bash 呼叫 kotone-bridge 生图，输出 {text, images:[{url,...}]}。这类
      // 结果也要送 image.done，前端右侧展示框才会显示图片（否则只有泡泡文字）。
      if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { images?: unknown }).images)) {
        const imgs = (parsed as { images: { url?: string; width?: number; height?: number }[] }).images
        for (const im of imgs) {
          if (typeof im?.url === "string" && im.url.length > 0) {
            void emitImageDone(state, im.url)
          }
        }
      }
      // 影片／音频安全网（2026-08-31；2026-10-02 扩扫描巢状成品形状）：任何非 image_ 工具结果
      // 带平台影片／音频 URL（video_upload 回 {ok,url}、run_py 裁后上传、workflow 工具回 {url}）→
      // 发 video.done／audio.done，聊天框出卡。对称于上面的 image.done；dedup 由
      // emitVideoDone／emitAudioDone 的 announcedUrls 兜底，与 film 节点 runNode 出口不重复。
      //
      // 2026-10-02 缺口 2：真实取件工具回的是**巢状**形状，旧版只认顶层 url/video_url/audio_url
      // 与字面 videos[]/audios[]，两个都不命中——video_result_fetch 回 {jobs:[{video_url}]}、
      // last_frame_video_chain 回 {shots:[{mp4_url}]}。模型手动查到成品、把 URL 贴进文字时，
      // 网关不发卡，用户只看到泡泡里一条纯文字连结（暴君抱怨的真身）。
      // 修法＝保留原行为、只扩扫描：有界走访（深度 ≤3、节点 ≤200，防病态大 payload），
      // 逐层认候选键；判定仍只认既有副档名正则，不因工具名放宽（不猜）。
      if (parsed !== null && typeof parsed === "object") {
        const media = collectToolOutputMediaUrls(parsed)
        for (const c of media.video) void emitVideoDone(state, c.url, c.cost_coins, undefined, "video")
        for (const c of media.audio) void emitAudioDone(state, c.url, c.cost_coins, undefined, "audio", { title: c.title, cover: c.cover })
        // 出曲后自动 lyric-align（异步）：歌词来自工具入参，URL 来自出参；失败不挡播放。
        if (media.audio.length > 0) {
          maybeEnqueueLyricAlignFromTool({
            toolName,
            input: st.input,
            parsed,
            sessionId: state.sessionId,
          })
        }
      }
    }
  } else if (status === "error") {
    const err = st.error
    let message =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "tool failed"
    // 0919 断点②修复：question 工具以 aborted 收尾≠用户中止——是 orchestrator
    // 调 question 冻结 turn 时杀掉在途轮的内部中止（实锤 13:00:21 两条
    // 「已按你的要求中止本轮」冒充用户话术）。此处换中性话术；用户真中止
    // 走 /abort 端点（6516），不经此分支。
    let isQuestionFreezeAbort = false
    if (toolName === "question" && /\baborted?\b/i.test(message)) {
      isQuestionFreezeAbort = true
      message = "本回合已暂停，等待你在问题卡上选择后继续"
    }
    // 0920 暴君钦点：abort 类工具错误一律不发卡——①真用户按停：UI 收尾由
    // turn.done 表达（与 emitSessionError 的 MessageAbortedError 早退同构，09-18）；
    // ②系统自杀轮（failover 换线/idle 止损/子代理换模杀在途工具）此前经此分支
    // 弹「已按你的要求中止本轮」错误卡＝栽赃用户＋欺君。两种情况都只留日志。
    if (!isQuestionFreezeAbort && /\b(aborted?|cancel(?:led|ed) by user|interrupted by user)\b/i.test(message)) {
      console.log(`[gateway] tool abort, card suppressed (UI 收尾走 turn.done): callId=${callId} tool=${toolName} message=${message}`)
      return
    }
    // 修 4：workflow_start 的裸「tool failed」→ 带期望 schema 的可照抄报错。
    // 工具层不透传 gateway 400 body，模型此前只能盲猜载荷形状；命中条件 =
    // workflow_start + 报错无任何中文（真实中文报错如「缺少必要内容」不覆盖）。
    if (toolName === "workflow_start" && !/[\u4e00-\u9fff]/.test(message)) {
      message = workflowStartSchemaHint(st.input)
    }
    // 2026-08-22：opencode 的 deny 消息自带完整权限规则表（120+ 条 JSON），
    // 原样透传=防御清单直接送给任何用户（侦察面）。权限拦截一律换成短句。
    // R4-A S10（2026-08-28）：R4 实锤「此操作不在允许范围内，已跳过」×7 不说
    // 是哪个操作——补上被拒操作（bash 命令前缀，非 bash 工具补工具名）。
    // R8-B 工单 #2（2026-08-29）：再补命中规则（matched_pattern）与替代写法——
    // R8 实锤模型花 78s 人肉逆向 deny 表，报因后此段归零。
    let denyInfo: { pattern: string; hint: string } | null = null
    let denyProv: DenyProvenance | null = null
    if (/specified a rule which prevents|relevant rules/i.test(message)) {
      const cmd =
        st.input && typeof st.input === "object" && typeof (st.input as { command?: unknown }).command === "string"
          ? (st.input as { command: string }).command
          : ""
      denyInfo = bashDenyAttribution(cmd)
      // 需求1（2026-10-02）：结构化 provenance（向下相容，仅新增栏位）。
      denyProv = bashDenyProvenance(cmd, undefined, message)
      // 2026-10-04 W：deny 守卫固定文案一律简体（pattern 为规则 glob 原文，非文案，不译）。
      message = `此操作不在允许范围内，已跳过${deniedOperationLabel(toolName, st.input)}${
        denyInfo ? `。命中规则：${denyInfo.pattern}；替代写法：${denyInfo.hint}` : ""
      }`
      // 持久稽核：每次拒绝落一笔结构化记录。
      if (denyProv) {
        appendDenyAudit({
          ts: new Date().toISOString(),
          session_id: state.sessionId,
          call_id: callId,
          tool: toolName,
          operation: deniedOperationLabel(toolName, st.input),
          source: denyProv.source,
          pattern: denyProv.pattern,
          reason: denyProv.reason,
          hint: denyProv.hint,
        })
      }
    }
    // S2a：error 态的 tool.result 同样补齐三栏位错误合同。
    emitToSession(state, "tool.result", {
      tool: toolName,
      ok: false,
      error: {
        code: isQuestionFreezeAbort ? "question_freeze" : "tool_error",
        message,
        human_message: isQuestionFreezeAbort ? message : humanMessageFor(message),
        ...(denyInfo ? { matched_pattern: denyInfo.pattern, hint: denyInfo.hint } : {}),
        ...(denyProv ? { deny_provenance: denyProv } : {}),
      },
    })
    // question 冻结中止不是错误：不进 session.error 帧（避免 UI 红卡）、
    // 不记上游错（不是渠道故障，别误触 failover 重投）。
    if (isQuestionFreezeAbort) {
      console.log(`[gateway] question freeze abort: callId=${callId} — turn paused pending answer (no error frame)`)
      return
    }
    emitSessionError(state, "tool_error", message)
  }
}

// ── P2b（2026-09-11）刀2：空转止损 ──────────────────────────────────
// step 结算：无 tool、无非空正文、无非空 reasoning = 空 step。空 step 连续累计；
// 任一活动归零。达阈值且 turn 活跃 → 中止 + 同轮补一次动作导向 nudge。
export function finalizeIdleStep(state: SessionState): void {
  // 空转补丁：本 step 只有 no-op bash 且无正文 → 视为空 step（即使有 reasoning）
  const noopOnly = !!state.stepNoopTool && !state.stepHasTool && !state.stepHasText
  const empty = noopOnly || (!state.stepHasTool && !state.stepHasText && !state.stepHasReasoning)
  state.stepNoopTool = false
  state.stepHasTool = false
  state.stepHasText = false
  state.stepHasReasoning = false
  if (!empty) {
    state.idleSteps = 0
    return
  }
  state.idleSteps = (state.idleSteps ?? 0) + 1
  if (
    state.idleSteps >= IDLE_STEP_ABORT_THRESHOLD &&
    !state.idleNudgeSent &&
    !state.turnAborted &&
    (state.lastTurnActiveAt ?? 0) > 0 &&
    state.lastPromptBody
  ) {
    triggerIdleStepBreaker(state)
  }
}

export function triggerIdleStepBreaker(
  state: SessionState,
  nudgeText: string = IDLE_STEP_NUDGE,
): void {
  const body = state.lastPromptBody
  if (!body) return
  state.idleNudgeSent = true
  const gen = state.turnGen ?? 0
  // 内部 nudge 不再新增独立 part，而是接到最后一个 text part 的文本尾端、以既有
  // TAIL_PAYLOAD_MARKER 分隔：模型上下文内容不变（标记与 nudge 仍在同一 part 内、
  // 仍在模型眼前），显示读通道（slimHistoryMessages 的 stripTailInjectedPayload）
  // 会自动截掉标记之后的内容，历史端点不再把内部提示写进用户气泡。
  // 尾端块带本会话凭证 ⟦gw:<nonce>⟧，与 appendSystemPayloadToTurnTail 同形状：
  // 真注入件恒带凭证，显示读通道据此区分「真网关注入」与「用户自写的同形标记」。
  const tailBlock = `${TAIL_PAYLOAD_MARKER}⟦gw:${ensureGatewayNonce(state)}⟧ `
  const parts = body.parts.map((pt) => ({ ...pt }))
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined
  if (last && "text" in last && last.type === "text" && typeof last.text === "string") {
    last.text = `${last.text}${tailBlock}${nudgeText}`
  } else {
    parts.push({ type: "text", text: `${tailBlock}${nudgeText}` })
  }
  const nudgeBody = { ...body, parts }
  console.warn(
    `[gateway] idle-step breaker: ${IDLE_STEP_ABORT_THRESHOLD} empty steps (or reasoning-cap), abort+nudge — session=${state.sessionId} gen=${gen}`,
  )
  // ① 中止当前 turn（与用户中止同一后端路径）。
  void opencodeFetch(`/session/${state.opencodeSessionId}/abort`, {
    method: "POST",
    timeoutMs: 5000,
  }).catch(() => {})
  state.turnAborted = true
  // D2-1b（2026-09-23）：来源＝系统（内部断路器），不是用户叫停。排队中的 steer
  // 只能被「用户停止」丢弃（停止优先的权威定义见 steer-core.abortIsUserStop）——
  // 这里只是换一种方式把同一轮续跑（下面补 nudge 重投），用户的指引仍然有效。
  state.turnAbortSource = "system"
  stripStaleTurnTextFromReplay(state)
  // 中止轮的 session.idle 不得再触发抖动/failover 二次重投：retryQueued 占位。
  // 本轮的重投就是下面的 nudge；再空转保持占位 = 不循环，让它自然失败。
  state.retryQueued = true
  // ② 同一 turn 周期仅一次：原样重发最后一条用户消息，尾端附动作导向提示。
  setTimeout(async () => {
    const cur = sessions.get(state.sessionId)
    if (!cur || (cur.turnGen ?? 0) !== gen) return
    try {
      // 2026-10-01 去重：空 step 轮零产出 → 撤掉原 user 讯息，nudgeBody（原文＋提示）只留一条。
      await revertDeadTail(cur.opencodeSessionId)
      const res = await opencodeFetch(`/session/${cur.opencodeSessionId}/prompt_async`, {
        method: "POST",
        body: JSON.stringify(nudgeBody),
        timeoutMs: 10000,
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      cur.turnAborted = false
      cur.turnAbortSource = undefined // 续跑同轮：中止来源随中止状态一并清（下一轮／下一次中止重设）
      cur.idleSteps = 0
      cur.stepOpen = false
      cur.stepHasTool = false
      cur.stepHasText = false
      cur.stepHasReasoning = false
      cur.turnTextChars = 0
      cur.turnToolStarted = false
      cur.lastTurnActiveAt = Date.now()
      stripStaleTurnTextFromReplay(cur)
      armWatchdogTimer(cur)
      console.log(`[gateway] idle-step breaker: nudge resend dispatched — session=${cur.sessionId}`)
    } catch (e) {
      console.error(`[gateway] idle-step breaker: nudge resend failed:`, e)
      cur.turnAborted = false
      cur.turnAbortSource = undefined
      // 2026-10-02 steer 误判修复：nudge 没发出去＝本轮真的结束了，清 in-flight 打点。
      // 必须与 turn.done 同点——idle 不再清了（见 opencode-event-handler.emitTurnDone），
      // 这里漏清会留下「假在途」：之后的引导被受理闸放行、收进队列，却再也等不到投递。
      cur.lastTurnActiveAt = 0
      markDirty(cur)
      emitToSession(cur, "turn.done", {})
    }
  }, TURN_RETRY_DELAY_MS)
}
