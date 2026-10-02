// 從 index.ts 無損抽取（2026-09-19 第一階段）
// media-internal-routes.ts — Media 上傳/Canvas 內部 HTTP 處理器＋TTS＋confirm＋internal emit
// 涵蓋 index.ts 原行區：7636–7908（canvas/media handlers）、7910–8036（TTS）、
// 8165–8285（confirm）、8410–8483（emitImageFailed＋handleInternalEmit）。
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { jsonError } from "./gw-lib.ts"
import { subagentParentState } from "./subagent"
import { estimateTtsCoins } from "./pricing-and-validation"
import { loadUserSettings } from "./persistence"
import { normalizeUserSettings } from "./sessions-http.ts"
import type { SessionState, ConfirmOutcome } from "./types-gateway.ts"
import { INTERNAL_EMIT_ALLOWED, CANVAS_EMIT_ALLOWED, CONFIRM_TIMEOUT_MS, CONFIRM_RESOLVED_CAP, TTS_AUDIO_DIR, TTS_PUBLIC_BASE } from "./constants-gateway.ts"
import { resolveCanvasOps, sanitizeOpsResult, storeCanvasState, getCanvasState, validateCanvasOps, dispatchCanvasOps, checkTemplateGuard, canvasResultNodeId, applyCanvasNodeUpdated, CANVAS_OPS_TIMEOUT_MS } from "./canvas-cascade-state.ts"
import { resolveSession, getOwnedSession } from "./sessions-core.ts"
import { emitToSession } from "./sse-core.ts"
import { emitImageDone } from "./events-translate.ts"
import { emitSessionError } from "./emit-helpers.ts"
import { emitQuotaChanged, appendLedgerFor } from "./quota-ledger.ts"
import { humanMessageFor } from "./humanize-gw.ts"
import { wfGenerateContinuations, workflowGenerateApproved, workflowBilling, recordWorkflowApproval, runWfGenerate, resumeWorkflowGate } from "./workflow-gw.ts"
import { contentTypeForExt } from "./uploads-media.ts"
import { resolveAudioEntityTokens } from "./entity-resolve.ts"

// POST /internal/media/upload — agent 素材入庫：服務端下載外部影片/音頻 URL →
// 平台存儲（image-data uploads 目錄，公網面 store.tinchak0207.xyz/image-data/files/）。
// 外部 URL 直連常被 Cloudflare 403 挑戰攔截、/v1/uploads 拒收 video——
// 影片/音頻素材一律先經此端點入庫取得平台 URL，再注入工作流節點。
// 鑑權同其他 session 類 internal 路由：分發層 loopback 門 + session_id 解析。
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
  // 本地成片以 base64 位元組上傳：video_upload 工具跑在 opencode-server 沙箱（PrivateTmp=yes）內，
  // 讀得到 agent 寫進私有 /tmp 的成片；網關進程（PrivateTmp=no）讀不到該私有 /tmp，故由工具讀檔傳
  // 位元組、網關不碰 agent FS。仍校驗大小/視頻音頻圖片擴展名，保持「僅媒體」契約。
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
    if (!contentType.startsWith("video/") && !contentType.startsWith("audio/") && !contentType.startsWith("image/")) {
      return Response.json({ ok: false, error: `不支持的文件类型 "${srcExt}"（仅接受视频/音频/图片）` }, { status: 415 })
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
    if (!contentType.startsWith("video/") && !contentType.startsWith("audio/") && !contentType.startsWith("image/")) {
      return Response.json({ ok: false, error: `unsupported content-type "${contentType || "none"}"（仅接受 video/*、audio/* 或 image/*）` }, { status: 415 })
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
    outExt = contentType.startsWith("video/")
      ? "mp4"
      : contentType.startsWith("audio/")
        ? "mp3"
        : contentType.includes("jpeg")
          ? "jpg"
          : contentType.includes("webp")
            ? "webp"
            : contentType.includes("gif")
              ? "gif"
              : "png"
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

// POST /internal/canvas/dispatch-ops — opencode canvas_* 工具的下發入口。
// 阻塞至前端回執或逾時；timeout_ms 僅供測試縮短，上限即預設值。
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
  // 模板節點守衛：守接線契約與防平行重複生成（見 checkTemplateGuard）；偏離只認網關簽發 token。
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
        { ok: false, code: "OPS_TIMEOUT", request_id: err.request_id ?? null, error: "前端未在時限內回執畫布操作結果" },
        { status: 504 },
      )
    }
    console.error("[gateway] canvas dispatch-ops error:", e)
    return jsonError(500, "canvas ops dispatch failed", "server_error", "server_error")
  }
}

