// 图像编排共用 lib（2026-08-31 片2）。
// 职责：批量生图（站点 /v1/images/generations 计费链，与 image_generate.ts 同路径，
// 严禁绕过计费直打上游）+ 内联轮询取 URL + 编辑链（/images/edits，同 image_edit.ts）
// + VLM 读图（new-api gemini-2.5-flash-image，key 运行时读 control-plane env，永不打印）。
// 此档不是 tool，不得 export tool 定义，必须放在 tools/ 之外（见 client.ts 顶部说明）。

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
import { spawn } from "node:child_process"
import { aggregateBatchCost, type CostAggregate } from "./cost-accounting"

// VLM 读图前先由本机下载并内联成 data URL（2026-09-29 e2e 实锤）：直接把 URL 交给上游，
// 上游得自己抓图——eimu.dev 等站在 Cloudflare 后，非浏览器抓取被挡（400/502），webp 也未必收。
// 内联后格式统一 jpeg/png；下载失败才退回原 URL，不编造。
const VLM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
const PY_TO_PNG =
  "import sys,io\nfrom PIL import Image\nim=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB')\nb=io.BytesIO();im.save(b,'PNG');sys.stdout.buffer.write(b.getvalue())"

/** stdin 进图、stdout 出 PNG。失败、超时或超过 64MB 回 null。异步 spawn，不堵事件循环。 */
function convertToPng(bytes: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", PY_TO_PNG], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = child.stdout
    const stderr = child.stderr
    const stdin = child.stdin
    if (!stdout || !stderr || !stdin) {
      child.kill("SIGKILL")
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    const max = 64 * 1024 * 1024
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (out: Buffer | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(null)
    }, 30_000)
    stdout.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        child.kill("SIGKILL")
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    stderr.on("data", () => {})
    child.on("error", () => finish(null))
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null)
        return
      }
      const out = Buffer.concat(chunks)
      finish(out.length > 0 ? out : null)
    })
    stdin.on("error", () => {})
    stdin.end(bytes)
  })
}

