// 共用 API client 層（PRD §377「邏輯只寫一次」）
// 負責：解析 caller 自己的 sk-biz-* key、簽章呼叫平台、錯誤對照表、
// 扣費確認閘門、前端事件推送、poller 註冊、定價表、回傳格式。
// 此檔不是 tool，不得 export tool 定義，必須放在 tools/ 之外。

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"

export const API_BASE = "https://image.tinchak0207.xyz/v1"
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const POLLER = process.env.POLLER_URL || "http://127.0.0.1:8082/"

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20MB

// ---------------------------------------------------------------------------
// 定價表（原散落在各 tool 的 IMAGE_PRICES / edit / upscale / video 估價）
// ---------------------------------------------------------------------------

// 幣價一律來自 GET /v1/models 的 x_coins_per_image，形狀是
// {standard:number, hd:number}（2026-08-07 實測 20 個模型）。
// 不要硬編碼價格表：實測發現舊表的 model id 有錯（haruka-v2 實為
// pixai-haruka-v2）、缺 15 個模型、且價格差 1000 倍（PixAI 0.001 vs
// gpt-image 6）——報錯價會讓 confirm 彈窗上的金額對不上真實扣費。
type PriceEntry = { standard?: number; hd?: number }

let catalogCache: { at: number; prices: Record<string, PriceEntry> } | null = null
const CATALOG_TTL_MS = 10 * 60 * 1000
const FALLBACK_COINS = 1 // 取不到目錄時的保守估值（偏高，寧可多問一次確認）

/** 讀取（並快取 10 分鐘）平台模型幣價目錄。取不到回 null，不 throw。 */
export async function loadCatalog(
  sessionID: string,
  signal?: AbortSignal,
): Promise<Record<string, PriceEntry> | null> {
  const now = Date.now()
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.prices
  try {
    const res = await platformFetch("/models", { method: "GET" }, sessionID, signal)
    if (!res.ok) return catalogCache?.prices ?? null
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> }
    const prices: Record<string, PriceEntry> = {}
    for (const m of body.data ?? []) {
      const id = typeof m.id === "string" ? m.id : null
      if (!id) continue
      const raw = m.x_coins_per_image
      if (typeof raw === "number") prices[id] = { standard: raw, hd: raw }
      else if (raw && typeof raw === "object") {
        const o = raw as Record<string, unknown>
        prices[id] = {
          standard: typeof o.standard === "number" ? o.standard : undefined,
          hd: typeof o.hd === "number" ? o.hd : undefined,
        }
      }
    }
    if (Object.keys(prices).length === 0) return catalogCache?.prices ?? null
    catalogCache = { at: now, prices }
    return prices
  } catch {
    return catalogCache?.prices ?? null
  }
}

// R7-A（2026-08-29）：視頻報價錨點=5 幣/秒（720P）/10 幣/秒（1080P），與 gateway
// videoTierPerSecond 同口徑。舊 0.05 是 RMB 混幣髒價殘留，曾致確認卡報 0.25 實扣 25（100 倍失真）。
const VIDEO_COIN_PER_SEC_720P = 5
const VIDEO_COIN_PER_SEC_1080P = 10

/**
 * 生圖單張幣價（權威值，來自平台目錄）。
 * quality: "hd" 走 hd 價，其餘走 standard。取不到目錄時回 FALLBACK_COINS。
 */
export async function priceForAsync(
  model: string,
  sessionID: string,
  quality?: string,
  signal?: AbortSignal,
): Promise<number> {
  const prices = await loadCatalog(sessionID, signal)
  const e = prices?.[model]
  if (!e) return FALLBACK_COINS
  const wantHd = quality === "hd"
  const v = wantHd ? (e.hd ?? e.standard) : (e.standard ?? e.hd)
  return typeof v === "number" ? v : FALLBACK_COINS
}