// POST /internal/canvas/ops-result — loopback 回執（body 帶 session_id）。
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

// POST /agent/v1/sessions/:id/canvas/state — 前端（經站點代理）快照上行。
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
  return Response.json({ ok: true, bytes: stored.bytes, updated_at: stored.updatedAt })
}

// GET /agent/v1/sessions/:id/canvas/state — 前端（經站點代理）快照下行。
// 2026-08-29 修復：站點路由 GET /api/agent/sessions/:id/canvas-state 代理到這裡，
// 但本網關此前只有 POST 沒有 GET → 刷新/恢復會話必然 404。語義對齊
// GET /internal/canvas/snapshot；getOwnedSession 內含 DB 懶恢復（canvasStates 回灌），
// 進程重啟/閒置回收後照樣讀得到。
export async function handleCanvasStatePublicGet(key: string, id: string): Promise<Response> {
  const state = getOwnedSession(key, id)
  if (!state) return jsonError(404, "session not found", "not_found", "not_found")
  const snap = getCanvasState(state.sessionId)
  return Response.json({
    ok: true,
    has_state: snap !== null,
    state: snap?.state ?? null,
    updated_at: snap?.updatedAt ?? null,
  })
}

// POST /agent/v1/sessions/:id/canvas/ops-result — 前端（經站點代理）回執。
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
// 背景：novel_film 8 環承諾裡的「配音」環此前是牆上菜單——劇本表按 4.5 字/秒
// 折算了秒數但整條鏈路沒有任何 TTS 消費方。此端點把配音變成真實可調用的
// 最小閉環：同步快速調用（不走 poller），輸入台詞文本，產出音頻 URL。
//
// 誠實原則（honest-error）：2026-08-30 起 TTS_UPSTREAM 指向本機 edge-tts-proxy(127.0.0.1:8893，
// /opt/edge-tts/，Microsoft edge-tts 免 key 中文音色)；此前 Groq playai-tts 已下架、orpheus 被 org 條款鎖死：
// - Groq playai-tts 已 decommissioned；canopylabs/orpheus-* 需 org 條款接受
//   且只有英文/阿拉伯文音色，無中文；
// - 平台 image.tinchak0207.xyz /v1/models 無任何 TTS 條目（seed_audio、
//   qwen_audio_tts、text2speech_v2 只存在於 higgsfield 快照文檔，未上線）；
// - new-api 渠道表只有 gpt-image-2 / nano-banana-pro，無 TTS 渠道。
// 所以本端點的上游調用路徑是「探測 → 上游不存在 → 誠實報錯」，不接任何
// 不穩定的外部免費 API 湊數。上游接入後只需改 TTS_UPSTREAM 一處。

export const TTS_UPSTREAM = {
  // Groq audio proxy（VPS 本機 8892，透傳 api.groq.com，KEY 在 .env）
  base: process.env.TTS_UPSTREAM_BASE || "http://127.0.0.1:8892",
  speechPath: "/openai/v1/audio/speech",
  model: process.env.TTS_UPSTREAM_MODEL || "canopylabs/orpheus-v1-english",
  voice: process.env.TTS_UPSTREAM_VOICE || "tara",
}

interface TtsProbeResult {
  available: boolean
  note: string
}

