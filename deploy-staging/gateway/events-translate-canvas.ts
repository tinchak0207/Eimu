import type { SessionState } from "./types-gateway.ts"
import { TOOL_STATUS_DEDUP_CAP } from "./constants-gateway.ts"
import { markDirty } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { estimateNodeCoins } from "./pricing-gateway.ts"
import { applyCanvasNodeCreated, applyCanvasNodeConnected, applyCanvasNodeUpdated, applyCanvasNodeDeleted, claimTemplateSlot, canvasResultNodeId } from "./canvas-cascade-state.ts"
import { flushPendingCompact } from "./messages-gw.ts"
import { boundMap } from "./events-translate-core.ts"
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
  const model = typeof obj.model === "string" && obj.model ? obj.model : "gpt-image-2.5-flare"
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
// 让 image_quote／image_get_result／image_upload 也各铺一组「(未填写内容) + gpt-image-2.5-flare · 1024x1024
// 待处理」空节点，永远不会跑，还一路带到用户之后开的新对话画布上。
export const AUTO_CANVAS_TOOLS = new Set(["image_generate", "image_edit", "image_upscale"])

// 2026-10-31「节点＝生成调用的投影」第 1 刀：music_gen（同步出曲）也上画布；probe=true 只做免费体检、不生成，不建节点。
export function isMusicProbe(input: unknown): boolean {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>).probe : undefined
  return v === true || v === "true"
}
export function wantsAutoCanvas(toolName: string, input: unknown): boolean {
  return AUTO_CANVAS_TOOLS.has(toolName) || (toolName === "music_gen" && !isMusicProbe(input))
}

// 在建中的单元（autoCreate 是 async：cost 估算有 await）。completed 可能先于单元落地到达
//（同步拒绝几十毫秒就回），回写方一律经 canvasUnitForCall 等它建完，避免「回执先到、节点后建、永远转圈」。
const pendingUnitByCall = new Map<string, Promise<string>>()
const pendingKey = (state: SessionState, callID: string): string => `${state.sessionId}|${callID}`

export function autoCreateCanvasUnit(state: SessionState, toolName: string, input: unknown, callID: string): Promise<string> {
  const key = pendingKey(state, callID)
  const p = toolName === "music_gen" ? Promise.resolve().then(() => createMusicCanvasUnit(state, input, callID)) : createGenerateCanvasUnit(state, toolName, input, callID)
  pendingUnitByCall.set(key, p)
  const clear = () => {
    if (pendingUnitByCall.get(key) === p) pendingUnitByCall.delete(key)
  }
  p.then(clear, clear)
  return p
}

export async function canvasUnitForCall(state: SessionState, callID: string): Promise<string | undefined> {
  const known = state.canvasUnitByCall.get(callID)
  if (known) return known
  const p = pendingUnitByCall.get(pendingKey(state, callID))
  if (!p) return undefined
  try {
    return await p
  } catch {
    return undefined
  }
}

async function createGenerateCanvasUnit(
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

  // 预留结果节点（结果落地时更新同一节点）。id 尾段固定 -image（canvasResultNodeId 契约），
  // type 按真实产物：image_generate kind:"video" ⇒ 前端 video 节点（<video> 播放），其余 image。
  const imageNode = {
    id: `${unitId}-image`,
    type: toolName === "image_generate" && cfg.kind === "video" ? "video" : "image",
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

// music_gen 单元：文本（prompt＋歌词摘要）→ 配置（时长档／通路）→ 音频结果。同步工具，
// completed 回执即终态，由 settleMusicCanvasUnit 按 callID 回写，不经 task_id。
function createMusicCanvasUnit(state: SessionState, input: unknown, callID: string): string {
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : ""
  const lyrics = typeof obj.lyrics === "string" ? obj.lyrics.trim() : ""
  const durationHint = typeof obj.duration_hint === "string" && obj.duration_hint ? obj.duration_hint : "full"
  const unitId = canvasUnitId()
  const lyricsDigest = lyrics ? `歌词：${lyrics.slice(0, 200)}${lyrics.length > 200 ? "…" : ""}` : "纯器乐（无歌词）"
  const textNode = {
    id: `${unitId}-text`,
    type: "text",
    title: summarizeCanvasTitle("音乐", prompt),
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: prompt ? `${prompt}\n\n${lyricsDigest}` : lyricsDigest, status: "idle" },
  }
  const configNode = {
    id: `${unitId}-config`,
    type: "config",
    title: `音乐 · ${durationHint === "clip30" ? "快速生成" : "整歌"}`,
    position: { x: 0, y: 0 },
    width: 440,
    height: 240,
    metadata: {
      content: `时长：${durationHint === "clip30" ? "快速生成（clip30）" : "整歌（full）"}`,
      status: "idle",
      model: "自动通路",
      kind: "audio",
      duration_hint: durationHint,
    },
  }
  const audioNode = {
    id: `${unitId}-audio`,
    type: "audio",
    title: "音乐生成中…",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: "", status: "loading" },
  }
  for (const node of [textNode, configNode]) {
    emitToSession(state, "canvas.node.created", { unit_id: unitId, node })
    applyCanvasNodeCreated(state.sessionId, { node })
  }
  const c1 = { id: `${unitId}-c1`, fromNodeId: textNode.id, toNodeId: configNode.id }
  emitToSession(state, "canvas.node.connected", { unit_id: unitId, connection: c1 })
  applyCanvasNodeConnected(state.sessionId, { connection: c1 })
  emitToSession(state, "canvas.node.created", { unit_id: unitId, node: audioNode, target_kind: "result" })
  applyCanvasNodeCreated(state.sessionId, { node: audioNode })
  const c2 = { id: `${unitId}-c2`, fromNodeId: configNode.id, toNodeId: audioNode.id }
  emitToSession(state, "canvas.node.connected", { unit_id: unitId, connection: c2, target_kind: "result" })
  applyCanvasNodeConnected(state.sessionId, { connection: c2 })
  state.canvasUnitByCall.set(callID, unitId)
  boundMap(state.canvasUnitByCall, TOOL_STATUS_DEDUP_CAP)
  markDirty(state)
  return unitId
}

