// 从 index.ts 无损抽取（2026-09-19 第一阶段）
// media-internal-routes.ts — Media 上传/Canvas 内部 HTTP 处理器＋TTS＋confirm＋internal emit
// 涵盖 index.ts 原行区：7636–7908（canvas/media handlers）、7910–8036（TTS）、
// 8165–8285（confirm）、8410–8483（emitImageFailed/emitVideoFailed/emitAudioFailed＋handleInternalEmit）。
import path from "node:path"
import { createHash } from "node:crypto"
import { db } from "./persistence-schema.ts"
import { mkdir } from "node:fs/promises"
import { jsonError } from "./gw-lib.ts"
import { subagentParentState } from "./subagent"
import { byChildOc } from "./subagent-runs.ts"
import { pushParentNote } from "./subagent-live.ts"
import { billingAutoApprovalEnabled, billingPermissionTenant } from "./charge-approval-policy.ts"
import type { SessionState, ConfirmOutcome } from "./types-gateway.ts"
import { INTERNAL_EMIT_ALLOWED, CANVAS_EMIT_ALLOWED, CONFIRM_TIMEOUT_MS, CONFIRM_RESOLVED_CAP } from "./constants-gateway.ts"
import { synthesizeSpeech, type SpeechDeps } from "./project/speech.ts"
import { resolveCanvasOps, sanitizeOpsResult, storeCanvasState, getCanvasState, validateCanvasOps, dispatchCanvasOps, checkTemplateGuard, canvasResultNodeId, applyCanvasNodeUpdated, CANVAS_OPS_TIMEOUT_MS } from "./canvas-cascade-state.ts"
import { resolveSession, getOwnedSession, sessions } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { emitImageDone, emitVideoDone, emitAudioDone } from "./events-translate.ts"
import { flushPendingCompact } from "./messages-gw.ts"
import { emitSessionError } from "./emit-helpers.ts"
import { emitQuotaChanged, appendLedgerFor } from "./quota-ledger.ts"
import { humanMessageFor } from "./humanize-gw.ts"
import { wfGenerateContinuations, workflowGenerateApproved, workflowBilling, recordWorkflowApproval, runWfGenerate, resumeWorkflowGate } from "./workflow-gw.ts"
import { contentTypeForExt } from "./uploads-media.ts"
import { notify } from "./internal-waiters.ts"

// POST /internal/media/upload — agent 素材入库：服务端下载外部影片/音频/图片 URL，
// 或接收 path_b64 位元组（含文档 md/txt/json/csv/pdf）→
// 平台存储（image-data uploads 目录，公网面 store.tinchak0207.xyz/image-data/files/）。
// 外部 URL 直连常被 Cloudflare 403 挑战拦截、/v1/uploads 拒收 video——
// 影片/音频素材一律先经此端点入库取得平台 URL，再注入工作流节点。
// 文档同通道（F2 2026-10-10）：workspace 研究/剧本 md 经 document_upload 入库后，
// 聊天 markdown 链接即可点开，禁止再报裸 VPS 路径冒充「可随时查看」。
// 鉴权同其他 session 类 internal 路由：分发层 loopback 门 + session_id 解析。

/** 媒体入库允许的 Content-Type：原视频/音频/图片 + 文稿（F2 文档可达面）。 */
function isAllowedMediaUploadContentType(contentType: string): boolean {
  const ct = contentType.split(";")[0].trim().toLowerCase()
  if (ct.startsWith("video/") || ct.startsWith("audio/") || ct.startsWith("image/")) return true
  if (ct.startsWith("text/")) return true
  if (ct === "application/json" || ct === "application/pdf") return true
  return false
}

function outExtForContentType(contentType: string, fallbackExt: string): string {
  const ct = contentType.split(";")[0].trim().toLowerCase()
  if (ct.startsWith("video/")) return "mp4"
  if (ct.startsWith("audio/")) return "mp3"
  if (ct.includes("jpeg")) return "jpg"
  if (ct.includes("webp")) return "webp"
  if (ct.includes("gif")) return "gif"
  if (ct.startsWith("image/")) return "png"
  if (ct.includes("markdown") || ct === "text/x-markdown") return "md"
  if (ct === "text/csv") return "csv"
  if (ct === "application/json") return "json"
  if (ct === "application/pdf") return "pdf"
  if (ct.startsWith("text/")) return "txt"
  return fallbackExt.replace(/^\./, "") || "bin"
}