/** 探測 TTS 上游是否真的能產中文音頻（帶 60s 負緩存避免反覆打壞渠道）。 */
let ttsProbeCache: { at: number; result: TtsProbeResult } | null = null
export async function probeTtsUpstream(signal?: AbortSignal): Promise<TtsProbeResult> {
  if (ttsProbeCache && Date.now() - ttsProbeCache.at < 60_000) return ttsProbeCache.result
  let result: TtsProbeResult
  try {
    const res = await fetch(`${TTS_UPSTREAM.base}${TTS_UPSTREAM.speechPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_UPSTREAM.model,
        input: "测",
        voice: TTS_UPSTREAM.voice,
        response_format: "mp3",
      }),
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const buf = await res.arrayBuffer()
      const head = new Uint8Array(buf.slice(0, 3))
      const looksLikeAudio = buf.byteLength > 64 && (head[0] === 0x49 || head[0] === 0x52 || head[0] === 0xff)
      result = looksLikeAudio
        ? { available: true, note: "上游可用" }
        : { available: false, note: "上游返回 200 但載荷不是音頻" }
    } else {
      const bodyText = await res.text().catch(() => "")
      let msg = bodyText.slice(0, 200)
      try {
        const j = JSON.parse(bodyText)
        msg = (j?.error?.message || msg).slice(0, 200)
      } catch { /* keep raw */ }
      result = { available: false, note: `上游 HTTP ${res.status}: ${msg}` }
    }
  } catch (e) {
    result = { available: false, note: `上游不可達: ${e instanceof Error ? e.message : String(e)}` }
  }
  ttsProbeCache = { at: Date.now(), result }
  return result
}

/**
 * POST /agent/v1/tts { text, voice?, session 帶 Bearer key }
 * 同步調用：成功 → { ok, url, cost_coins, chars }；上游不可用 → 503 誠實錯誤。
 * 定價一律走 pricing-and-validation.ts 的 estimateTtsCoins（工具側不硬編碼）。
 */
export async function handleTts(key: string, req: Request): Promise<Response> {
  let body: { text?: string; voice?: string }
  try {
    body = (await req.json()) as { text?: string; voice?: string }
  } catch {
    return jsonError(400, "invalid json body", "bad_request", "bad_request")
  }
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return jsonError(400, "text is required", "bad_request", "bad_request")
  if (text.length > 2000) return jsonError(400, "text too long (max 2000 chars)", "bad_request", "bad_request")

  const probe = await probeTtsUpstream()
  if (!probe.available) {
    return jsonError(
      503,
      `配音（TTS）上游暂不可用：${probe.note}。台词已收到，但当前无法真实生成音轨；请如实告知用户，勿编造音频链接。`,
      "tts_unavailable",
      "tts_unavailable",
    )
  }

  // 行內實體 tag（`@[音频:夜雨环境音]`）展開（2026-09-25，音頻卡接線）。
  // 背景：`applyCharacterCards(..., { target: "audio" })` 此前**零生產呼叫端**——音頻卡只是
  // 型別層能力，`tts_speak` 收到 `@[音频:X]` 只會把字面串念出來。這裡在**送上游前**補上：
  // 文字含 `@[` 才打站點（零 token 零 HTTP），站點用 `target:"audio"` 就地展開音頻卡的鎖定片段。
  // **fail-open 硬契約**：解析失敗／逾時／形狀不符／缺 key → 原文照送，永不阻斷配音
  // （薄客戶端 entity-resolve.ts 已內建；其 warn 只印長度與 status，prompt 全文與 key 永不落 log）。
  const ttsText = await resolveAudioEntityTokens(text, undefined, { apiKey: key })
  if (ttsText.prompt !== text) {
    console.info(`[tts] 已展开行内实体 tag：prompt_length=${text.length}→${ttsText.prompt.length}`)
  }

  // 上游可用路徑（目前現實中走不到，保留完整閉環以便上游接入後即刻生效）
  try {
    const res = await fetch(`${TTS_UPSTREAM.base}${TTS_UPSTREAM.speechPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TTS_UPSTREAM.model,
        input: ttsText.prompt,
        voice: body.voice || TTS_UPSTREAM.voice,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const msg = (await res.text().catch(() => "")).slice(0, 200)
      return jsonError(502, `TTS upstream error: ${msg}`, "tts_upstream_error", "tts_upstream_error")
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 64) {
      return jsonError(502, "TTS upstream returned empty audio", "tts_empty_audio", "tts_empty_audio")
    }
    const id = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const fileName = `${id}.mp3`
    await mkdir(TTS_AUDIO_DIR, { recursive: true })
    await Bun.write(path.join(TTS_AUDIO_DIR, fileName), buf)
    const cost_coins = estimateTtsCoins("tts-zh", text)
    const url = `${TTS_PUBLIC_BASE}/${fileName}`
    return Response.json({ ok: true, url, chars: text.length, cost_coins, format: "mp3" })
  } catch (e) {
    return jsonError(502, `TTS upstream error: ${e instanceof Error ? e.message : String(e)}`, "tts_upstream_error", "tts_upstream_error")
  }
}

export async function handleConfirmRequest(req: Request): Promise<Response> {  let body: {
    session_id?: string
    request_id?: string
    amount_coins?: number
    description?: string
    model?: string
    task_id?: string
  }
  try {
    body = (await req.json()) as {
      session_id?: string
      request_id?: string
      amount_coins?: number
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

  // Idempotent by request_id. A re-post of a live request must NOT supersede it:
  // superseding used to resolve the earlier waiter to false, which with a polling
  // caller would read as "user denied" even though nobody had answered yet.
  const settled = state.resolvedConfirms.get(request_id)
  if (settled) return Response.json({ status: settled.outcome, request_id })
  if (state.pendingConfirms.has(request_id)) {
    return Response.json({ status: "pending", request_id }, { status: 202 })
  }

  const amount = typeof body.amount_coins === "number" ? body.amount_coins : 0
  const description = typeof body.description === "string" ? body.description : ""

  // 互动模式=auto：扣费确认不经用户，注册即批准（settleConfirm 内部落账+emit
  // confirm.resolved；工具下一次轮询 /internal/confirm-status 直接拿到 approved）。
  // 不 emit confirm.request（用户不看确认卡）。余额不足仍会被预检/结算拒掉，
  // 402 预算闸与批间 midBatchBudgetGate 不受影响（系统级安全，不是提问）。
  if (normalizeUserSettings(loadUserSettings(state.apiKey)).interaction_mode === "auto") {
    state.pendingConfirms.set(request_id, {
      timer: setTimeout(() => {}, 0),
      ledger: { amount_coins: amount, task_id: body.task_id, model: body.model },
    })
    settleConfirm(state, request_id, "approved")
    return Response.json({ status: "approved", request_id })
  }

  const timer = setTimeout(() => {
    // Expiry is a real outcome and must be announced. The old code only deleted
    // the entry, so the frontend's confirm card stayed on screen forever with no
    // way to tell it had already been decided against.
    settleConfirm(state, request_id, "expired")
  }, CONFIRM_TIMEOUT_MS)
  state.pendingConfirms.set(request_id, {
    timer,
    ledger: { amount_coins: amount, task_id: body.task_id, model: body.model },
  })

  // Surface the billing request to the frontend, then return immediately.
  // This request does NOT block for the answer: CONFIRM_TIMEOUT_MS (15 min)
  // exceeds both Bun's idleTimeout ceiling (255s) and the caller's abort, so
  // the tool polls /internal/confirm-status instead.
  emitToSession(state, "confirm.request", { request_id, amount_coins: amount, description })

  return Response.json({ status: "pending", request_id }, { status: 202 })
}

/**
 * Move a confirm from pending to resolved, announce it, and bill it.
 * Single path for all three ways a confirm can end (user answer, expiry,
 * session teardown) so none of them can forget to emit confirm.resolved.
 */
export function settleConfirm(state: SessionState, requestId: string, outcome: ConfirmOutcome): boolean {
  const pending = state.pendingConfirms.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timer)
  state.pendingConfirms.delete(requestId)

  state.resolvedConfirms.set(requestId, { outcome, resolvedAt: Date.now() })
  if (state.resolvedConfirms.size > CONFIRM_RESOLVED_CAP) {
    const oldest = state.resolvedConfirms.keys().next()
    if (!oldest.done) state.resolvedConfirms.delete(oldest.value)
  }

  const approved = outcome === "approved"
  emitToSession(state, "confirm.resolved", { request_id: requestId, approved })

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
    // 2026-08-29 整改：批量執行 confirm 批准 → 觸發續跑（非阻塞設計的另一半）。
    // 未註冊回調的 confirm（image_* 單筆等）不受影響。
    const wfCont = wfGenerateContinuations.get(requestId)
    if (wfCont) {
      wfGenerateContinuations.delete(requestId)
      workflowGenerateApproved.set(wfCont.wfid, { amount: wfCont.amount, nodes: wfCont.nodes }) // 本批（節點數）已批；擴計畫須重批
      // 修 2：批量批准額記入 billing 真值——節點失敗時據此寫 refund 終態行，
      // workflow_status 據此回真值對象。
      recordWorkflowApproval(wfCont.wfid, wfCont.amount) // H13：累加不覆寫
      runWfGenerate(wfCont.state, wfCont.wfid)
    }
    // 2026-09-24 協作確認閘（collaborate 檔）：停點批准 → 續跑。與上面的批次扣費
    // 續跑鏈同構但**完全不碰計費真值**（見 workflow-gw 的 wfGateContinuations 註：
    // 那條鏈會覆寫 workflowBilling，把真實退款抹成 0）。request_id 前綴互斥
    //（wfgate_ vs wfgen_），兩表不可能同時命中，這個呼叫對計費確認是 no-op。
    resumeWorkflowGate(requestId, true)
  } else {
    // 否決/過期（含會話拆除的 expired 沖刷）同樣要解停點註冊——否則該 workflow
    // 永遠被當「已有一張未決卡」，後續 generate 再也彈不出確認卡（靜默卡死）。
    resumeWorkflowGate(requestId, false)
  }
  return true
}

// 用 task_id（或按序）把 loading 節點置 error，resume 的 agent 文案講人話。
function emitImageFailed(
  state: SessionState,
  task_id: string,
  reason: string,
  refunded: boolean,
): void {
  // 0831：任務終態登記（失敗）。task 可能不在登記表（重啟丟內存態），不可假設存在。
  const t = state.sessionTasks.get(task_id)
  if (t) {
    t.status = "failed"
  }
  // S5a：失敗原因人話化（原文保留），SSE 幀與畫布 errorDetails 補 human_message。
  const human = humanMessageFor(reason, undefined)
  emitToSession(state, "image.failed", { task_id, reason, refunded, human_message: human })
  const unitId = task_id ? state.canvasUnitByTask.get(task_id) : undefined
  if (unitId) {
    const failPatch = { status: "error", errorDetails: reason, human_message: human }
    emitToSession(state, "canvas.node.updated", {
      unit_id: unitId,
      node_id: canvasResultNodeId(state.sessionId, unitId),
      patch: failPatch,
    })
    // 2026-09-20 寫穿：失敗 patch 同步落 canvasStates（快照無該節點時靜默跳過）。
    applyCanvasNodeUpdated(state.sessionId, { unit_id: unitId, node_id: canvasResultNodeId(state.sessionId, unitId), patch: failPatch })
  }
  void appendLedgerFor(state, {
    kind: "image",
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
  } else if (event === "image.failed") {
    const d = (data ?? {}) as { task_id?: string; reason?: string; refunded?: boolean }
    if (d.task_id) emitImageFailed(state, d.task_id, d.reason ?? "生成失敗", d.refunded === true)
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
    // 畫布事件：純透傳，Frontend reducer 決定如何渲染。不做任何加工，
    // 保留 data 原樣。這讓 opencode 的 canvas_* 工具可以直接 speak 畫布
    // 指令給前端，而不需要透過 message.delta 繞一圈。
    emitToSession(state, event, data ?? {})
  }
  return Response.json({ ok: true })
}