async function inlineImageForVlm(u: string): Promise<string> {
  if (!/^https?:\/\//i.test(u)) return u
  try {
    const res = await safeFetch(u, { headers: { "User-Agent": VLM_UA, Accept: "image/*,*/*" }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return u
    let bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) return u
    let mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    if (mime !== "image/jpeg" && mime !== "image/png") {
      const png = await convertToPng(bytes)
      if (!png) return u
      bytes = png
      mime = "image/png"
    }
    return `data:${mime};base64,${bytes.toString("base64")}`
  } catch {
    return u
  }
}

export const ORCH_DEFAULT_MODEL = "gpt-image-2.5-flare"
export const ORCH_DEFAULT_SIZE = "1024x1024"
// R9-C2（2026-09-30）：原本地硬写 SUPPORTED_SIZES（缺 4096x4096，与站点漂移）已移除，改读站点真源，见 supportedImageSizes()。

/**
 * 生图尺寸白名单（R9-C2）：与 tools/image_generate.ts 的 supportedImageSizes() 同一真源——站点
 * GET /v1/openapi.json 的 components.schemas.ImageGenerationRequest.properties.size.enum。
 * 该函式在 tool 档内且未 export（lib 不得依赖 tools/），故此处同形复刻：同端点、同栏位、快取 10 分钟、
 * 取不到真源回 null → 呼叫端放行交上游裁决（上游 400 由 classifyError 具名成 unsupported_size）。
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

/** 「通路可用」宣告纪律（同 image_generate CHANNEL_NOT_VERIFIED）。 */
const CHANNEL_NOT_VERIFIED =
  "本次没有生成出任何图片，模型/付费通路的可用性未被验证。只有真的成功出图（拿到 url）才可对用户说该模型/付费通路「可用、是活的」；参数错误、提交前被挡、确认被拒、insufficient_quota 都不算。insufficient_quota＝用户帐户余额不足（帐户层，换模型无效），model_unavailable＝模型通路故障（模型层，充值无效），两者不可混报。"

/** 非法尺寸的同比例建议：按宽高比（对数距离）找最接近的合法尺寸，比例相同再比面积。接受 "WxH" 或 "W:H"。 */
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

/** 报价/确认前的尺寸校验：非法尺寸回 unsupported_size + 可选清单 + 同比例建议，不静默改写。真源取不到回 null（放行）。 */
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
    .map((x) => (x.suggested ? `${x.requested} → 同比例最接近的合法尺寸 ${x.suggested}` : `${x.requested}（无法解析比例）`))
    .join("；")
  return {
    code: "unsupported_size",
    hint: `不支持的 size ${bad.join("、")}（未提交、未跳确认、未扣费；不会替你静默改成其他尺寸）。可选：${allowed.join("、")}。建议：${sug}。16:9/横图请用 1536x1024，竖图用 1024x1536。改好 size 再调用。`,
    detail: { allowed_sizes: allowed, size_suggestions, channel_verified: false, note: CHANNEL_NOT_VERIFIED },
  }
}
export const SEED_NOTE =
  "平台 /v1/images/generations 契约不支持 seed 输入/输出（2026-08-31 源码核实），seed 诚实标 null；跨图一致性靠共用 DNA 后缀 + 统一 model/size 锚定，非魔法编码。"

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
 * 尺寸缺省补默认（R9-C2）：只在没给 size 时补 1024x1024；非法尺寸不再静默改写，
 * 原样交给 runGenBatch/planRequests 在报价与确认前对站点白名单校验（非法 → unsupported_size + 同比例建议）。
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
    if (!Array.isArray(j) || j.length === 0) return { ok: false, hint: `${field} 必须是非空 JSON 阵列字串` }
    return { ok: true, value: j }
  } catch {
    return { ok: false, hint: `${field} 必须是合法 JSON 阵列字串` }
  }
}

export function parseJsonObject(
  raw: string,
  field: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; hint: string } {
  try {
    const j = JSON.parse(raw)
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, hint: `${field} 必须是 JSON 物件字串` }
    return { ok: true, value: j as Record<string, unknown> }
  } catch {
    return { ok: false, hint: `${field} 必须是合法 JSON 物件字串` }
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

/** dry_run 计划：只读免费目录报价构造请求清单，不提交、不确认、零扣费。 */
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
      ? `dry_run：未提交生图、未扣费。注意：此清单 size 非法，原样以 dry_run=false 执行会被拒（unsupported_size）——${sizeErr.hint}`
      : "dry_run：未提交生图、未扣费。确认请求清单后以 dry_run=false 重调执行（计费链同 image_generate：总额 >0.1 币会先跳出用户确认）。",
  }
}

export type BatchResult =
  | ({ ok: true; results: GenOutcome[]; total_images: number; quoted_cost_coins: number } & CostAggregate)
  | { ok: false; code: string; hint: string; detail?: Record<string, unknown> }

/**
 * 批量生图：探测模型可用 → 目录报价 →（>0.1 币 confirmSpend 一次）→
 * 逐请求 POST /images/generations → 内联轮询 GET /images/{task_id} 至完成。
 * 计费与 image_generate.ts 完全同链（站点 API 端 reserve/commit），不绕过。
 */
