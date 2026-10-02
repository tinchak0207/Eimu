// 圖像編排共用 lib（2026-08-31 片2）。
// 職責：批量生圖（站點 /v1/images/generations 計費鏈，與 image_generate.ts 同路徑，
// 嚴禁繞過計費直打上游）+ 內聯輪詢取 URL + 編輯鏈（/images/edits，同 image_edit.ts）
// + VLM 讀圖（new-api gemini-2.5-flash-image，key 運行時讀 control-plane env，永不打印）。
// 此檔不是 tool，不得 export tool 定義，必須放在 tools/ 之外（見 client.ts 頂部說明）。

import {
  platformFetch,
  priceForAsync,
  estimateEditCoins,
  confirmSpend,
  classifyError,
  probeModelAvailable,
  resolveMediaId,
  randomUUID,
  emitEvent,
} from "./client"
import { extractJson } from "./llm-channel"
import { safeFetch } from "./sandbox"
import { spawnSync } from "node:child_process"
import { aggregateBatchCost, type CostAggregate } from "./cost-accounting"

// VLM 讀圖前先由本機下載並內聯成 data URL（2026-09-29 e2e 實錘）：直接把 URL 交給上游，
// 上游得自己抓圖——eimu.dev 等站在 Cloudflare 後，非瀏覽器抓取被擋（400/502），webp 也未必收。
// 內聯後格式統一 jpeg/png；下載失敗才退回原 URL，不編造。
const VLM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
async function inlineImageForVlm(u: string): Promise<string> {
  if (!/^https?:\/\//i.test(u)) return u
  try {
    const res = await safeFetch(u, { headers: { "User-Agent": VLM_UA, Accept: "image/*,*/*" }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return u
    let bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) return u
    let mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (mime !== "image/jpeg" && mime !== "image/png") {
      const conv = spawnSync(
        "python3",
        ["-c", "import sys,io\nfrom PIL import Image\nim=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')\nb=io.BytesIO();im.save(b,'PNG');sys.stdout.buffer.write(b.getvalue())"],
        { input: bytes, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      )
      if (conv.status !== 0 || !conv.stdout?.length) return u
      bytes = conv.stdout
      mime = "image/png"
    }
    return `data:${mime};base64,${bytes.toString("base64")}`
  } catch {
    return u
  }
}

export const ORCH_DEFAULT_MODEL = "pixai-tsubaki2"
export const ORCH_DEFAULT_SIZE = "1024x1024"
// R9-C2（2026-09-30）：原本地硬寫 SUPPORTED_SIZES（缺 4096x4096，與站點漂移）已移除，改讀站點真源，見 supportedImageSizes()。

/**
 * 生圖尺寸白名單（R9-C2）：與 tools/image_generate.ts 的 supportedImageSizes() 同一真源——站點
 * GET /v1/openapi.json 的 components.schemas.ImageGenerationRequest.properties.size.enum。
 * 該函式在 tool 檔內且未 export（lib 不得依賴 tools/），故此處同形複刻：同端點、同欄位、快取 10 分鐘、
 * 取不到真源回 null → 呼叫端放行交上游裁決（上游 400 由 classifyError 具名成 unsupported_size）。
 */
let sizeWhitelistCache: { at: number; sizes: string[] } | null = null
const SIZE_WHITELIST_TTL_MS = 10 * 60 * 1000

export async function supportedImageSizes(sessionID: string, signal?: AbortSignal): Promise<string[] | null> {
  if (sizeWhitelistCache && Date.now() - sizeWhitelistCache.at < SIZE_WHITELIST_TTL_MS) return sizeWhitelistCache.sizes
  try {
    const resp = await platformFetch("/openapi.json", { method: "GET" }, sessionID, signal)
    if (!resp.ok) return sizeWhitelistCache?.sizes ?? null
    const spec: any = await resp.json().catch(() => null)
    const e = spec?.components?.schemas?.ImageGenerationRequest?.properties?.size?.enum
    const sizes = Array.isArray(e) ? e.filter((x: unknown): x is string => typeof x === "string" && !!x) : []
    if (sizes.length === 0) return sizeWhitelistCache?.sizes ?? null
    sizeWhitelistCache = { at: Date.now(), sizes }
    return sizes
  } catch {
    return sizeWhitelistCache?.sizes ?? null
  }
}

/** 「通路可用」宣告紀律（同 image_generate CHANNEL_NOT_VERIFIED）。 */
const CHANNEL_NOT_VERIFIED =
  "本次沒有生成出任何圖片，模型/付費通路的可用性未被驗證。只有真的成功出圖（拿到 url）才可對用戶說該模型/付費通路「可用、是活的」；參數錯誤、提交前被擋、確認被拒、insufficient_quota 都不算。insufficient_quota＝用戶帳戶餘額不足（帳戶層，換模型無效），model_unavailable＝模型通路故障（模型層，充值無效），兩者不可混報。"

/** 非法尺寸的同比例建議：按寬高比（對數距離）找最接近的合法尺寸，比例相同再比面積。接受 "WxH" 或 "W:H"。 */
function nearestAllowedSize(size: string, allowed: string[]): string | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[x×*:]\s*(\d+(?:\.\d+)?)\s*$/i.exec(size)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!(w > 0 && h > 0)) return null
  const isRatio = size.includes(":")
  let best: string | null = null
  let bestR = Infinity
  let bestA = Infinity
  for (const a of allowed) {
    const n = /^(\d+)x(\d+)$/.exec(a)
    if (!n) continue
    const aw = Number(n[1])
    const ah = Number(n[2])
    const dr = Math.abs(Math.log(w / h / (aw / ah)))
    const da = Math.abs(Math.log((isRatio ? 1024 * 1024 : w * h) / (aw * ah)))
    if (dr < bestR - 1e-9 || (Math.abs(dr - bestR) <= 1e-9 && da < bestA)) {
      best = a
      bestR = dr
      bestA = da
    }
  }
  return best
}

/** 報價/確認前的尺寸校驗：非法尺寸回 unsupported_size + 可選清單 + 同比例建議，不靜默改寫。真源取不到回 null（放行）。 */
async function checkSizes(
  reqs: GenReq[],
  sessionID: string,
  signal?: AbortSignal,
): Promise<{ code: string; hint: string; detail: Record<string, unknown> } | null> {
  const allowed = await supportedImageSizes(sessionID, signal)
  if (!allowed) return null
  const bad = [...new Set(reqs.map((r) => r.size).filter((s) => !allowed.includes(s)))]
  if (!bad.length) return null
  const size_suggestions = bad.map((s) => ({ requested: s, suggested: nearestAllowedSize(s, allowed) }))
  const sug = size_suggestions
    .map((x) => (x.suggested ? `${x.requested} → 同比例最接近的合法尺寸 ${x.suggested}` : `${x.requested}（無法解析比例）`))
    .join("；")
  return {
    code: "unsupported_size",
    hint: `不支持的 size ${bad.join("、")}（未提交、未跳確認、未扣費；不會替你靜默改成其他尺寸）。可選：${allowed.join("、")}。建議：${sug}。16:9/橫圖請用 1536x1024，豎圖用 1024x1536。改好 size 再調用。`,
    detail: { allowed_sizes: allowed, size_suggestions, channel_verified: false, note: CHANNEL_NOT_VERIFIED },
  }
}
export const SEED_NOTE =
  "平台 /v1/images/generations 契約不支持 seed 輸入/輸出（2026-08-31 源碼核實），seed 誠實標 null；跨圖一致性靠共用 DNA 後綴 + 統一 model/size 錨定，非魔法編碼。"

export interface GenReq {
  tag: string
  prompt: string
  model: string
  size: string
  n: number
}

export interface GenOutcome extends GenReq {
  task_id: string | null
  status: "succeeded" | "failed"
  url: string | null
  urls: string[]
  seed: null
  cost_coins: number | null
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 尺寸缺省補默認（R9-C2）：只在沒給 size 時補 1024x1024；非法尺寸不再靜默改寫，
 * 原樣交給 runGenBatch/planRequests 在報價與確認前對站點白名單校驗（非法 → unsupported_size + 同比例建議）。
 */
export function normalizeSize(size?: string): string {
  return size?.trim() || ORCH_DEFAULT_SIZE
}

export function parseJsonArray(
  raw: string,
  field: string,
): { ok: true; value: any[] } | { ok: false; hint: string } {
  try {
    const j = JSON.parse(raw)
    if (!Array.isArray(j) || j.length === 0) return { ok: false, hint: `${field} 必須是非空 JSON 陣列字串` }
    return { ok: true, value: j }
  } catch {
    return { ok: false, hint: `${field} 必須是合法 JSON 陣列字串` }
  }
}

export function parseJsonObject(
  raw: string,
  field: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; hint: string } {
  try {
    const j = JSON.parse(raw)
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, hint: `${field} 必須是 JSON 物件字串` }
    return { ok: true, value: j as Record<string, unknown> }
  } catch {
    return { ok: false, hint: `${field} 必須是合法 JSON 物件字串` }
  }
}

function extractUrls(body: any): string[] {
  const out: string[] = []
  const arr = body?.data
  if (Array.isArray(arr)) {
    for (const d of arr) {
      const u = d?.url || d?.result_url
      if (typeof u === "string" && u) out.push(u)
    }
  }
  const single = body?.result_url || body?.url
  if (typeof single === "string" && single) out.push(single)
  return [...new Set(out)]
}

/** dry_run 計劃：只讀免費目錄報價構造請求清單，不提交、不確認、零扣費。 */
export async function planRequests(reqs: GenReq[], sessionID: string, signal?: AbortSignal) {
  const sizeErr = await checkSizes(reqs, sessionID, signal)
  let estimated = 0
  const requests: Record<string, unknown>[] = []
  for (const r of reqs) {
    const unit = await priceForAsync(r.model, sessionID, undefined, signal)
    estimated += unit * r.n
    requests.push({ tag: r.tag, prompt: r.prompt, model: r.model, size: r.size, n: r.n, unit_coins: unit })
  }
  return {
    dry_run: true,
    requests,
    expected_images: reqs.reduce((s, r) => s + r.n, 0),
    estimated_cost_coins: Math.round(estimated * 1e6) / 1e6,
    ...(sizeErr ? { size_check: { ok: false, code: sizeErr.code, hint: sizeErr.hint, ...sizeErr.detail } } : {}),
    note: sizeErr
      ? `dry_run：未提交生圖、未扣費。注意：此清單 size 非法，原樣以 dry_run=false 執行會被拒（unsupported_size）——${sizeErr.hint}`
      : "dry_run：未提交生圖、未扣費。確認請求清單後以 dry_run=false 重調執行（計費鏈同 image_generate：總額 >0.1 幣會先跳出用戶確認）。",
  }
}

export type BatchResult =
  | ({ ok: true; results: GenOutcome[]; total_images: number; quoted_cost_coins: number } & CostAggregate)
  | { ok: false; code: string; hint: string; detail?: Record<string, unknown> }

/**
 * 批量生圖：探測模型可用 → 目錄報價 →（>0.1 幣 confirmSpend 一次）→
 * 逐請求 POST /images/generations → 內聯輪詢 GET /images/{task_id} 至完成。
 * 計費與 image_generate.ts 完全同鏈（站點 API 端 reserve/commit），不繞過。
 */
export async function runGenBatch(
  reqs: GenReq[],
  sessionID: string,
  abort?: AbortSignal,
  spendDescription?: string,
  progress?: { tool: string; label?: string },
): Promise<BatchResult> {
  if (!reqs.length) return { ok: false, code: "empty_batch", hint: "無生成請求" }
  // R9-C2：尺寸在探測/報價/confirm.request 之前校驗，非法尺寸不得讓用戶簽字，也不靜默改寫。
  const sizeErr = await checkSizes(reqs, sessionID, abort)
  if (sizeErr) return { ok: false, ...sizeErr }
  const models = [...new Set(reqs.map((r) => r.model))]
  for (const m of models) {
    const probe = await probeModelAvailable(m, sessionID, abort)
    if (probe.availability === "unavailable") {
      return {
        ok: false,
        code: "model_unavailable",
        hint: `模型 ${m} 目前不可用（${probe.note ?? "渠道故障"}）。這是模型／通路層故障，不是餘額問題（充值無效）；請改用可用模型（可查 /v1/model-status）。`,
        detail: { failure_codes: ["model_unavailable"], channel_verified: false, note: CHANNEL_NOT_VERIFIED },
      }
    }
  }
  let total = 0
  for (const r of reqs) total += (await priceForAsync(r.model, sessionID, undefined, abort)) * r.n
  total = Math.round(total * 1e6) / 1e6
  if (total > 0.1) {
    const approved = await confirmSpend(
      {
        sessionID,
        amount_coins: total,
        description: spendDescription || `圖像編排批量生圖 ${reqs.length} 項（${models.join(",")}），預估 ${total} 幣`,
      },
      abort,
    )
    if (!approved) return { ok: false, code: "user_declined", hint: "用戶未確認扣費，已取消。可減少張數或換更便宜模型。" }
  }

  const results: GenOutcome[] = []
  const pending: { req: GenReq; task_id: string }[] = []
  for (const r of reqs) {
    try {
      const resp = await platformFetch(
        "/images/generations",
        {
          method: "POST",
          body: JSON.stringify({ prompt: r.prompt, model: r.model, size: r.size, n: r.n, response_format: "url" }),
        },
        sessionID,
        abort,
      )
      const data = await resp.json().catch(() => ({}))
      const task_id = data?.task_id ?? data?.id ?? null
      if ((resp.status === 202 || (resp.ok && task_id)) && task_id) {
        pending.push({ req: r, task_id })
        continue
      }
      if (resp.ok) {
        const urls = extractUrls(data)
        if (urls.length) {
          results.push({
            ...r,
            task_id,
            status: "succeeded",
            url: urls[0],
            urls,
            seed: null,
            cost_coins: data?.cost_coins ?? data?.x_cost_coins ?? null,
          })
          continue
        }
      }
      const err = await classifyError(resp, data)
      results.push({ ...r, task_id: null, status: "failed", url: null, urls: [], seed: null, cost_coins: null, error: `${err.code}: ${err.hint}` })
    } catch (e: any) {
      const err = await classifyError(null, e)
      results.push({ ...r, task_id: null, status: "failed", url: null, urls: [], seed: null, cost_coins: null, error: `${err.code}: ${err.hint}` })
    }
  }

  if (progress) void emitEvent(sessionID, "tool.progress", { tool: progress.tool, done: results.length, total: reqs.length, label: progress.label }, abort)
  // 上游並行生成，本地輪詢查詢（查詢免費不扣費，同 image_get_result 端點）。
  const deadline = Date.now() + 300_000
  const timedOut: typeof pending = []
  for (const p of pending) {
    let done = false
    while (!done && Date.now() < deadline) {
      try {
        const resp = await platformFetch(`/images/${p.task_id}`, {}, sessionID, abort)
        const body = await resp.json().catch(() => ({}))
        const status = body?.status || body?.data?.[0]?.status
        const urls = extractUrls(body)
        if (urls.length && status !== "failed") {
          results.push({
            ...p.req,
            task_id: p.task_id,
            status: "succeeded",
            url: urls[0],
            urls,
            seed: null,
            cost_coins: body?.cost_coins ?? body?.x_cost_coins ?? null,
          })
          done = true
        } else if (status === "failed") {
          results.push({
            ...p.req,
            task_id: p.task_id,
            status: "failed",
            url: null,
            urls: [],
            seed: null,
            cost_coins: null,
            error: body?.error?.message || body?.message || "生成失敗（平台逾時自動退款）",
          })
          done = true
        }
      } catch {
        // 瞬時查詢失敗不判死，繼續輪詢
      }
      if (!done) await sleep(4000)
    }
    if (!done) timedOut.push(p)
    if (progress) void emitEvent(sessionID, "tool.progress", { tool: progress.tool, done: results.length, total: reqs.length, label: progress.label }, abort)
  }
  for (const p of timedOut) {
    results.push({
      ...p.req,
      task_id: p.task_id,
      status: "failed",
      url: null,
      urls: [],
      seed: null,
      cost_coins: null,
      error: "輪詢逾時 300s（任務可能仍在排隊，可用 image_get_result 續查）",
    })
  }

  // 成本對帳（2026-10-02）：上游輪詢回應常無「已結算價」（平台帳本秒級延遲）→ 逐項 cost_coins=null。
  // 缺值一律以 null 表示並附 cost_known/unpriced_items，永不以 0 冒充未知；有產出卻顯式 0 者標 cost_suspect 並 warn。
  const costAgg = aggregateBatchCost(results)
  if (!costAgg.cost_known) {
    console.warn(
      `[img-orchestrate] cost not fully settled: known_total=${costAgg.total_cost_coins ?? "unknown"} quoted=${total} unpriced=${costAgg.unpriced_items} suspect=${costAgg.cost_suspect}[${costAgg.cost_suspect_items.join(",")}]`,
    )
  }
  const totalImages = results.reduce((s, r) => s + r.urls.length, 0)
  // R9-C2（2026-09-30）：內部生圖失敗不得回綠燈，語義同 cast_asset_lock（R9-C）。
  // 全敗：單一原因用該錯誤碼（如 insufficient_quota），多原因 generation_failed；部分成功：partial_failed。
  // error 形如 "<code>: <hint>"（提交期 classifyError）；輪詢期失敗/逾時沒有 code，歸為 generation_failed。
  // 成功項 url 保留在 detail.results，並寫進 hint，呼叫端只轉 fail(code, hint) 也不會丟掉已付費的圖。
  const done = results.filter((r) => r.status === "succeeded").length
  if (done < results.length) {
    const failedItems = results.filter((r) => r.status !== "succeeded")
    const codes = [
      ...new Set(failedItems.map((r) => /^([a-z][a-z0-9_]*): /.exec(String(r.error ?? ""))?.[1] ?? "generation_failed")),
    ]
    const code = done > 0 ? "partial_failed" : codes.length === 1 ? codes[0] : "generation_failed"
    const firstErr = String(failedItems[0]?.error ?? "生成失敗").replace(/[。.\s]+$/, "")
    const okList = results
      .filter((r) => r.status === "succeeded")
      .map((r) => `${r.tag}→${r.url}`)
      .join("；")
    return {
      ok: false,
      code,
      hint:
        `批量生圖：${done}/${results.length} 成功，${results.length - done} 項沒生出來（失敗原因：${codes.join("、")}）。${firstErr}` +
        (done > 0
          ? `。已成功項（可直接引用）：${okList}`
          : firstErr.includes("本次沒有任何圖生成成功")
            ? "。"
            : "。本次沒有任何圖生成成功，模型/付費通路可用性未被驗證，不得對用戶宣稱通路可用。"),
      detail: {
        failure_codes: codes,
        channel_verified: done > 0,
        results: results.map((r) => ({
          tag: r.tag,
          status: r.status,
          model: r.model,
          size: r.size,
          task_id: r.task_id,
          url: r.url,
          urls: r.urls,
          cost_coins: r.cost_coins,
          ...(r.error ? { error: r.error } : {}),
        })),
        total_images: totalImages,
        quoted_cost_coins: total,
        ...costAgg,
        note:
          done > 0
            ? "只有 results[].status=succeeded 的項可引用；失敗項不得當作已完成。"
            : CHANNEL_NOT_VERIFIED,
      },
    }
  }
  return { ok: true, results, total_images: totalImages, quoted_cost_coins: total, ...costAgg }
}

/**
 * 編輯鏈單張（同 image_edit.ts 路徑：報價 → 確認閘門 → /images/edits 同步）。
 * 2026-08-31 片2 實測：站點 /v1/uploads（resolveMediaId）上游 PixAI 橋 404 故障，
 * 故 mediaId 解析失敗時誠實回退「原圖 URL 直傳 image 欄位」，image_mode 如實記錄。
 */
export async function runEdit(
  imageUrl: string,
  prompt: string,
  model: string,
  size: "1k" | "2k" | undefined,
  sessionID: string,
  abort?: AbortSignal,
): Promise<
  | { ok: true; url: string; cost_coins: number | null; task_id: string; image_mode: "mediaId" | "raw_url" }
  | { ok: false; code: string; hint: string }
> {
  const probe = await probeModelAvailable(model, sessionID, abort)
  if (probe.availability === "unavailable") {
    return { ok: false, code: "model_unavailable", hint: `編輯模型 ${model} 目前不可用（${probe.note ?? "渠道故障"}）` }
  }
  let image = imageUrl
  let image_mode: "mediaId" | "raw_url" = "raw_url"
  try {
    image = await resolveMediaId(imageUrl, sessionID, abort)
    image_mode = "mediaId"
  } catch {
    // uploads 橋不可用：原 URL 直傳（edits 路由對 image 欄位透傳上游）
  }
  try {
    const estimate = await estimateEditCoins(model, sessionID, undefined, abort)
    const request_id = randomUUID()
    if (estimate > 0.1) {
      const approved = await confirmSpend(
        { sessionID, amount_coins: estimate, description: `條件化生成（編輯鏈 ${model}），預估 ${estimate} 幣`, model, request_id },
        abort,
      )
      if (!approved) return { ok: false, code: "user_declined", hint: "用戶未確認扣費，已取消。" }
    }
    const payload: any = { image, prompt, model, response_format: "url" }
    if (size) payload.size = size
    const resp = await platformFetch(
      "/images/edits",
      { method: "POST", headers: { "idempotency-key": request_id }, body: JSON.stringify(payload) },
      sessionID,
      abort,
    )
    const body = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      const err = await classifyError(resp, body)
      return { ok: false, code: err.code, hint: err.hint }
    }
    const url = body?.data?.[0]?.url || body?.result_url || body?.url
    if (typeof url !== "string" || !url) return { ok: false, code: "no_result", hint: "編輯鏈未返回圖片 URL" }
    return { ok: true, url, cost_coins: body?.cost_coins ?? body?.x_cost_coins ?? estimate, task_id: request_id, image_mode }
  } catch (e: any) {
    const err = await classifyError(null, e)
    return { ok: false, code: err.code, hint: err.hint }
  }
}