/** 生影片估價：720P 5 幣/秒 / 1080P 10 幣/秒，預設 10 秒（quality="hd" 走 1080P 檔） */
export function estimateVideoCoins(duration_seconds?: number, quality?: string): number {
  const secs = duration_seconds || 10
  const per = quality === "hd" ? VIDEO_COIN_PER_SEC_1080P : VIDEO_COIN_PER_SEC_720P
  return Math.round(secs * per * 100) / 100
}

/**
 * 改圖估價：走平台目錄的模型單價，跟生圖同一個權威來源。
 * 舊版按 size 猜（1k=3 幣 / 2k=5 幣），但平台是按模型計價、不按尺寸，
 * 猜出來的數字會讓 confirm 彈窗金額跟真實扣費差幾千倍（PixAI 0.001 vs 猜的 3）。
 */
export async function estimateEditCoins(
  model: string,
  sessionID: string,
  quality?: string,
  signal?: AbortSignal,
): Promise<number> {
  return priceForAsync(model, sessionID, quality, signal)
}

/**
 * 放大估價：同樣取目錄單價。scale 只影響輸出尺寸，不影響平台計價，
 * 所以不再用 scale 推算幣值。
 */
export async function estimateUpscaleCoins(
  model: string,
  sessionID: string,
  quality?: string,
  signal?: AbortSignal,
): Promise<number> {
  return priceForAsync(model, sessionID, quality, signal)
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function randomUUID(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === "function") return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const keyCache = new Map<string, string>()
const keyInflight = new Map<string, Promise<string>>()

/**
 * 從 gateway（loopback）解析 caller 自己的 sk-biz-* key。
 * gateway 無法解析時（如 CLI session 沒有 gateway 側記錄）退回
 * process.env.HARNESS_API_KEY。以 sessionID 快取。
 */
export async function resolveKey(sessionID: string, signal?: AbortSignal): Promise<string> {
  const cached = keyCache.get(sessionID)
  if (cached) return cached
  const inFlight = keyInflight.get(sessionID)
  if (inFlight) return inFlight

  const p = (async () => {
    try {
      const resp = await fetch(`${GATEWAY}/internal/session-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionID }),
        signal,
      })
      if (resp.ok) {
        const body = await resp.json().catch(() => ({}))
        const apiKey = body?.api_key
        if (typeof apiKey === "string" && apiKey) {
          keyCache.set(sessionID, apiKey)
          return apiKey
        }
      }
    } catch {
      // gateway 無法解析，走 fallback
    }
    const fallback = process.env.HARNESS_API_KEY
    if (!fallback) {
      throw new Error("無法解析 API key：gateway 無此 session 記錄且無 HARNESS_API_KEY")
    }
    keyCache.set(sessionID, fallback)
    return fallback
  })()

  keyInflight.set(sessionID, p)
  try {
    return await p
  } finally {
    keyInflight.delete(sessionID)
  }
}

/** 簽章 + 呼叫平台。處理 JSON 與 multipart（FormData 不手動設 Content-Type）。 */
// ---- per-key rate limiting (D-22) ----
//
// The platform enforces 60 requests / 60s per sk-biz- key with a SLIDING WINDOW
// (see the site's src/lib/biz-api-keys.ts: BIZ_KEY_DEFAULT_RPM / RATE_WINDOW_MS),
// and one agent turn can fire many tool calls. Without a limiter here, a dense
// iteration loop just collects 429s halfway through and the user sees a turn die
// for no reason they can act on.
//
// So this mirrors the platform's own algorithm rather than approximating it with
// a token bucket: same sliding window, but a smaller budget, so the local limiter
// always trips first and the platform's 429 is never reached.
//
// Requests WAIT rather than fail. A rate limit is a pacing problem, not an error:
// the work is still valid, it just has to go slower.
const RATE_LIMIT_MAX = 55 // < platform's 60, leaving headroom for clock skew and retries
const RATE_LIMIT_WINDOW_MS = 60_000
// Safety valve. Waiting is right; waiting forever is not — a runaway loop would
// otherwise pile up unbounded waiters and the turn would look hung with no reason.
const RATE_LIMIT_MAX_WAIT_MS = 120_000

interface RateWindow {
  /** Timestamps of recent sends, oldest first. */
  hits: number[]
  /** Serializes waiters for this key so they don't all wake at once and overshoot. */
  tail: Promise<void>
}

const rateWindows = new Map<string, RateWindow>()

/**
 * Block until sending one request for `key` stays inside the local window.
 * Throws only if the wait would exceed RATE_LIMIT_MAX_WAIT_MS, or on abort.
 */
async function acquireRateSlot(key: string, signal?: AbortSignal): Promise<void> {
  let win = rateWindows.get(key)
  if (!win) {
    win = { hits: [], tail: Promise.resolve() }
    rateWindows.set(key, win)
  }
  const w = win

  // Chain onto the tail: one waiter admitted at a time per key. Without this,
  // N concurrent callers would each independently read the same window state,
  // all conclude there is room, and blow straight past the limit.
  const mine = w.tail.then(async () => {
    const deadline = Date.now() + RATE_LIMIT_MAX_WAIT_MS
    for (;;) {
      if (signal?.aborted) throw new Error("aborted")
      const now = Date.now()
      // Drop anything older than the window; those no longer count against us.
      while (w.hits.length > 0 && now - w.hits[0] >= RATE_LIMIT_WINDOW_MS) w.hits.shift()
      if (w.hits.length < RATE_LIMIT_MAX) {
        w.hits.push(now)
        return
      }
      // Full: the earliest hit is what has to age out before a slot frees.
      const waitMs = RATE_LIMIT_WINDOW_MS - (now - w.hits[0]) + 5
      if (now + waitMs > deadline) {
        throw new Error(`rate limit wait exceeded ${Math.round(RATE_LIMIT_MAX_WAIT_MS / 1000)}s`)
      }
      await sleep(waitMs, signal)
    }
  })

  // Keep the chain alive even if this waiter throws, or one abort would wedge
  // every later request for this key behind a permanently rejected tail.
  w.tail = mine.then(
    () => undefined,
    () => undefined,
  )
  return mine
}

/**
 * 站點本體 origin（Vercel 全功能應用直服，不帶 /v1）。
 * 生產 next.config.mjs 把 /v1/:path* 與 /api/v1/:path* 改寫到 VPS 控制面，
 * 而控制面那棵樹是落後的分叉（沒有角色卡路由）；/api/biz/* 不在改寫清單內，
 * 由站點本體服務（有 Blob、有完整五值卡模型）。角色卡與 tag 解析走這裡。
 */
export const SITE_BASE = "https://image.tinchak0207.xyz"

/**
 * 簽章 + 出網的共用核心：key 解析、限流、header 組裝只寫一次。
 * platformFetch（/v1 控制面）與 siteFetch（/api/biz 站點本體）共用同一套，
 * 差別只有 origin 前綴。
 */
async function fetchWithBase(
  base: string,
  path: string,
  init: RequestInit,
  sessionID: string,
  signal?: AbortSignal,
): Promise<Response> {
  const key = await resolveKey(sessionID, signal)
  await acquireRateSlot(key, signal)
  const headers = new Headers(init.headers)
  if (typeof init.body === "string") headers.set("Content-Type", "application/json")
  headers.set("Authorization", `Bearer ${key}`)
  return fetch(`${base}${path}`, { ...init, headers, signal })
}

/** 簽章 + 呼叫平台（/v1 控制面）。處理 JSON 與 multipart（FormData 不手動設 Content-Type）。 */
export async function platformFetch(
  path: string,
  init: RequestInit,
  sessionID: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithBase(API_BASE, path, init, sessionID, signal)
}

/**
 * 簽章 + 呼叫站點本體（/api/biz/*）：同一把 sk-biz-* key、同一套 header 組裝與限流，
 * 只換 origin。用於 /v1 控制面分叉沒有的路由（角色卡、tag 解析）。
 */
export async function siteFetch(
  path: string,
  init: RequestInit,
  sessionID: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithBase(SITE_BASE, path, init, sessionID, signal)
}

/** 從已解析 body / 拋出錯誤取出小寫錯誤訊息 */
function extractMsg(err?: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err.toLowerCase()
  if (err instanceof Error) return err.message.toLowerCase()
  const body = err as any
  return String(body?.error?.message || body?.message || "").toLowerCase()
}

/**
 * 失敗回應 / 拋出錯誤 → PRD 錯誤對照表。
 * 402 → insufficient_quota（告知充值，勿重試）
 * 413 → too_large（壓縮重傳）
 * 429 → rate_limited（等 Retry-After，附 retry_after_ms）
 * message 含 "model" → bad_model（換表內模型名）
 * message 含 "Your store is blocked" → blob_blocked（改 response_format=json，勿重發）
 */
export async function classifyError(
  res: Response | null,
  err?: unknown,
): Promise<{ code: string; hint: string; retry_after_ms?: number }> {
  if (!res) {
    if (err instanceof Error && err.name === "AbortError") {
      return { code: "aborted", hint: "操作已中止" }
    }
    // 0913 誠實歸因：本地路徑不存在/過大/空檔等參數錯誤自帶 code，
    // 不得再被兜底成 network_error 套「上游原因」誤導重試。
    const code = err instanceof Error ? (err as any).code : undefined
    if (typeof code === "string" && code) {
      return { code, hint: (err as Error).message }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { code: "network_error", hint: msg || "網路錯誤" }
  }

  const msg = extractMsg(err)
  if (res.status === 402) {
    // R9-C（2026-09-30）：402 來自站點錢包預扣閘（quota-precheck / sync-charge），是「用戶帳戶
    // 餘額」層的失敗，與模型/通路無關（evidence：yuri-op-mv SSE 9868 把 pixai 的 402 誤報成「無通路」）。
    return {
      code: "insufficient_quota",
      hint: "餘額不足：用戶平台帳戶錢包餘額不夠扣這一單（帳戶層失敗，不是模型/通路不可用；換任何付費模型都會同樣失敗）。請如實告知用戶「是餘額不足、需充值」，勿重試、勿換模型試探；也不得宣稱任何付費通路「可用/是活的」——本次沒有任何圖生成成功。",
    }
  }
  if (res.status === 413) {
    return { code: "too_large", hint: "圖片超過 20MB，請壓縮後重傳" }
  }
  if (res.status === 429) {
    const headerSeconds = Number(res.headers.get("retry-after"))
    const bodySeconds = Number((err as any)?.retry_after ?? (err as any)?.retry_after_seconds)
    const seconds = headerSeconds > 0 ? headerSeconds : bodySeconds > 0 ? bodySeconds : 60
    return {
      code: "rate_limited",
      hint: "超過 60rpm，請等待後再重試",
      retry_after_ms: seconds * 1000,
    }
  }
  if (msg.includes("your store is blocked")) {
    return { code: "blob_blocked", hint: "儲存空間被封鎖，請改 response_format=json 拿直鏈，勿重發" }
  }
  // R9-C：站點 size 白名單拒單（400 unsupported_size）具名透出，附上游原文（含可選尺寸清單）。
  if (String((err as any)?.error?.code ?? "") === "unsupported_size") {
    return {
      code: "unsupported_size",
      hint: `${(err as any)?.error?.message || "不支持的 size"}（參數錯誤，請求未進入生成與計費；這不證明通路或餘額可用）`,
    }
  }
  if (msg.includes("model")) {
    return { code: "bad_model", hint: "模型名錯誤，換表內模型名重試" }
  }
  const bodyCode = String((err as any)?.error?.code ?? (err as any)?.code ?? "")
  if (res.status === 404 || bodyCode === "task_not_found") {
    return {
      code: "task_not_found",
      hint: "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：不带 task_id 重新调用本工具，可取回本轮全部真实任务 ID 与 URL。",
    }
  }
  return {
    code: `http_${res.status}`,
    hint: extractMsg(err) || "請求失敗",
  }
}

export interface ConfirmSpendInput {
  sessionID: string
  amount_coins: number
  description: string
  model?: string
  task_id?: string
  /** 用於平台 idempotency-key（edits/upscale 避免重試重複扣費） */
  request_id?: string
}

/**
 * 詢問用戶核准一筆花費。gateway 阻塞至多 ~90s，故 fetch 逾時 ≥100s。
 * 外部 signal（如 context.abort）也接上，用戶取消同樣能中止等待。
 * 任何失敗（gateway 錯誤 / 逾時 / 用戶取消）都回 false → caller 必須中止。
 */
export async function confirmSpend(
  input: ConfirmSpendInput,
  signal?: AbortSignal,
): Promise<boolean> {
  const request_id = input.request_id ?? randomUUID()

  // Register the request. The gateway answers immediately (202 pending) instead
  // of blocking, because the confirm window is 15 minutes and no HTTP request
  // survives that: Bun's idleTimeout caps at 255s. So: register, then poll.
  const registered = await postInternal(
    "/internal/confirm-request",
    {
      session_id: input.sessionID,
      request_id,
      amount_coins: input.amount_coins,
      description: input.description,
      ...(input.model ? { model: input.model } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
    },
    signal,
  )
  // Fail closed: if we cannot even register the request, nothing was shown to
  // the user, so nothing may be spent.
  if (!registered) return false
  if (registered.status === "approved") return true
  if (registered.status && registered.status !== "pending") return false

  const deadline = Date.now() + CONFIRM_POLL_TOTAL_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) return false
    await sleep(CONFIRM_POLL_INTERVAL_MS, signal)
    if (signal?.aborted) return false

    const status = await postInternal(
      "/internal/confirm-status",
      { session_id: input.sessionID, request_id },
      signal,
    )
    // A transient failure to reach the gateway is not an answer. Keep polling
    // until the deadline rather than reading a blip as a denial.
    if (!status) continue
    if (status.status === "approved") return true
    if (status.status && status.status !== "pending") return false
  }
  return false
}

const CONFIRM_POLL_INTERVAL_MS = 2_000
// Slightly past the gateway's own 15-minute expiry so the loop sees the real
// "expired" outcome instead of giving up first and reporting its own timeout.
const CONFIRM_POLL_TOTAL_MS = 16 * 60 * 1000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

interface InternalStatusBody {
  status?: string
  request_id?: string
  reason?: string
}

/** POST a loopback internal route with a bounded per-request timeout. */
async function postInternal(
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<InternalStatusBody | null> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const resp = await fetch(`${GATEWAY}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    // 202 is the pending case and carries a body worth reading, so accept any
    // 2xx here rather than resp.ok-and-nothing-else.
    const body = (await resp.json().catch(() => null)) as InternalStatusBody | null
    if (!resp.ok && resp.status !== 202) {
      // 4xx/5xx with a status field (e.g. denied/session_gone) is still an answer.
      return body?.status ? body : null
    }
    return body ?? {}
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** 推送前端事件（白名單：image.done / session.error / tool.progress / video.done / audio.done / canvas.*）。fire-and-forget，失敗不外拋。 */
const CANVAS_EMIT_EVENTS = new Set([
  "canvas.plan",
  "canvas.node.created",
  "canvas.node.updated",
  "canvas.node.connected",
  "canvas.node.deleted",
  "canvas.node.generating",
  "canvas.derive.started",
  "canvas.budget.updated",
])
export async function emitEvent(
  sessionID: string,
  event: string,
  data: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (event !== "image.done" && event !== "session.error" && event !== "tool.progress" && event !== "video.done" && event !== "audio.done" && !CANVAS_EMIT_EVENTS.has(event)) return
  try {
    await fetch(`${GATEWAY}/internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionID, event, data }),
      signal,
    })
  } catch {
    // 忽略：推送失敗不應影響 tool 結果
  }
}

/**
 * 註冊非同步任務給 poller 自動輪詢。best-effort，回 {ok, error?}。
 *
 * dedup_hash / model / cost_coins 一定要帶：
 * - dedup_hash 不帶，poller 的去重快取永遠不會命中（等於整段死碼），
 *   同一個 prompt 重送會再扣一次錢。
 * - cost_coins 不帶，平台輪詢回應裡沒有價格欄位（2026-08-07 實測），
 *   poller 發出的 image.done 就會少掉 cost_coins，前端顯示不出扣費、
 *   帳本那一列也缺金額。
 */
export async function registerTask(
  task_id: string,
  sessionID: string,
  kind: string,
  signal?: AbortSignal,
  extra?: { dedup_hash?: string; model?: string; cost_coins?: number },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(POLLER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id,
        session_id: sessionID,
        kind,
        ...(extra?.dedup_hash ? { dedup_hash: extra.dedup_hash } : {}),
        ...(extra?.model ? { model: extra.model } : {}),
        ...(typeof extra?.cost_coins === "number" ? { cost_coins: extra.cost_coins } : {}),
      }),
      signal,
    })
    if (!resp.ok) return { ok: false, error: `poller http_${resp.status}` }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * (model, prompt, size, n) 的標準化去重 hash（PRD §437）。
 * 排序 key 後穩定字串化 + FNV-1a，跨 session 穩定。
 */
export function dedupHash(input: Record<string, unknown>): string {
  const norm: Record<string, unknown> = {
    model: input.model ?? "",
    prompt: input.prompt ?? "",
    size: input.size ?? "",
    n: input.n ?? 1,
  }
  const canonical = JSON.stringify(
    Object.keys(norm)
      .sort()
      .map((k) => [k, norm[k]]),
  )
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16)
}

/**
 * 解析 mediaId：已是 "media:" 開頭直接回；否則把圖片（URL 或本地路徑）
 * 上傳到平台 /uploads。上傳走 platformFetch（免費）。
 */
export async function resolveMediaId(
  image_url: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string> {
  if (image_url.startsWith("media:")) return image_url
  const up = await uploadImageBytes(image_url, sessionID, signal)
  return up.mediaId || image_url
}

/**
 * 讀取圖片來源 → POST /uploads（JSON base64 契約 {data, mimeType}，平台側
 * req.json()，multipart 必 400）→ { mediaId, url }。resolveMediaId 與
 * image_upload 工具共用此函數（邏輯只寫一次）。
 * 來源二分（2026-09-13 附件路徑閉環）：http(s)/data URL 走 fetch；其餘一律
 * 按本地路徑直讀字節 —— 聊天附件落盤 workspace/uploads/<sid>/，工具與附件
 * 同機（opencode-server 沙箱讀得到），此前只能吃 URL，本地路徑被 fetch 拒
 * （「fetch() URL is invalid」），agent 被迫繞道 base64/起 HTTP server 連環失敗。
 * 拋錯帶 .code → classifyError 誠實歸因，不再一律 network_error 冒充上游。
 */
export async function uploadImageBytes(
  imageSource: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<{ mediaId: string; url: string | null }> {
  const src = (imageSource || "").trim()
  if (!src) throw Object.assign(new Error("图片地址为空，请传 http(s)/data URL 或本地绝对路径"), { code: "bad_request" })
  let buf: Buffer
  let mimeType: string
  if (/^(https?:|data:)/i.test(src)) {
    const img = await fetch(src, { signal })
    if (!img.ok) {
      throw Object.assign(new Error(`下载原图失败：HTTP ${img.status}`), { code: "fetch_failed" })
    }
    buf = Buffer.from(await img.arrayBuffer())
    mimeType = (img.headers.get("content-type") || guessMime(src)).split(";")[0].trim() || "image/png"
  } else {
    const local = await readLocalImageBytes(src)
    buf = local.buffer
    mimeType = local.mimeType
  }
  if (buf.length === 0) throw Object.assign(new Error("图片内容为空"), { code: "bad_request" })
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(
      new Error(`图片超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB，请压缩后再传`),
      { code: "too_large" },
    )
  }
  const resp = await platformFetch(
    "/uploads",
    { method: "POST", body: JSON.stringify({ data: buf.toString("base64"), mimeType }) },
    sessionID,
    signal,
  )
  if (!resp.ok) {
    throw Object.assign(new Error(`原图入库失败：HTTP ${resp.status}`), { code: "upload_failed" })
  }
  const body = (await resp.json().catch(() => ({}))) as Record<string, any>
  const mediaId = body?.mediaId || body?.media_id || body?.id || body?.data?.[0]?.id || body?.url || ""
  return { mediaId, url: body?.url || body?.data?.[0]?.url || null }
}

/**
 * 讀本地圖片來源（chat 附件絕對路徑 / workspace 相對路徑）→ 位元組 + mime。
 * 路徑解析：原樣 → process.cwd() → /opt/agent-harness/workspace 依序命中。
 * 拋錯帶 .code 供 classifyError 誠實歸因。
 */
async function readLocalImageBytes(src: string): Promise<{ buffer: Buffer; mimeType: string; absPath: string }> {
  let abs = src
  if (!isAbsolute(abs)) {
    const hit = [process.cwd(), "/opt/agent-harness/workspace"]
      .map((base) => resolvePath(base, abs))
      .find((cand) => existsSync(cand))
    abs = hit || resolvePath(process.cwd(), abs)
  }
  if (!existsSync(abs)) {
    throw Object.assign(
      new Error(`本地图片文件不存在：${src}（请传附件解析出的绝对路径、http(s)/data URL 或 media: 图片 ID）`),
      { code: "not_found" },
    )
  }
  const buffer = readFileSync(abs)
  return { buffer, mimeType: guessMime(abs), absPath: abs }
}

/**
 * 把任意圖片來源歸一成「改圖端點可直接引用的 image 值」（2026-09-13 durable 改圖鏈）：
 * - http(s) URL / data:image URI：原樣放行（data URI 上限 ~4MB，站點端另有硬校驗）。
 * - media: 前綴：只屬 pixai 域，durable 鏈明確拒絕（誠實报错，不再 fetch 炸 URL invalid）。
 * - 本地絕對/相對路徑：沙箱內讀位元組 → 網關 /internal/media/upload（video_upload 同合同，
 *   網關已放行 image/*）→ 平台公網 URL。網關讀不到 agent 私有 /tmp，故位元組由沙箱側送上。
 */
export async function publicImageUrl(
  imageSource: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string> {
  const src = (imageSource || "").trim()
  if (!src) throw Object.assign(new Error("图片地址为空，请传 http(s)/data URL 或本地绝对路径"), { code: "bad_request" })
  if (/^https?:\/\//i.test(src)) return src
  if (/^data:image\//i.test(src)) {
    if (src.length > 6 * 1024 * 1024) {
      throw Object.assign(
        new Error("data URI 超过 6MB：请先用 video_upload 工具把图片入库平台存储，拿到公网 URL 再传入"),
        { code: "too_large" },
      )
    }
    return src
  }
  if (src.startsWith("media:")) {
    throw Object.assign(
      new Error("media: 图片 ID 只适用于 pixai 系模型（pixai-tsubaki2 等）；其他模型请传 http(s)/data URL 或本地绝对路径"),
      { code: "bad_request" },
    )
  }
  const { buffer, absPath } = await readLocalImageBytes(src)
  if (buffer.length === 0) throw Object.assign(new Error("图片内容为空"), { code: "bad_request" })
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(
      new Error(`图片超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB，请压缩后再传`),
      { code: "too_large" },
    )
  }
  const filename = absPath.split("/").pop() || "image.png"
  const res = await fetch(`${GATEWAY}/internal/media/upload?session_id=${sessionID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path_b64: buffer.toString("base64"), filename }),
    signal,
  }).catch((e) => {
    throw Object.assign(new Error(`图片入库失败：${(e as Error).message}`), { code: "upload_failed" })
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, any>
  if (!res.ok || !data?.ok || !data.url) {
    const hint = typeof data?.error === "string" && data.error ? data.error : `图片入库失败（HTTP ${res.status}）`
    throw Object.assign(new Error(hint), { code: "upload_failed" })
  }
  return data.url as string
}

/** 從檔名/URL 猜 mime：webp/jpg/jpeg/png/gif，未知回 png。 */
export function guessMime(url: string): string {
  const ext = (url.split(".").pop() || "png").toLowerCase().split("?")[0].split("#")[0]
  if (ext === "webp") return "image/webp"
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "gif") return "image/gif"
  return "image/png"
}

// ---------------------------------------------------------------------------
// 模型可用性探測（2026-08-15）：調用生成模型前必須確認可用，避免把請求發給
// 不可用的渠道。權威來源 = 平台 GET /v1/model-status；60 秒 per-model 緩存。
// 2026-08-27：透傳 last_24h（最近 24h 真實表現：jobs/delivered/failed/
// success_rate/refunded）——可用 ≠ 表現好，選模型時兩個都要看。
// ---------------------------------------------------------------------------

export type ModelLast24h = {
  modelId: string
  jobs: number
  delivered: number
  failed: number
  success_rate: number
  refunded: number
}

type ProbeResult = {
  availability: "available" | "unavailable" | "unknown"
  note?: string
  checked_at: string
  /** 最近 24h 真實生圖表現（樣本只覆蓋最近 200 條遙測事件；無樣本時缺省）。 */
  last_24h?: ModelLast24h
}

const probeCache = new Map<string, { at: number; result: ProbeResult }>()
const PROBE_TTL_MS = 60_000

/** 探測單一模型是否可用（走 platformFetch，不觸發生成、不扣費）。 */
export async function probeModelAvailable(
  model: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const cached = probeCache.get(model)
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result
  try {
    const resp = await platformFetch("/model-status", { method: "GET" }, sessionID, signal)
    const data = await resp.json().catch(() => null)
    const entry = data?.models?.find((m: any) => m?.id === model)
    const last24h = entry?.last_24h
    const result: ProbeResult = entry
      ? {
          availability: entry.availability ?? "unknown",
          ...(entry.note ? { note: String(entry.note) } : {}),
          checked_at: entry.checked_at ?? new Date().toISOString(),
          ...(last24h ? { last_24h: last24h as ModelLast24h } : {}),
        }
      : {
          availability: "unknown",
          note: resp.ok ? "模型不在 /v1/model-status 清單" : "探測端點不可用",
          checked_at: new Date().toISOString(),
        }
    probeCache.set(model, { at: Date.now(), result })
    return result
  } catch {
    const result: ProbeResult = {
      availability: "unknown",
      note: "探測失敗（網絡/認證）",
      checked_at: new Date().toISOString(),
    }
    probeCache.set(model, { at: Date.now(), result })
    return result
  }
}

/** 成功回傳：{ title?, output: JSON.stringify({ok:true, ...}) } */
export function ok(
  data: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): { title: string; output: string; metadata?: Record<string, unknown> } {
  const { title, ...rest } = data
  const result: { title: string; output: string; metadata?: Record<string, unknown> } = {
    title: (title as string) ?? "完成",
    output: JSON.stringify({ ok: true, ...rest }),
  }
  if (metadata) result.metadata = metadata
  return result
}

/** 失敗回傳：{ title?, output: JSON.stringify({ok:false, error:{code,hint}, ...extra}) } */
export function fail(
  code: string,
  hint: string,
  extra?: Record<string, unknown>,
): { title: string; output: string } {
  const { title, ...rest } = extra ?? {}
  return {
    title: (title as string) ?? "失敗",
    output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }),
  }
}