export async function handleMediaUpload(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get("session_id")
  if (!sessionId) return Response.json({ ok: false, error: "session_id is required" }, { status: 400 })
  // 死线③同构（2026-09-19 片头曲 404 实锤）：子代理 opencode session 只在
  // byChildOc 注册表里，resolveSession 三段解析查无记录 → music_gen 的
  // uploadAudio 在 Expert 子会话内一律 404 "session not found"（生成成功、
  // 上传全挂）。最小修：命中活跃子会话时落盘归属父会话（同一用户，存储口径
  // 不变）；父会话已被逐出/收尾则维持 404 原语义。
  const session = resolveSession(sessionId) ?? subagentParentState(sessionId)
  if (!session) return Response.json({ ok: false, error: "session not found" }, { status: 404 })
  let body: { url?: unknown; path_b64?: unknown; filename?: unknown }
  try {
    body = (await req.json()) as { url?: unknown; path_b64?: unknown; filename?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid json body" }, { status: 400 })
  }
  const MAX_BYTES = 200 * 1024 * 1024
  let buf: Buffer
  let total = 0
  let contentType = ""
  let outExt: string
  // 本地成片以 base64 位元组上传：video_upload 工具跑在 opencode-server 沙箱（PrivateTmp=yes）内，
  // 读得到 agent 写进私有 /tmp 的成片；网关进程（PrivateTmp=no）读不到该私有 /tmp，故由工具读档传
  // 位元组、网关不碰 agent FS。仍校验大小与扩展名（视频/音频/图片/文稿），保持入库契约。
  if (typeof body.path_b64 === "string" && body.path_b64.trim()) {
    buf = Buffer.from(body.path_b64, "base64")
    total = buf.length
    if (total === 0) return Response.json({ ok: false, error: "上传内容为空" }, { status: 400 })
    if (total > MAX_BYTES) {
      return Response.json({ ok: false, error: `file too large (${total} bytes, limit 200MB)` }, { status: 413 })
    }
    const fname = typeof body.filename === "string" ? body.filename : ""
    const srcExt = path.extname(fname).toLowerCase() || ".mp4"
    contentType = contentTypeForExt(srcExt)
    if (!isAllowedMediaUploadContentType(contentType)) {
      return Response.json({ ok: false, error: `不支持的文件类型 "${srcExt}"（仅接受视频/音频/图片/文稿 md·txt·json·csv·pdf）` }, { status: 415 })
    }
    outExt = srcExt.replace(/^\./, "")
  } else if (typeof body.url === "string" && body.url.trim()) {
    const src = body.url.trim()
    let upstream: Response
    try {
      upstream = await fetch(src, { signal: AbortSignal.timeout(120_000), redirect: "follow" })
    } catch (e) {
      return Response.json({ ok: false, error: `download failed: ${(e as Error).message}` }, { status: 502 })
    }
    if (!upstream.ok) {
      return Response.json({ ok: false, error: `upstream responded http ${upstream.status}` }, { status: 502 })
    }
    contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (!isAllowedMediaUploadContentType(contentType)) {
      return Response.json({ ok: false, error: `unsupported content-type "${contentType || "none"}"（仅接受 video/*、audio/*、image/* 或文稿 text/*·json·pdf）` }, { status: 415 })
    }
    const contentLength = Number(upstream.headers.get("content-length") || "0")
    if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
      return Response.json({ ok: false, error: `file too large (${contentLength} bytes, limit 200MB)` }, { status: 413 })
    }
    const reader = upstream.body?.getReader()
    if (!reader) return Response.json({ ok: false, error: "upstream returned empty body" }, { status: 502 })
    const chunks: Buffer[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {})
        return Response.json({ ok: false, error: "file too large (limit 200MB)" }, { status: 413 })
      }
      chunks.push(Buffer.from(value))
    }
    if (total === 0) return Response.json({ ok: false, error: "upstream returned empty body" }, { status: 502 })
    let urlPathExt = ""
    try {
      urlPathExt = path.extname(new URL(src).pathname).toLowerCase()
    } catch {
      urlPathExt = ""
    }
    outExt = outExtForContentType(contentType, urlPathExt || ".bin")
    buf = Buffer.concat(chunks)
  } else {
    return Response.json({ ok: false, error: "url or path_b64 (string) is required" }, { status: 400 })
  }
  const name = `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${outExt}`
  const outDir = "/opt/image-data-api/data/uploads"
  try {
    const { writeFile } = await import("node:fs/promises")
    await mkdir(outDir, { recursive: true })
    await writeFile(path.join(outDir, name), buf)
  } catch (e) {
    console.error("[gateway] media upload persist failed:", e)
    return Response.json({ ok: false, error: "failed to persist media file" }, { status: 500 })
  }
  const publicUrl = `https://store.tinchak0207.xyz/image-data/files/uploads/${name}`
  console.log(`[gateway] media upload: session=${sessionId} bytes=${total} type=${contentType} -> ${publicUrl}`)
  return Response.json({ ok: true, url: publicUrl, bytes: total, content_type: contentType })
}