export async function runGenBatch(
  reqs: GenReq[],
  sessionID: string,
  abort?: AbortSignal,
  spendDescription?: string,
  progress?: { tool: string; label?: string },
): Promise<BatchResult> {
  if (!reqs.length) return { ok: false, code: "empty_batch", hint: "无生成请求" }
  // R9-C2：尺寸在探测/报价/confirm.request 之前校验，非法尺寸不得让用户签字，也不静默改写。
  const sizeErr = await checkSizes(reqs, sessionID, abort)
  if (sizeErr) return { ok: false, ...sizeErr }
  const models = [...new Set(reqs.map((r) => r.model))]
  for (const m of models) {
    const probe = await probeModelAvailable(m, sessionID, abort)
    if (probe.availability === "unavailable") {
      return {
        ok: false,
        code: "model_unavailable",
        hint: `模型 ${m} 目前不可用（${probe.note ?? "渠道故障"}）。这是模型／通路层故障，不是余额问题（充值无效）；请改用可用模型（可查 /v1/model-status）。`,
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
        description: spendDescription || `图像编排批量生图 ${reqs.length} 项（${models.join(",")}），预估 ${total} 币`,
      },
      abort,
    )
    if (!approved) return { ok: false, code: "user_declined", hint: "用户未确认扣费，已取消。可减少张数或换更便宜模型。" }
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
  // 上游并行生成，本地轮询查询（查询免费不扣费，同 image_get_result 端点）。
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
            error: body?.error?.message || body?.message || "生成失败（平台逾时自动退款）",
          })
          done = true
        }
      } catch {
        // 瞬时查询失败不判死，继续轮询
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
      error: "轮询逾时 300s（任务可能仍在排队，可用 image_get_result 续查）",
    })
  }

  // 成本对帐（2026-10-02）：上游轮询回应常无「已结算价」（平台帐本秒级延迟）→ 逐项 cost_coins=null。
  // 缺值一律以 null 表示并附 cost_known/unpriced_items，永不以 0 冒充未知；有产出却显式 0 者标 cost_suspect 并 warn。
  const costAgg = aggregateBatchCost(results)
  if (!costAgg.cost_known) {
    console.warn(
      `[img-orchestrate] cost not fully settled: known_total=${costAgg.total_cost_coins ?? "unknown"} quoted=${total} unpriced=${costAgg.unpriced_items} suspect=${costAgg.cost_suspect}[${costAgg.cost_suspect_items.join(",")}]`,
    )
  }
  const totalImages = results.reduce((s, r) => s + r.urls.length, 0)
  // R9-C2（2026-09-30）：内部生图失败不得回绿灯，语义同 cast_asset_lock（R9-C）。
  // 全败：单一原因用该错误码（如 insufficient_quota），多原因 generation_failed；部分成功：partial_failed。
  // error 形如 "<code>: <hint>"（提交期 classifyError）；轮询期失败/逾时没有 code，归为 generation_failed。
  // 成功项 url 保留在 detail.results，并写进 hint，呼叫端只转 fail(code, hint) 也不会丢掉已付费的图。
  const done = results.filter((r) => r.status === "succeeded").length
  if (done < results.length) {
    const failedItems = results.filter((r) => r.status !== "succeeded")
    const codes = [
      ...new Set(failedItems.map((r) => /^([a-z][a-z0-9_]*): /.exec(String(r.error ?? ""))?.[1] ?? "generation_failed")),
    ]
    const code = done > 0 ? "partial_failed" : codes.length === 1 ? codes[0] : "generation_failed"
    const firstErr = String(failedItems[0]?.error ?? "生成失败").replace(/[。.\s]+$/, "")
    const okList = results
      .filter((r) => r.status === "succeeded")
      .map((r) => `${r.tag}→${r.url}`)
      .join("；")
    return {
      ok: false,
      code,
      hint:
        `批量生图：${done}/${results.length} 成功，${results.length - done} 项没生出来（失败原因：${codes.join("、")}）。${firstErr}` +
        (done > 0
          ? `。已成功项（可直接引用）：${okList}`
          : firstErr.includes("本次没有任何图生成成功")
            ? "。"
            : "。本次没有任何图生成成功，模型/付费通路可用性未被验证，不得对用户宣称通路可用。"),
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
            ? "只有 results[].status=succeeded 的项可引用；失败项不得当作已完成。"
            : CHANNEL_NOT_VERIFIED,
      },
    }
  }
  return { ok: true, results, total_images: totalImages, quoted_cost_coins: total, ...costAgg }
}