// ---------------------------------------------------------------------------
// VLM 讀圖通道（new-api，2026-08-31 實彈驗證）。key 僅進程內使用，嚴禁入返回值/日誌。
// ---------------------------------------------------------------------------

const CP_ENV = "/opt/image-control-plane/.env.control-plane"
let vlmBases: string[] | null = null
let vlmKey: string | null = null

async function resolveVlm(): Promise<{ bases: string[]; key: string } | null> {
  if (vlmBases && vlmKey) return { bases: vlmBases, key: vlmKey }
  try {
    const { readFileSync } = await import("node:fs")
    const txt = readFileSync(CP_ENV, "utf8")
    const pick = (k: string): string | null => {
      const m = txt.match(new RegExp(`^${k}=(.*)$`, "m"))
      if (!m) return null
      return m[1].trim().replace(/^["']|["']$/g, "") || null
    }
    const key = pick("NEWAPI_API_KEY")
    if (!key) return null
    const norm = (b: string): string => {
      let x = b.replace(/\/+$/, "")
      if (!/\/v\d+$/.test(x)) x += "/v1"
      return x
    }
    // env 的 NEWAPI_BASE_URL 可能是 docker 內部網域名（imagesite-new-api:3001，
    // 僅 control-plane 容器內可達）；harness 進程在宿主機，必須帶 loopback 候補。
    const bases: string[] = []
    const envBase = pick("NEWAPI_BASE_URL")
    if (envBase) bases.push(norm(envBase))
    const loop = "http://127.0.0.1:3001/v1"
    if (!bases.includes(loop)) bases.push(loop)
    vlmBases = bases
    vlmKey = key
    return { bases, key }
  } catch {
    return null
  }
}

export interface VlmResult {
  ok: boolean
  text?: string
  reason?: string
}

/** 多圖 VLM 提問（gemini-2.5-flash-image）。env base 不可達時自動試 loopback 候補。失敗回 ok:false，不編造。 */
export async function vlmAsk(imageUrls: string[], question: string, maxTokens = 1200): Promise<VlmResult> {
  const cfg = await resolveVlm()
  if (!cfg) return { ok: false, reason: "無法解析 VLM 通道（control-plane env 缺 NEWAPI_API_KEY）" }
  let lastReason = ""
  const inlined = await Promise.all(imageUrls.map(inlineImageForVlm))
  for (const base of cfg.bases) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: process.env.NEWAPI_VISION_MODEL?.trim() || "glm-5.3-flash", // 2026-09-29：hub 已下架 gemini-2.5-flash-image，改與 vision_analyze 同一視覺模型
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: question },
                ...inlined.map((u) => ({ type: "image_url", image_url: { url: u } })),
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) return { ok: false, reason: `VLM 上游 HTTP ${res.status}` }
      const body = (await res.json().catch(() => null)) as Record<string, any> | null
      const content = body?.choices?.[0]?.message?.content
      if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "VLM 回覆為空" }
      return { ok: true, text: content }
    } catch (e) {
      lastReason = `VLM 呼叫失敗（${base}）：${(e as Error)?.message || String(e)}`
      continue
    }
  }
  return { ok: false, reason: lastReason || "VLM 全部候補不可達" }
}

/** VLM 回覆解析為 JSON 物件（容忍 markdown 柵欄）。 */
export async function vlmAskJson(
  imageUrls: string[],
  question: string,
  maxTokens = 1200,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const r = await vlmAsk(imageUrls, `${question}\n只輸出一個 JSON 物件，不要其他文字。`, maxTokens)
  if (!r.ok) return { ok: false, reason: r.reason || "VLM 失敗" }
  const parsed = extractJson(r.text || "")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `VLM 回覆無法解析為 JSON：${(r.text || "").slice(0, 200)}` }
  }
  return { ok: true, data: parsed as Record<string, unknown> }
}