// POST /internal/canvas/dispatch-ops — opencode canvas_* 工具的下发入口。
// 阻塞至前端回执或逾时；timeout_ms 仅供测试缩短，上限即预设值。
export async function handleCanvasDispatchOps(req: Request): Promise<Response> {
  let body: { session_id?: unknown; ops?: unknown; label?: unknown; timeout_ms?: unknown; deviate_from_template?: unknown; deviate_reason?: unknown; deviate_token?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (typeof body.session_id !== "string" || !body.session_id) {
    return jsonError(400, "session_id is required", "bad_request", "bad_request")
  }
  const state = resolveSession(body.session_id) ?? subagentParentState(body.session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const v = validateCanvasOps(body.ops)
  if ("message" in v) return jsonError(400, v.message, "bad_request", "bad_request")
  // 模板节点守卫：守接线契约与防平行重复生成（见 checkTemplateGuard）；偏离只认网关签发 token。
  const tplBlock = checkTemplateGuard(state.sessionId, v.ops, {
    declared: body.deviate_from_template === true,
    reason: typeof body.deviate_reason === "string" ? body.deviate_reason : "",
    token: typeof body.deviate_token === "string" ? body.deviate_token : "",
  })
  if (tplBlock) {
    return Response.json({ ok: false, code: "TEMPLATE_SLOT_OPEN", error: tplBlock }, { status: 409 })
  }
  const label = typeof body.label === "string" && body.label ? body.label.slice(0, 200) : undefined
  const rawTimeout = typeof body.timeout_ms === "number" && Number.isFinite(body.timeout_ms) ? body.timeout_ms : CANVAS_OPS_TIMEOUT_MS
  const timeoutMs = Math.max(1_000, Math.min(CANVAS_OPS_TIMEOUT_MS, rawTimeout))
  try {
    const { request_id, result } = await dispatchCanvasOps(state, v.ops, label, timeoutMs)
    return Response.json({ ok: true, request_id, result })
  } catch (e) {
    const err = e as { code?: string; request_id?: string }
    if (err?.code === "OPS_TIMEOUT") {
      return Response.json(
        { ok: false, code: "OPS_TIMEOUT", request_id: err.request_id ?? null, error: "前端未在时限内回执画布操作结果" },
        { status: 504 },
      )
    }
    console.error("[gateway] canvas dispatch-ops error:", e)
    return jsonError(500, "canvas ops dispatch failed", "server_error", "server_error")
  }
}

// POST /internal/canvas/ops-result — loopback 回执（body 带 session_id）。
export async function handleCanvasOpsResultInternal(req: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : ""
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  if (!sessionId || !requestId) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  if (typeof body.ok !== "boolean") {
    return jsonError(400, "ok (boolean) is required", "bad_request", "bad_request")
  }
  const matched = resolveCanvasOps(sessionId, requestId, sanitizeOpsResult(body))
  return Response.json({ ok: true, matched })
}

// POST /agent/v1/sessions/:id/canvas/state — 前端（经站点代理）快照上行。
export async function handleCanvasStatePublic(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: { state?: unknown }
  try {
    body = (await req.json()) as { state?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  if (body.state === null || body.state === undefined || typeof body.state !== "object") {
    return jsonError(400, "state (object) is required", "bad_request", "bad_request")
  }
  const stored = storeCanvasState(state.sessionId, body.state)
  if ("status" in stored) {
    const code = stored.status === 413 ? "payload_too_large" : "bad_request"
    return jsonError(stored.status, stored.message, code, code)
  }
  // rev 供前端做乐观并发：下次上行带回该版本，服务端据此拒绝迟到的旧快照。
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt, rev: stored.rev })
}

// GET /agent/v1/sessions/:id/canvas/state — 前端（经站点代理）快照下行。
// 2026-08-29 修复：站点路由 GET /api/agent/sessions/:id/canvas-state 代理到这里，
// 但本网关此前只有 POST 没有 GET → 刷新/恢复会话必然 404。语义对齐
// GET /internal/canvas/snapshot；getOwnedSession 内含 DB 懒恢复（canvasStates 回灌），
// 进程重启/闲置回收后照样读得到。
export async function handleCanvasStatePublicGet(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const snap = getCanvasState(state.sessionId)
  return Response.json({
    ok: true,
    has_state: snap !== null,
    state: snap?.state ?? null,
    updated_at: snap?.updatedAt ?? null,
    rev: snap?.state && typeof snap.state === "object" ? (snap.state as Record<string, unknown>).rev ?? 0 : 0,
  })
}

// POST /agent/v1/sessions/:id/canvas/ops-result — 前端（经站点代理）回执。
export async function handleCanvasOpsResultPublic(key: string, id: string, req: Request): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const requestId = typeof body.request_id === "string" ? body.request_id : ""
  if (!requestId) return jsonError(400, "request_id is required", "bad_request", "bad_request")
  if (typeof body.ok !== "boolean") {
    return jsonError(400, "ok (boolean) is required", "bad_request", "bad_request")
  }
  const matched = resolveCanvasOps(state.sessionId, requestId, sanitizeOpsResult(body))
  return Response.json({ ok: true, matched })
}

// ─────────────────────────── TTS（配音）工具支持
//
// 实现已合并到 project/speech.ts 的 synthesizeSpeech（S8a，设计文档 §3.5）：旧的
// handleTts 逻辑（探测 → 展开 `@[音频:X]` → 调上游 → 落盘/计价 → 响应形状）逐行搬过去，
// 这里只保留 HTTP 壳。行为逐字节不变；workflow-gw-service.ts 的内联 audio 路径仍用
// 本文件再导出的 TTS_UPSTREAM / probeTtsUpstream（旧 world2 路径冻结）。
export { TTS_UPSTREAM, probeTtsUpstream } from "./project/speech.ts"

/**
 * POST /agent/v1/tts { text, voice?, session 带 Bearer key }
 * 同步调用：成功 → { ok, url, cost_coins, chars, format }；上游不可用 → 503 诚实错误。
 * 定价一律走 pricing-and-validation.ts 的 estimateTtsCoins（工具侧不硬编码）。
 */
export async function handleTts(key: string, req: Request, deps?: SpeechDeps): Promise<Response> {
  let body: { text?: string; voice?: string }
  try {
    body = (await req.json()) as { text?: string; voice?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const r = await synthesizeSpeech(
    // 旧路由不接受 speed（旧实现忽略该键）；照旧只传 text/voice，保证同输入同上游请求。
    { text: body.text as string, voice: body.voice, apiKey: key },
    deps,
  )
  if (r.ok === false) return jsonError(r.status, r.message, r.code, r.code)
  return Response.json({ ok: true, url: r.url, chars: r.chars, cost_coins: r.costCoins, format: r.format })
}

/** Same session/request identity survives gateway restart; no model assertion grants approval. */
function confirmDb() {
  if (!db) return null
  db.exec(`CREATE TABLE IF NOT EXISTS generation_confirmations (session_id TEXT NOT NULL, request_id TEXT NOT NULL, amount_coins REAL NOT NULL, model TEXT, input_signature TEXT, owner_hash TEXT, outcome TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, PRIMARY KEY(session_id,request_id))`)
  if (!(db.query("PRAGMA table_info(generation_confirmations)").all() as any[]).some(column => column.name === "owner_hash")) db.exec("ALTER TABLE generation_confirmations ADD COLUMN owner_hash TEXT")
  return db
}
function confirmationOwner(state: SessionState): string { return createHash("sha256").update(state.apiKey).digest("hex") }
export function readSpendConfirmation(state: SessionState, requestId: string): {outcome:string; amount_coins?:number; model?:string; input_signature?:string; resolvedAt?:number} | undefined {
  const row = confirmDb()?.query("SELECT * FROM generation_confirmations WHERE session_id=? AND request_id=?").get(state.sessionId,requestId) as any
  if (row && row.owner_hash !== confirmationOwner(state)) throw new Error("confirmation_owner_changed")
  if (row) return {outcome:row.outcome === "pending" && Date.now()-row.created_at >= CONFIRM_TIMEOUT_MS ? "expired" : row.outcome, amount_coins:row.amount_coins,model:row.model ?? undefined,input_signature:row.input_signature ?? undefined,resolvedAt:row.resolved_at}
  return state.resolvedConfirms.get(requestId)
}

export async function handleConfirmRequest(req: Request): Promise<Response> {  let body: {
    session_id?: string
    request_id?: string
    amount_coins?: number
    input_signature?: string
    description?: string
    model?: string
    task_id?: string
  }
  try {
    body = (await req.json()) as {
      session_id?: string
      request_id?: string
      amount_coins?: number
      input_signature?: string
      description?: string
      model?: string
      task_id?: string
    }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, request_id } = body
  if (!session_id || !request_id) {
    return jsonError(400, "session_id and request_id are required", "bad_request", "bad_request")
  }
  const state = resolveSession(session_id) ?? subagentParentState(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")

  const amount = typeof body.amount_coins === "number" ? body.amount_coins : 0
  if (!Number.isFinite(amount) || amount < 0 || (body.input_signature != null && !/^[a-f0-9]{64}$/.test(body.input_signature)))
    return jsonError(400,"invalid confirmation amount/signature","bad_request","bad_request")
  const description = typeof body.description === "string" ? body.description : ""
  let receipt: ReturnType<typeof readSpendConfirmation>
  try {
    if (body.input_signature && !confirmDb()) return jsonError(503,"confirmation persistence unavailable","confirmation_unavailable","confirmation_unavailable")
    receipt = readSpendConfirmation(state,request_id)
  } catch { return jsonError(503,"confirmation persistence unavailable","confirmation_unavailable","confirmation_unavailable") }
  const pending = state.pendingConfirms.get(request_id)
  const existing = receipt ?? (pending?.ledger ? {...pending.ledger,outcome:"pending"} : undefined)
  if (existing && (existing.amount_coins !== amount || existing.model !== body.model || existing.input_signature !== body.input_signature))
    return jsonError(409,"request_id approval belongs to different input/model/amount","confirmation_conflict","confirmation_conflict")
  if (existing && existing.outcome !== "pending") return Response.json({status:existing.outcome,request_id})
  if (pending) {
    await approvePendingCharge(state,request_id)
    return Response.json({status:state.resolvedConfirms.get(request_id)?.outcome ?? "pending",request_id},{status:state.resolvedConfirms.has(request_id)?200:202})
  }
  // Restored pending receipts retain the same request and authority; recreate only the waiter.
  try { confirmDb()?.query("INSERT OR IGNORE INTO generation_confirmations(session_id,request_id,amount_coins,model,input_signature,owner_hash,outcome,created_at) VALUES(?,?,?,?,?,?,'pending',?)").run(state.sessionId,request_id,amount,body.model ?? null,body.input_signature ?? null,confirmationOwner(state),Date.now()) }
  catch { return jsonError(503,"confirmation persistence unavailable","confirmation_unavailable","confirmation_unavailable") }

  // 互动模式=auto：扣费确认不经用户，注册即批准（settleConfirm 内部落账+emit
  // confirm.resolved；工具下一次轮询 /internal/confirm-status 直接拿到 approved）。
  // 不 emit confirm.request（用户不看确认卡）。余额不足仍会被预检/结算拒掉，
  // 402 预算闸与批间 midBatchBudgetGate 不受影响（系统级安全，不是提问）。
  const autoApproved = await billingAutoApprovalEnabled(state)
  // 权限查询会让出执行权；其它首次注册/轮询/切档可能已注册或结清同一单。
  // 恢复执行后先重取真实状态，不能覆盖原 timer/callback 或重复生成账目。
  const racedResolved = state.resolvedConfirms.get(request_id)
  if (racedResolved) return Response.json({ status: racedResolved.outcome, request_id })
  const racedPending = state.pendingConfirms.get(request_id)
  if (racedPending) {
    if (autoApproved && racedPending.ledger) settleConfirm(state, request_id, "approved", { auto: true })
    const resolved = state.resolvedConfirms.get(request_id)
    if (resolved) return Response.json({ status: resolved.outcome, request_id })
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }
  // 此处到 pending 注册与同步 settle 之间没有 await，JS 执行段保持原子。
  if (autoApproved) {
    state.pendingConfirms.set(request_id, {
      timer: setTimeout(() => {}, 0),
      ledger: { amount_coins: amount, task_id: body.task_id, model: body.model, input_signature:body.input_signature },
    })
    if (!settleConfirm(state, request_id, "approved", { auto: true })) return jsonError(503,"confirmation persistence unavailable","confirmation_unavailable","confirmation_unavailable")
    return Response.json({ status: state.resolvedConfirms.get(request_id)?.outcome ?? "pending", request_id })
  }

  const timer = setTimeout(() => {
    // Expiry is a real outcome and must be announced. The old code only deleted
    // the entry, so the frontend's confirm card stayed on screen forever with no
    // way to tell it had already been decided against.
    settleConfirm(state, request_id, "expired")
  }, CONFIRM_TIMEOUT_MS)
  state.pendingConfirms.set(request_id, {
    timer,
    ledger: { amount_coins: amount, task_id: body.task_id, model: body.model, input_signature:body.input_signature },
  })

  // Surface the billing request to the frontend, then return immediately.
  // This request does NOT block for the answer: CONFIRM_TIMEOUT_MS (15 min)
  // exceeds both Bun's idleTimeout ceiling (255s) and the caller's abort, so
  // the tool polls /internal/confirm-status instead.
  emitToSession(state, "confirm.request", { request_id, amount_coins: amount, description })

  // 子代理在等钱时，确认卡只发前端，父代理那一侧完全看不到：2026-10-30 实测，用户在父会话里
  // 干等 30 分钟，父代理一路报「正在生成／已经超时」，直到确认请求过期才问到「放行 1 币」。
  // 这里给发起该笔扣费的子 run 推一条回报，父代理下一拍就能把真实卡点说给用户。
  const childRun = byChildOc.get(session_id)
  if (childRun) {
    pushParentNote(
      childRun,
      "charge_confirm",
      `子代理在等你放行 ${amount} 币（${description || "扣费确认"}）。确认卡只在页面上的卡片，聊天里说「放行」不算授权：请在卡片上选放行，或把互动模式切到自动。`,
    )
  }

  return Response.json({ status: "pending", request_id }, { status: 202 })
}

/** 只结清带扣费账目的确认；协作停点等非收费确认不得由此获得授权。 */
export async function approvePendingCharge(state: SessionState, requestId: string): Promise<boolean> {
  if (!state.pendingConfirms.get(requestId)?.ledger) return false
  if (!await billingAutoApprovalEnabled(state)) return false
  // await 期间可能已由用户/过期处理结清，settleConfirm 本身保证只执行一次。
  return settleConfirm(state, requestId, "approved", { auto: true })
}

/** 用户切入 full：同租户已弹出的收费卡立即结清并复用原续跑链。 */
export async function approveTenantPendingCharges(tenant: string): Promise<void> {
  for (const state of sessions.values()) {
    if (state.pendingConfirms.size === 0 || await billingPermissionTenant(state) !== tenant) continue
    for (const requestId of [...state.pendingConfirms.keys()]) await approvePendingCharge(state, requestId)
  }
}

/**
 * Move a confirm from pending to resolved, announce it, and bill it.
 * Single path for all three ways a confirm can end (user answer, expiry,
 * session teardown) so none of them can forget to emit confirm.resolved.
 */
export function settleConfirm(
  state: SessionState,
  requestId: string,
  outcome: ConfirmOutcome,
  options?: { auto?: boolean },
): boolean {
  const pending = state.pendingConfirms.get(requestId)
  if (!pending) return false
  try { if (outcome === "approved" && readSpendConfirmation(state,requestId)?.outcome === "expired") outcome = "expired" } catch { return false }
  // Persist approval before exposing it or waking any spender.
  try { confirmDb()?.query("UPDATE generation_confirmations SET outcome=?,resolved_at=? WHERE session_id=? AND request_id=?").run(outcome,Date.now(),state.sessionId,requestId) }
  catch { return false }
  clearTimeout(pending.timer)
  state.pendingConfirms.delete(requestId)

  state.resolvedConfirms.set(requestId, { outcome, resolvedAt: Date.now(), ...pending.ledger })
  if (state.resolvedConfirms.size > CONFIRM_RESOLVED_CAP) {
    const oldest = state.resolvedConfirms.keys().next()
    if (!oldest.done) state.resolvedConfirms.delete(oldest.value)
  }
  // WP2（2026-10-14）：confirm 唯一的**结算落定点**（user 答复／过期／会话拆除三路皆经此）。
  // 叫醒该 confirm 上所有长挂起 waiter（/internal/confirm-status 的 wait_ms）；无 waiter 时 no-op。
  // 只负责叫醒——键与呼叫端 register 一致（`confirm:<canonical sessionId>:<request_id>`）。
  notify(`confirm:${state.sessionId}:${requestId}`)

  const approved = outcome === "approved"
  // auto=true 只出现在「互动模式=auto 自动放行」路径：前端据此收起确认卡但不追加
  // notice（30 笔批量出图曾堆出 30 条「已同意该笔花费。」）。人工答复不传 auto 键。
  emitToSession(state, "confirm.resolved", { request_id: requestId, approved, ...(options?.auto ? { auto: true } : {}) })

  if (approved) {
    if (pending.ledger) {
      void appendLedgerFor(state, {
        kind: "confirm",
        event: "approved",
        cost_coins: pending.ledger.amount_coins,
        task_id: pending.ledger.task_id,
        model: pending.ledger.model,
      })
    }
    void emitQuotaChanged(state)
    // 2026-08-29 整改：批量执行 confirm 批准 → 触发续跑（非阻塞设计的另一半）。
    // 未注册回调的 confirm（image_* 单笔等）不受影响。
    const wfCont = wfGenerateContinuations.get(requestId)
    if (wfCont) {
      wfGenerateContinuations.delete(requestId)
      workflowGenerateApproved.set(wfCont.wfid, { amount: wfCont.amount, nodes: wfCont.nodes }) // 本批（节点数）已批；扩计画须重批
      // 修 2：批量批准额记入 billing 真值——节点失败时据此写 refund 终态行，
      // workflow_status 据此回真值对象。
      recordWorkflowApproval(wfCont.wfid, wfCont.amount) // H13：累加不覆写
      runWfGenerate(wfCont.state, wfCont.wfid)
    }
    // 2026-09-24 协作确认闸（collaborate 档）：停点批准 → 续跑。与上面的批次扣费
    // 续跑链同构但**完全不碰计费真值**（见 workflow-gw 的 wfGateContinuations 注：
    // 那条链会覆写 workflowBilling，把真实退款抹成 0）。request_id 前缀互斥
    //（wfgate_ vs wfgen_），两表不可能同时命中，这个呼叫对计费确认是 no-op。
    resumeWorkflowGate(requestId, true)
  } else {
    // 否决/过期（含会话拆除的 expired 冲刷）同样要解停点注册——否则该 workflow
    // 永远被当「已有一张未决卡」，后续 generate 再也弹不出确认卡（静默卡死）。
    resumeWorkflowGate(requestId, false)
  }
  return true
}

// 用 task_id（或按序）把 loading 节点置 error，resume 的 agent 文案讲人话。
export function emitImageFailed(
  state: SessionState,
  task_id: string,
  reason: string,
  refunded: boolean,
): void {
  // 0831：任务终态登记（失败）。task 可能不在登记表（重启丢内存态），不可假设存在。
  const t = state.sessionTasks.get(task_id)
  if (t) {
    t.status = "failed"
  }
  // 2026-10-18 止血：失败也是终态，冲刷 pendingCompact。
  flushPendingCompact(state)
  // S5a：失败原因人话化（原文保留），SSE 帧与画布 errorDetails 补 human_message。
  const human = humanMessageFor(reason)
  emitToSession(state, "image.failed", { task_id, reason, refunded, human_message: human })
  const unitId = task_id ? state.canvasUnitByTask.get(task_id) : undefined
  if (unitId) {
    const failPatch = { status: "error", errorDetails: reason, human_message: human }
    emitToSession(state, "canvas.node.updated", {
      unit_id: unitId,
      node_id: canvasResultNodeId(state.sessionId, unitId),
      patch: failPatch,
    })
    // 2026-09-20 写穿：失败 patch 同步落 canvasStates（快照无该节点时静默跳过）。
    applyCanvasNodeUpdated(state.sessionId, { unit_id: unitId, node_id: canvasResultNodeId(state.sessionId, unitId), patch: failPatch })
  }
  void appendLedgerFor(state, {
    kind: "image",
    event: refunded ? "refunded" : "failed",
    task_id,
  })
}

export function emitVideoFailed(
  state: SessionState,
  task_id: string,
  reason: string,
  refunded: boolean,
): void {
  // 0831：任务终态登记（失败）。task 可能不在登记表（重启丢内存态），不可假设存在。
  const t = state.sessionTasks.get(task_id)
  if (t) {
    t.status = "failed"
  }
  // 2026-10-18 止血：失败也是终态，冲刷 pendingCompact。
  flushPendingCompact(state)
  // S5a：失败原因人话化（原文保留），SSE 帧与画布 errorDetails 补 human_message。
  const human = humanMessageFor(reason)
  emitToSession(state, "video.failed", { task_id, reason, refunded, human_message: human })
  const unitId = task_id ? state.canvasUnitByTask.get(task_id) : undefined
  if (unitId) {
    const failPatch = { status: "error", errorDetails: reason, human_message: human }
    emitToSession(state, "canvas.node.updated", {
      unit_id: unitId,
      node_id: canvasResultNodeId(state.sessionId, unitId),
      patch: failPatch,
    })
    // 2026-09-20 写穿：失败 patch 同步落 canvasStates（快照无该节点时静默跳过）。
    applyCanvasNodeUpdated(state.sessionId, { unit_id: unitId, node_id: canvasResultNodeId(state.sessionId, unitId), patch: failPatch })
  }
  void appendLedgerFor(state, {
    kind: "video",
    event: refunded ? "refunded" : "failed",
    task_id,
  })
}

export function emitAudioFailed(
  state: SessionState,
  task_id: string,
  reason: string,
  refunded: boolean,
): void {
  // 0831：任务终态登记（失败）。task 可能不在登记表（重启丢内存态），不可假设存在。
  const t = state.sessionTasks.get(task_id)
  if (t) {
    t.status = "failed"
  }
  // 2026-10-18 止血：失败也是终态，冲刷 pendingCompact。
  flushPendingCompact(state)
  // S5a：失败原因人话化（原文保留），SSE 帧与画布 errorDetails 补 human_message。
  const human = humanMessageFor(reason)
  emitToSession(state, "audio.failed", { task_id, reason, refunded, human_message: human })
  const unitId = task_id ? state.canvasUnitByTask.get(task_id) : undefined
  if (unitId) {
    const failPatch = { status: "error", errorDetails: reason, human_message: human }
    emitToSession(state, "canvas.node.updated", {
      unit_id: unitId,
      node_id: canvasResultNodeId(state.sessionId, unitId),
      patch: failPatch,
    })
    // 2026-09-20 写穿：失败 patch 同步落 canvasStates（快照无该节点时静默跳过）。
    applyCanvasNodeUpdated(state.sessionId, { unit_id: unitId, node_id: canvasResultNodeId(state.sessionId, unitId), patch: failPatch })
  }
  void appendLedgerFor(state, {
    kind: "audio",
    event: refunded ? "refunded" : "failed",
    task_id,
  })
}

export async function handleInternalEmit(req: Request): Promise<Response> {
  let body: { session_id?: string; event?: string; data?: unknown }
  try {
    body = (await req.json()) as { session_id?: string; event?: string; data?: unknown }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const { session_id, event, data } = body
  if (!session_id || typeof event !== "string") {
    return jsonError(400, "session_id and event are required", "bad_request", "bad_request")
  }
  if (!INTERNAL_EMIT_ALLOWED.has(event) && !CANVAS_EMIT_ALLOWED.has(event)) {
    return jsonError(400, `event not allowed: ${event}`, "bad_request", "bad_request")
  }
  const state = resolveSession(session_id) ?? subagentParentState(session_id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")

  if (event === "image.done") {
    const d = (data ?? {}) as { url?: string; cost_coins?: number; task_id?: string }
    // Shared deduped path so /internal/emit and the opencode translation can
    // never announce the same url twice in one session. Awaited so the redirect
    // resolution completes before the poller gets its 200 and resumes the
    // session — otherwise the agent could describe an image the UI lacks.
    await emitImageDone(state, d.url ?? "", d.cost_coins, d.task_id)
  } else if (event === "video.done") {
    // 缺口 1（2026-10-02）：INTERNAL_EMIT_ALLOWED 早已放行 video.done，但 if 链
    // 无此分支 → 通过白名单后掉到链尾，什么都不发却回 {ok:true}（静默丢帧=假成功）。
    // 与 image.done 同构：共用 emitVideoDone（dedup 走 state.announcedUrls），
    // await 让 redirect/落帐在 poller 收到 200 前完成，poller 复活时 UI 不会缺卡。
    const d = (data ?? {}) as { url?: string; cost_coins?: number; task_id?: string; media_kind?: "video" | "film" }
    await emitVideoDone(state, d.url ?? "", d.cost_coins, d.task_id, d.media_kind)
  } else if (event === "audio.done") {
    // 同 video.done：放行却静默丢帧。共用 emitAudioDone，语义与前端 audio.done 卡对齐。
    const d = (data ?? {}) as { url?: string; cost_coins?: number; task_id?: string; media_kind?: "audio"; title?: string; cover?: string; lyric_status?: string }
    await emitAudioDone(state, d.url ?? "", d.cost_coins, d.task_id, d.media_kind, { title: d.title, cover: d.cover, lyric_status: d.lyric_status })
  } else if (event === "image.failed") {
    const d = (data ?? {}) as { task_id?: string; reason?: string; refunded?: boolean }
    if (d.task_id) emitImageFailed(state, d.task_id, d.reason ?? "生成失败", d.refunded === true)
  } else if (event === "video.failed") {
    // 与 image.failed 同构：白名单已放行，if 链必须有分支，否则静默丢帧假成功。
    const d = (data ?? {}) as { task_id?: string; reason?: string; refunded?: boolean }
    if (d.task_id) emitVideoFailed(state, d.task_id, d.reason ?? "生成失败", d.refunded === true)
  } else if (event === "audio.failed") {
    // 与 image.failed 同构：白名单已放行，if 链必须有分支，否则静默丢帧假成功。
    const d = (data ?? {}) as { task_id?: string; reason?: string; refunded?: boolean }
    if (d.task_id) emitAudioFailed(state, d.task_id, d.reason ?? "生成失败", d.refunded === true)
  } else if (event === "session.error") {
    const d = (data ?? {}) as { code?: string; message?: string }
    emitSessionError(state, d.code ?? "backend_error", d.message ?? "session error")
  } else if (event === "quota.changed") {
    void emitQuotaChanged(state)
  } else if (event === "tool.result") {
    emitToSession(state, "tool.result", data ?? {})
  } else if (event === "tool.progress") {
    emitToSession(state, "tool.progress", data ?? {})
  } else if (CANVAS_EMIT_ALLOWED.has(event)) {
    // 画布事件：纯透传，Frontend reducer 决定如何渲染。不做任何加工，
    // 保留 data 原样。这让 opencode 的 canvas_* 工具可以直接 speak 画布
    // 指令给前端，而不需要透过 message.delta 绕一圈。
    emitToSession(state, event, data ?? {})
  }
  return Response.json({ ok: true })
}