/**
 * 编辑链单张（同 image_edit.ts 路径：报价 → 确认闸门 → /images/edits 同步）。
 * 2026-08-31 片2 实测：站点 /v1/uploads（resolveMediaId）上游 PixAI 桥 404 故障，
 * 故 mediaId 解析失败时诚实回退「原图 URL 直传 image 栏位」，image_mode 如实记录。
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
    return { ok: false, code: "model_unavailable", hint: `编辑模型 ${model} 目前不可用（${probe.note ?? "渠道故障"}）` }
  }
  let image = imageUrl
  let image_mode: "mediaId" | "raw_url" = "raw_url"
  try {
    image = await resolveMediaId(imageUrl, sessionID, abort)
    image_mode = "mediaId"
  } catch {
    // uploads 桥不可用：原 URL 直传（edits 路由对 image 栏位透传上游）
  }
  try {
    const estimate = await estimateEditCoins(model, sessionID, undefined, abort)
    const request_id = randomUUID()
    if (estimate > 0.1) {
      const approved = await confirmSpend(
        { sessionID, amount_coins: estimate, description: `条件化生成（编辑链 ${model}），预估 ${estimate} 币`, model, request_id },
        abort,
      )
      if (!approved) return { ok: false, code: "user_declined", hint: "用户未确认扣费，已取消。" }
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
    if (typeof url !== "string" || !url) return { ok: false, code: "no_result", hint: "编辑链未返回图片 URL" }
    return { ok: true, url, cost_coins: body?.cost_coins ?? body?.x_cost_coins ?? estimate, task_id: request_id, image_mode }
  } catch (e: any) {
    const err = await classifyError(null, e)
    return { ok: false, code: err.code, hint: err.hint }
  }
}

// ---------------------------------------------------------------------------
// VLM 读图通道（new-api，2026-08-31 实弹验证）。key 仅进程内使用，严禁入返回值/日志。
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
    // env 的 NEWAPI_BASE_URL 可能是 docker 内部网域名（imagesite-new-api:3001，
    // 仅 control-plane 容器内可达）；harness 进程在宿主机，必须带 loopback 候补。
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

/** 多图 VLM 提问（gemini-2.5-flash-image）。env base 不可达时自动试 loopback 候补。失败回 ok:false，不编造。 */
export async function vlmAsk(imageUrls: string[], question: string, maxTokens = 1200): Promise<VlmResult> {
  const cfg = await resolveVlm()
  if (!cfg) return { ok: false, reason: "无法解析 VLM 通道（control-plane env 缺 NEWAPI_API_KEY）" }
  let lastReason = ""
  const inlined = await Promise.all(imageUrls.map(inlineImageForVlm))
  for (const base of cfg.bases) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({
          model: process.env.NEWAPI_VISION_MODEL?.trim() || "glm-5.3-flash", // 2026-09-29：hub 已下架 gemini-2.5-flash-image，改与 vision_analyze 同一视觉模型
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
      if (typeof content !== "string" || !content.trim()) return { ok: false, reason: "VLM 回覆为空" }
      return { ok: true, text: content }
    } catch (e) {
      lastReason = `VLM 呼叫失败（${base}）：${(e as Error)?.message || String(e)}`
      continue
    }
  }
  return { ok: false, reason: lastReason || "VLM 全部候补不可达" }
}

/** VLM 回覆解析为 JSON 物件（容忍 markdown 栅栏）。 */
export async function vlmAskJson(
  imageUrls: string[],
  question: string,
  maxTokens = 1200,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const r = await vlmAsk(imageUrls, `${question}\n只输出一个 JSON 物件，不要其他文字。`, maxTokens)
  if (!r.ok) return { ok: false, reason: r.reason || "VLM 失败" }
  const parsed = extractJson(r.text || "")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `VLM 回覆无法解析为 JSON：${(r.text || "").slice(0, 200)}` }
  }
  return { ok: true, data: parsed as Record<string, unknown> }
}