type CanvasToolError = { code?: unknown; message?: unknown; human_message?: unknown } | null | undefined

function canvasErrorPatch(err: CanvasToolError, fallback: string): Record<string, unknown> {
  const code = typeof err?.code === "string" ? err.code : "tool_error"
  const message = typeof err?.message === "string" ? err.message : ""
  const human = (typeof err?.human_message === "string" && err.human_message) || message || fallback
  return { status: "error", errorDetails: { code, message: message || human, human_message: human }, human_message: human }
}

function patchCanvasNode(state: SessionState, unitId: string, nodeId: string, patch: Record<string, unknown>): void {
  emitToSession(state, "canvas.node.updated", { unit_id: unitId, node_id: nodeId, patch })
  applyCanvasNodeUpdated(state.sessionId, { unit_id: unitId, node_id: nodeId, patch })
}

// music_gen completed → 音频节点终态（成功＝url＋cost_coins；失败＝error＋人话原因），配置节点补实际通路。
export async function settleMusicCanvasUnit(
  state: SessionState,
  callID: string,
  ok: boolean,
  parsed: Record<string, unknown> | null,
  err: CanvasToolError,
): Promise<void> {
  const unitId = await canvasUnitForCall(state, callID)
  if (!unitId) return
  const url = typeof parsed?.url === "string" ? parsed.url : ""
  const channel = typeof parsed?.channel === "string" ? parsed.channel : ""
  if (channel) patchCanvasNode(state, unitId, `${unitId}-config`, { model: channel, ...(typeof parsed?.fallback_from === "string" ? { fallback_from: parsed.fallback_from } : {}) })
  if (ok && url) {
    patchCanvasNode(state, unitId, `${unitId}-audio`, {
      status: "success",
      content: url,
      ...(typeof parsed?.cost_coins === "number" ? { cost_coins: parsed.cost_coins } : {}),
      ...(channel ? { channel } : {}),
      ...(typeof parsed?.duration_seconds === "number" ? { duration_seconds: parsed.duration_seconds } : {}),
    })
  } else {
    patchCanvasNode(
      state,
      unitId,
      `${unitId}-audio`,
      ok ? canvasErrorPatch({ code: "upload_failed", human_message: "音乐已生成，但音频未能上传，画布无法播放。" }, "") : canvasErrorPatch(err, "音乐生成失败。"),
    )
  }
  markDirty(state)
}

// 生成工具没拿到 task_id 就收尾（同步拒绝／工具抛错）→ 单元不能留在 loading。
// 平台明确拒收（unsupported_size 等：未提交、未扣费）＝这次调用没有产物 ⇒ 整组节点与连线删除；
// 提交结果未知（网络错误／中止／工具抛错）⇒ 不假装没发生：结果节点置 error＋人话原因。
// 模板空位（tpl-*）是用户的节点，永不删除，只置 error。
const SUBMIT_UNKNOWN_CODES = new Set(["network_error", "aborted", "timeout", "submit_unknown"])

export async function settleCanvasUnitWithoutTask(
  state: SessionState,
  callID: string,
  err: CanvasToolError,
  thrown: boolean,
): Promise<void> {
  const unitId = await canvasUnitForCall(state, callID)
  if (!unitId) return
  const resultId = canvasResultNodeId(state.sessionId, unitId)
  const code = typeof err?.code === "string" ? err.code : ""
  if (thrown || SUBMIT_UNKNOWN_CODES.has(code) || resultId.startsWith("tpl-")) {
    patchCanvasNode(state, unitId, resultId, canvasErrorPatch(err, "生成未完成。"))
  } else {
    for (const nodeId of [resultId, `${unitId}-config`, `${unitId}-text`]) {
      emitToSession(state, "canvas.node.deleted", { unit_id: unitId, node_id: nodeId })
      applyCanvasNodeDeleted(state.sessionId, { node_id: nodeId })
    }
  }
  markDirty(state)
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
  if (!taskId) return
  if (!target) {
    // 单元仍在建（回执先到）：建完再挂，否则结果回写找不到 unit、节点永远转圈。
    if (pendingUnitByCall.has(pendingKey(state, callID))) {
      void canvasUnitForCall(state, callID).then((u) => {
        if (!u) return
        state.canvasUnitByTask.set(taskId, u)
        boundMap(state.canvasUnitByTask, TOOL_STATUS_DEDUP_CAP)
      })
    }
    return
  }
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
  // 2026-10-18 止血：生成任务终态 → 若有 pendingCompact 立刻再试压缩。
  flushPendingCompact(state)
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
