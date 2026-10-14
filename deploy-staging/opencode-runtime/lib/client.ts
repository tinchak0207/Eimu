// 共用 API client 层（PRD §377「逻辑只写一次」）
// 负责：解析 caller 自己的 sk-biz-* key、签章呼叫平台、错误对照表、
// 扣费确认闸门、前端事件推送、poller 注册、定价表、回传格式。
// 此档不是 tool，不得 export tool 定义，必须放在 tools/ 之外。

import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { createHash } from "node:crypto"
import { journalRegistration, pendingRegistrations, registeredTask, acquireSharedRateSlot, prepareSubmission, finishSubmission, getSubmission, contentHash, lockedProjectBudget, acceptTaskSubmission } from "./image-journal"

// WP3：VPS 本机直连控面，避免绕 Vercel 边缘（image.tinchak0207.xyz 由 Vercel 边缘
// 服务、middleware 再把 /v1/* 改写回 VPS 控面）。实测等价性：store.tinchak0207.xyz/
// image-control/api/v1 的 /openapi.json body sha256 与公网域名 image.tinchak0207.xyz/v1
// 完全相同（同一后端），但延时约 14ms vs 88~113ms。语义不变，只是换快路径。
export const API_BASE = process.env.PLATFORM_API_BASE || "https://store.tinchak0207.xyz/image-control/api/v1"
const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const POLLER = process.env.POLLER_URL || "http://127.0.0.1:8082/"

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20MB
const referenceSnapshots=new Map<string,{sha256:string;url:string|null;mediaId:string}>()

// ---------------------------------------------------------------------------
// 定价表（原散落在各 tool 的 IMAGE_PRICES / edit / upscale / video 估价）
// ---------------------------------------------------------------------------

// 币价一律来自 GET /v1/models 的 x_coins_per_image，形状是
// {standard:number, hd:number}（2026-08-07 实测 20 个模型）。
// 不要硬编码价格表：实测发现旧表的 model id 有错（haruka-v2 实为
// pixai-haruka-v2）、缺 15 个模型、且价格差 1000 倍（PixAI 0.001 vs
// gpt-image 6）——报错价会让 confirm 弹窗上的金额对不上真实扣费。
type PriceEntry = { standard?: number; hd?: number }

let catalogCache: { at: number; prices: Record<string, PriceEntry> } | null = null
const CATALOG_TTL_MS = 10 * 60 * 1000
const FALLBACK_COINS = 1 // 取不到目录时的保守估值（偏高，宁可多问一次确认）

/** 读取（并快取 10 分钟）平台模型币价目录。取不到回 null，不 throw。 */
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

// R7-A（2026-08-29）：视频报价锚点=5 币/秒（720P）/10 币/秒（1080P），与 gateway
// videoTierPerSecond 同口径。旧 0.05 是 RMB 混币脏价残留，曾致确认卡报 0.25 实扣 25（100 倍失真）。
const VIDEO_COIN_PER_SEC_720P = 5
const VIDEO_COIN_PER_SEC_1080P = 10

/**
 * 生图单张币价（权威值，来自平台目录）。
 * quality: "hd" 走 hd 价，其余走 standard。取不到目录时回 FALLBACK_COINS。
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

/** 生影片估价：720P 5 币/秒 / 1080P 10 币/秒，预设 10 秒（quality="hd" 走 1080P 档） */
export function estimateVideoCoins(duration_seconds?: number, quality?: string): number {
  const secs = duration_seconds || 10
  const per = quality === "hd" ? VIDEO_COIN_PER_SEC_1080P : VIDEO_COIN_PER_SEC_720P
  return Math.round(secs * per * 100) / 100
}

/**
 * 改图估价：走平台目录的模型单价，跟生图同一个权威来源。
 * 旧版按 size 猜（1k=3 币 / 2k=5 币），但平台是按模型计价、不按尺寸，
 * 猜出来的数字会让 confirm 弹窗金额跟真实扣费差几千倍（PixAI 0.001 vs 猜的 3）。
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
 * 放大估价：同样取目录单价。scale 只影响输出尺寸，不影响平台计价，
 * 所以不再用 scale 推算币值。
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
 * 从 gateway（loopback）解析 caller 自己的 sk-biz-* key。
 * gateway无法证明session归属就失败；不回退共享HARNESS_API_KEY，避免跨租户错单。
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
      // 运输失败不是凭证归属证据。
    }
    throw new Error("session_identity_unavailable: 网关暂不能证明本session凭证归属；保留原job，禁止回退共享key。")
  })()

  keyInflight.set(sessionID, p)
  try {
    return await p
  } finally {
    keyInflight.delete(sessionID)
  }
}

/** 签章 + 呼叫平台。处理 JSON 与 multipart（FormData 不手动设 Content-Type）。 */
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

/** 同账户跨进程共享SQLite滑窗；不是各lane各自持有Map。 */
async function acquireRateSlot(key: string, signal?: AbortSignal): Promise<void> {
  const account=createHash("sha256").update(key).digest("hex")
  const deadline=Date.now()+RATE_LIMIT_MAX_WAIT_MS
  for (;;) {
    if(signal?.aborted)throw new Error("aborted")
    const delay=acquireSharedRateSlot(account,Date.now(),RATE_LIMIT_MAX,RATE_LIMIT_WINDOW_MS)
    if(delay===0)return
    if(Date.now()+delay>deadline)throw new Error("shared_rate_limit_wait_exceeded")
    await sleep(delay,signal)
  }
}

/**
 * 站点本体 origin（Vercel 全功能应用直服，不带 /v1）。
 * 生产 next.config.mjs 把 /v1/:path* 与 /api/v1/:path* 改写到 VPS 控制面，
 * 而控制面那棵树是落后的分叉（没有角色卡路由）；/api/biz/* 不在改写清单内，
 * 由站点本体服务（有 Blob、有完整五值卡模型）。角色卡与 tag 解析走这里。
 */
// TODO（WP3 待验证）：本包不改 SITE_BASE——/api/biz/* 是否也在 store.tinchak0207.xyz/
// image-control 快路径上存在尚未验证（控面是落后分叉，可能没有 /api/biz/* 路由），
// 保持走公网本站 origin；验证后再决定是否切换。
export const SITE_BASE = "https://image.tinchak0207.xyz"

/**
 * 签章 + 出网的共用核心：key 解析、限流、header 组装只写一次。
 * platformFetch（/v1 控制面）与 siteFetch（/api/biz 站点本体）共用同一套，
 * 差别只有 origin 前缀。
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

/** 签章 + 呼叫平台（/v1 控制面）。处理 JSON 与 multipart（FormData 不手动设 Content-Type）。 */
export async function platformFetch(
  path: string,
  init: RequestInit,
  sessionID: string,
  signal?: AbortSignal,
): Promise<Response> {
  if(init.method?.toUpperCase()==="POST" && ["/images/edits","/upscale"].includes(path))return trackedLegacySubmission(path,init,sessionID,signal)
  return fetchWithBase(API_BASE, path, init, sessionID, signal)
}

/** 所有制作入口共用可信项目预算；模型参数只能收紧已授权cap。 */
export async function authorizedProjectBudget(sessionID:string,project:string,requested?:number,signal?:AbortSignal):Promise<{cap?:number;version:string;source:string}> {
  const receipt=await gatewayRequest("/internal/project-budget",{session_id:sessionID,project},signal)
  if(receipt.durable!==true)throw Object.assign(new Error("项目约束暂不可读取；保留原请求恢复。"),{code:"project_budget_unavailable"})
  if(requested!=null&&(!Number.isFinite(requested)||requested<0))throw Object.assign(new Error("预算收紧值无效；未提交。"),{code:"invalid_budget"})
  const cap=receipt.authorized===true?receipt.cap_coins:undefined
  if(receipt.authorized===true&&(typeof cap!=="number"||!Number.isFinite(cap)||cap<0||!receipt.version))throw Object.assign(new Error("已存在的预算约束记录无效；不能忽略上限继续提交。"),{code:"project_budget_unavailable"})
  return {cap:cap==null?requested:Math.min(cap,requested??cap),version:receipt.version?String(receipt.version):"no_extra_cap",source:receipt.authorized===true?String(receipt.source??"human_config"):requested==null?"no_extra_cap":"agent_constraint"}
}

async function trackedLegacySubmission(path:string,init:RequestInit,sessionID:string,signal?:AbortSignal):Promise<Response> {
  const payload=JSON.parse(String(init.body??"{}"));const metadata=payload.workflow?.metadata??{};const project=metadata.project
  if(typeof project!=="string"||!project.trim())throw Object.assign(new Error("改图/放大必须继承已授权project；未提交，不新开预算作用域。"),{code:"project_budget_unknown"})
  const headers=new Headers(init.headers);const requestID=headers.get("idempotency-key")??metadata.request_id
  if(!requestID)throw Object.assign(new Error("制作请求缺稳定request_id；未提交。"),{code:"request_id_required"})
  const scope=await productionScope(sessionID,project,signal);const prior=getSubmission(scope,requestID)
  if(prior?.task_id) {
    const listing=await gatewayRequest("/internal/session-tasks",{session_id:sessionID,project},signal)
    const task=listing.tasks?.find((t:any)=>t.task_id===prior.task_id)
    if(task)return Response.json({task_id:task.task_id,id:task.task_id,status:task.status,data:task.artifacts??[],cost_coins:task.cost_coins}, {status:task.status==="succeeded"?200:202})
    return Response.json({task_id:prior.task_id,status:"registration_pending",recoverable:true},{status:202})
  }
  const priorIdentity=prior?JSON.parse(prior.metadata_json):undefined
  if(priorIdentity?.input_signature&&priorIdentity.input_signature!==metadata.input_signature)throw Object.assign(new Error("原request_id输入意图已改变；未提交。"),{code:"idempotency_key_reused"})
  if(priorIdentity?.submitted_image&&prior.state!=="rejected")payload.image=priorIdentity.submitted_image
  let budget:{cap?:number;version:string;source:string}
  if(prior&&prior.state!=="rejected"&&priorIdentity?.budget_version&&lockedProjectBudget(scope)!=null)budget={cap:lockedProjectBudget(scope)!,version:priorIdentity.budget_version,source:priorIdentity.budget_source??"agent_constraint"}
  else budget=await authorizedProjectBudget(sessionID,project,metadata.project_budget_coins,signal)
  const catalog=await loadCatalog(sessionID,signal);const entry=catalog?.[payload.model];const quote=payload.quality==="hd"?(entry?.hd??entry?.standard):(entry?.standard??entry?.hd)
  if(typeof quote!=="number"||!Number.isFinite(quote)||quote<0)throw Object.assign(new Error("该改图/放大档位缺权威报价；未提交。"),{code:"price_unknown"})
  const cost=prior&&prior.state!=="rejected"?prior.reservation:quote*Math.max(1,Number(payload.n)||1)
  payload.cap_coins=Math.min(payload.cap_coins??cost,cost);payload.workflow={metadata:{...metadata,session_id:sessionID,request_id:requestID,budget_version:budget.version}}
  let referenceHash=priorIdentity?.reference_fingerprints?.[0]
  if(!referenceHash) {
    const snapshot=referenceSnapshots.get(payload.image)
    if(snapshot)referenceHash=snapshot.sha256
    else if(/^(https?:|data:image\/)/i.test(payload.image)) {
      const frozen=await uploadImageBytes(payload.image,sessionID,signal)
      if(!frozen.url)throw Object.assign(new Error("参考图快照缺固定产物地址"),{code:"reference_snapshot_missing"})
      payload.image=frozen.url;referenceHash=frozen.sha256
    }else throw Object.assign(new Error("既有媒体ID缺字节回执；请继承原图片URL以冻结实际内容，未生成。"),{code:"reference_unverified"})
  }
  payload.workflow.metadata.actual_reference_sha256=referenceHash
  const identity={scope,session_id:sessionID,project,request_id:requestID,model:payload.model,cost_coins:cost,budget_version:budget.version,budget_source:budget.source,submitted_image:payload.image,reference_fingerprints:[referenceHash],reference_version:referenceHash,input_signature:metadata.input_signature}
  prepareSubmission(identity,payload,null,budget.cap)
  let response:Response
  try {response=await fetchWithBase(API_BASE,path,{...init,headers,body:JSON.stringify(payload)},sessionID,signal)}catch(e){finishSubmission(scope,requestID,"submitting");throw e}
  const body=await response.clone().json().catch(()=>({}))
  if(!response.ok){finishSubmission(scope,requestID,response.status<500?"rejected":"submitting");return response}
  const upstreamID=body.task_id??body.id
  const artifacts=Array.isArray(body.data)?body.data.filter((a:any)=>typeof a.url==="string"):body.url?[{url:body.url}]:body.result_url?[{url:body.result_url}]:[]
  const authoritativeID=typeof upstreamID==="string"&&/^[0-9a-f-]{36}$/i.test(upstreamID)?upstreamID:undefined
  if(!authoritativeID&&!artifacts.length){finishSubmission(scope,requestID,"submitting");return Response.json({error:{code:"submission_unknown",message:"上游响应缺真实任务ID和产物；保留原幂等键与预算，不虚构任务。"},request_id:requestID,recoverable:true},{status:502})}
  const hex=contentHash({scope,requestID});const receiptID=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
  const id=authoritativeID??receiptID
  const extra={project,request_id:requestID,model:payload.model,cost_coins:cost,requested_count:Math.max(1,Number(payload.n)||1),...(artifacts.length?{result_source:"synchronous_receipt",completion:{status:artifacts.length>=Math.max(1,Number(payload.n)||1)?"succeeded":"failed",artifacts,cost_coins:body.cost_coins??cost}}:{})}
  acceptTaskSubmission(scope,requestID,id,{task_id:id,session_id:sessionID,kind:"image",...extra})
  await registerTask(id,sessionID,"image",signal,extra)
  return response
}

/**
 * 签章 + 呼叫站点本体（/api/biz/*）：同一把 sk-biz-* key、同一套 header 组装与限流，
 * 只换 origin。用于 /v1 控制面分叉没有的路由（角色卡、tag 解析）。
 */
export async function siteFetch(
  path: string,
  init: RequestInit,
  sessionID: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithBase(SITE_BASE, path, init, sessionID, signal)
}

/** 从已解析 body / 抛出错误取出小写错误讯息 */
function extractMsg(err?: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err.toLowerCase()
  if (err instanceof Error) return err.message.toLowerCase()
  const body = err as any
  return String(body?.error?.message || body?.message || "").toLowerCase()
}

/**
 * 失败回应 / 抛出错误 → PRD 错误对照表。
 * 402 → insufficient_quota（告知充值，勿重试）
 * 413 → too_large（压缩重传）
 * 429 → rate_limited（等 Retry-After，附 retry_after_ms）
 * message 含 "model" → bad_model（换表内模型名）
 * message 含 "Your store is blocked" → blob_blocked（改 response_format=json，勿重发）
 */
export async function classifyError(
  res: Response | null,
  err?: unknown,
): Promise<{ code: string; hint: string; retry_after_ms?: number }> {
  if (!res) {
    if (err instanceof Error && err.name === "AbortError") {
      return { code: "aborted", hint: "操作已中止" }
    }
    // 0913 诚实归因：本地路径不存在/过大/空档等参数错误自带 code，
    // 不得再被兜底成 network_error 套「上游原因」误导重试。
    const code = err instanceof Error ? (err as any).code : undefined
    if (typeof code === "string" && code) {
      return { code, hint: (err as Error).message }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { code: "network_error", hint: msg || "网路错误" }
  }

  const msg = extractMsg(err)
  if (res.status === 402) {
    // R9-C（2026-09-30）：402 来自站点钱包预扣闸（quota-precheck / sync-charge），是「用户帐户
    // 余额」层的失败，与模型/通路无关（evidence：yuri-op-mv SSE 9868 把 pixai 的 402 误报成「无通路」）。
    return {
      code: "insufficient_quota",
      hint: "余额不足：用户平台帐户钱包余额不够扣这一单（帐户层失败，不是模型/通路不可用；换任何付费模型都会同样失败）。请如实告知用户「是余额不足、需充值」，勿重试、勿换模型试探；也不得宣称任何付费通路「可用/是活的」——本次没有任何图生成成功。",
    }
  }
  if (res.status === 413) {
    return { code: "too_large", hint: "图片超过 20MB，请压缩后重传" }
  }
  if (res.status === 429) {
    const headerSeconds = Number(res.headers.get("retry-after"))
    const bodySeconds = Number((err as any)?.retry_after ?? (err as any)?.retry_after_seconds)
    const seconds = headerSeconds > 0 ? headerSeconds : bodySeconds > 0 ? bodySeconds : 60
    return {
      code: "rate_limited",
      hint: "超过 60rpm，请等待后再重试",
      retry_after_ms: seconds * 1000,
    }
  }
  if (msg.includes("your store is blocked")) {
    return { code: "blob_blocked", hint: "储存空间被封锁，请改 response_format=json 拿直链，勿重发" }
  }
  // R9-C：站点 size 白名单拒单（400 unsupported_size）具名透出，附上游原文（含可选尺寸清单）。
  if (String((err as any)?.error?.code ?? "") === "unsupported_size") {
    return {
      code: "unsupported_size",
      hint: `${(err as any)?.error?.message || "不支持的 size"}（参数错误，请求未进入生成与计费；这不证明通路或余额可用）`,
    }
  }
  if (msg.includes("model")) {
    return { code: "bad_model", hint: "模型名错误，换表内模型名重试" }
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
    hint: extractMsg(err) || "请求失败",
  }
}

export interface ConfirmSpendInput {
  sessionID: string
  amount_coins: number
  description: string
  model?: string
  task_id?: string
  /** 用于平台 idempotency-key（edits/upscale 避免重试重复扣费） */
  request_id?: string
}

/**
 * 询问用户核准一笔花费。第一步先向 gateway 登记请求（202 pending 立刻返回），
 * 之后以「长挂起取件」取得答复：每轮带 wait_ms 挂到 /internal/confirm-status，
 * gateway 在状态变化时立即回，或等满 wait_ms 回当前态（不再固定 2s 轮询）。
 * 外部 signal（如 context.abort）也接上，用户取消同样能中止等待。
 * 任何失败（gateway 错误 / 逾时 / 用户取消）都回 false → caller 必须中止（fail-closed）。
 */
export async function confirmSpend(
  input: ConfirmSpendInput,
  signal?: AbortSignal,
): Promise<boolean> {
  const request_id = input.request_id ?? randomUUID()

  // Register the request. The gateway answers immediately (202 pending) instead
  // of blocking, because the confirm window is 15 minutes and no HTTP request
  // survives that: Bun's idleTimeout caps at 255s. So: register once, then take
  // the answer by blocking pickup — each confirm-status call hangs on the
  // gateway (wait_ms) until the state changes or the wait window expires.
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

    const status = await postInternal(
      "/internal/confirm-status",
      { session_id: input.sessionID, request_id, wait_ms: CONFIRM_WAIT_MS },
      signal,
    )
    if (signal?.aborted) return false
    // A transient failure to reach the gateway is not an answer. Keep picking
    // up until the deadline rather than reading a blip as a denial.
    if (!status) continue
    if (status.status === "approved") return true
    if (status.status && status.status !== "pending") return false
  }
  return false
}

// 单次网关挂起上限：wait_ms>0 时 gateway 挂在内部端点上，直到 confirm 状态
// 变化（立即回）或等满此值（回当前态）。env CONFIRM_WAIT_MS 可覆写。
const CONFIRM_WAIT_MS = Number(process.env.CONFIRM_WAIT_MS || 20_000)
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
  // 若调用方带 wait_ms（长挂起取件），per-request 逾时必须放行整个挂起窗口，
  // 否则挂起会在 15s 被本地 abort 砍断、回 null 当成 transient。wait_ms 缺省
  // 0 时保持原来的 15s 上限不变。
  const waitMs =
    typeof (payload as { wait_ms?: unknown } | null)?.wait_ms === "number"
      ? (payload as { wait_ms: number }).wait_ms
      : 0
  const timeout = setTimeout(() => controller.abort(), 15_000 + waitMs)
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

/** 推送前端事件（白名单：image.done / session.error / tool.progress / video.done / audio.done / canvas.*）。fire-and-forget，失败不外抛。 */
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
    // 忽略：推送失败不应影响 tool 结果
  }
}

/** 获取账户隔离的制作 scope；只保存 key 的单向摘要，不保存任何凭证。 */
export async function productionScope(sessionID: string, project?: string, signal?: AbortSignal): Promise<string> {
  if(project) {
    const receipt=await gatewayRequest("/internal/project-budget",{session_id:sessionID,project},signal)
    if(receipt.durable!==true||typeof receipt.scope!=="string"||!receipt.scope)throw new Error("project_scope_unavailable: 缺可信稳定项目归属；可恢复原任务，不新生成。")
    return receipt.scope
  }
  // 非项目只读归属使用可信父会话ID；不随API key轮换改变产物scope。
  const key=await gatewayRequest("/internal/session-tasks",{session_id:sessionID},signal)
  if(key.durable!==true||!key.owner_scope)throw new Error("session_scope_unavailable")
  return String(key.owner_scope)
}

/** 内部耐久端点；有界超时，HTTP成功也必须检查协议字段。 */
export async function gatewayRequest(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const deadline = AbortSignal.timeout(8000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const resp = await fetch(`${GATEWAY}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: combined,
  })
  const result = await resp.json().catch(() => ({}))
  if (!resp.ok || result?.ok !== true) throw new Error(`gateway_${resp.status}: ${result?.error?.code ?? result?.error ?? "invalid_response"}`)
  return result
}

export async function flushTaskRegistrations(): Promise<void> {
  const pending=pendingRegistrations()
  for(let offset=0;offset<pending.length;offset+=16) {
    const outcomes=await Promise.all(pending.slice(offset,offset+16).map(async entry=>{
      try {
        const payload=JSON.parse(entry.registration_json)
        const result=await gatewayRequest("/internal/job-register",payload)
        if(result.durable===true) {
          if(payload.completion)await gatewayRequest("/internal/job-completion",{task_id:entry.task_id,...payload.completion})
          registeredTask(entry.task_id)
        }
        return "answered"
      } catch(e:any) {
        // 某旧席位409不能堵住其他项目；真正运输中断才停止整批，outbox始终保留。
        return /^gateway_4\d\d:/.test(e?.message??"") ? "answered" : "unreachable"
      }
    }))
    if(outcomes.every(value=>value==="unreachable"))break
  }
}

/** 上游接受后先落 SQLite outbox，再耐久登记网关，最后唤醒poller。 */
export async function registerTask(
  task_id: string, sessionID: string, kind: string, signal?: AbortSignal,
  extra?: { dedup_hash?: string; model?: string; cost_coins?: number; project?: string; frame?: number; request_id?: string; reference_version?: string; style_version?: string; requested_count?: number; size?: string; completion?:{status:string;artifacts:any[];cost_coins?:number}; result_source?:string },
): Promise<{ ok: boolean; durable: boolean; error?: string }> {
  const payload = { task_id, session_id: sessionID, kind, ...extra }
  journalRegistration(task_id, sessionID, payload)
  let durable = false
  let lastError = ""
  for (let attempt = 0; attempt < 2 && !durable; attempt++) {
    try {
      const result = await gatewayRequest("/internal/job-register", payload)
      durable = result.durable === true
      if (!durable) lastError = "gateway_missing_durable_receipt"
    } catch (e: any) { lastError = e?.message || "gateway_unreachable" }
  }
  if (!durable) return { ok: false, durable: false, error: lastError }
  if(extra?.completion) {
    try{await gatewayRequest("/internal/job-completion",{task_id,...extra.completion},signal)}
    catch{return {ok:false,durable:true,error:"artifact_completion_pending"}}
  }
  registeredTask(task_id)
  if(extra?.result_source==="synchronous_receipt")return {ok:true,durable:true}
  // 主收据已提交；poller唤醒只是可重试提示，不能撤销接受态。
  try {
    const resp = await fetch(POLLER, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) })
    return { ok: resp.ok, durable: true, ...(resp.ok ? {} : { error: `poller_http_${resp.status}` }) }
  } catch { return { ok: false, durable: true, error: "poller_wakeup_pending" } }
}

/**
 * (model, prompt, size, n) 的标准化去重 hash（PRD §437）。
 * 排序 key 后稳定字串化 + FNV-1a，跨 session 稳定。
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
 * 解析 mediaId：已是 "media:" 开头直接回；否则把图片（URL 或本地路径）
 * 上传到平台 /uploads。上传走 platformFetch（免费）。
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
 * 读取图片来源 → POST /uploads（JSON base64 契约 {data, mimeType}，平台侧
 * req.json()，multipart 必 400）→ { mediaId, url }。resolveMediaId 与
 * image_upload 工具共用此函数（逻辑只写一次）。
 * 来源二分（2026-09-13 附件路径闭环）：http(s)/data URL 走 fetch；其余一律
 * 按本地路径直读字节 —— 聊天附件落盘 workspace/uploads/<sid>/，工具与附件
 * 同机（opencode-server 沙箱读得到），此前只能吃 URL，本地路径被 fetch 拒
 * （「fetch() URL is invalid」），agent 被迫绕道 base64/起 HTTP server 连环失败。
 * 抛错带 .code → classifyError 诚实归因，不再一律 network_error 冒充上游。
 */
export async function uploadImageBytes(
  imageSource: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<{ mediaId: string; url: string | null; sha256:string }> {
  const src = (imageSource || "").trim()
  if (!src) throw Object.assign(new Error("图片地址为空，请传 http(s)/data URL 或本地绝对路径"), { code: "bad_request" })
  let buf: Buffer
  let mimeType: string
  if (/^(https?:|data:)/i.test(src)) {
    const img = /^data:/i.test(src)?await fetch(src,{signal}):await (await import("./sandbox")).safeFetch(src,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)})
    if (!img.ok||!img.body) throw Object.assign(new Error(`下载原图失败：HTTP ${img.status}`), { code: "fetch_failed" })
    const reader=img.body.getReader();const chunks:Uint8Array[]=[];let total=0
    try {for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;if(total>MAX_UPLOAD_BYTES)throw Object.assign(new Error("参考图超过20MB"),{code:"too_large"});chunks.push(item.value)}}catch(error){await reader.cancel().catch(()=>undefined);throw error}finally{reader.releaseLock()}
    buf = Buffer.concat(chunks)
    mimeType = (img.headers.get("content-type") || guessMime(src)).split(";")[0].trim() || "image/png"
  } else {
    const sandbox=await import("./sandbox")
    const absolute=resolvePath(sandbox.WORKSPACE,src)
    const verdict=sandbox.checkAgentPath(absolute,sessionID)
    if(!verdict.ok)throw Object.assign(new Error("参考图片路径被沙箱拒绝"),{code:"unsafe_reference_path"})
    const local = await readLocalImageBytes(absolute,sessionID)
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
  const receipt={mediaId,url:body?.url||body?.data?.[0]?.url||null,sha256:createHash("sha256").update(buf).digest("hex")}
  for(const id of [receipt.mediaId,receipt.url])if(id)referenceSnapshots.set(id,receipt)
  return receipt
}

/**
 * 读本地图片来源（chat 附件绝对路径 / workspace 相对路径）→ 位元组 + mime。
 * 路径解析：原样 → process.cwd() → /opt/agent-harness/workspace 依序命中。
 * 抛错带 .code 供 classifyError 诚实归因。
 */
async function readLocalImageBytes(src: string,sessionID:string): Promise<{ buffer: Buffer; mimeType: string; absPath: string }> {
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
  const sandbox=await import("./sandbox")
  const verdict=sandbox.checkAgentPath(abs,sessionID)
  if(!verdict.ok)throw Object.assign(new Error("参考图片路径被沙箱拒绝"),{code:"unsafe_reference_path"})
  const buffer = readFileSync(abs)
  return { buffer, mimeType: guessMime(abs), absPath: abs }
}

/**
 * 把任意图片来源归一成「改图端点可直接引用的 image 值」（2026-09-13 durable 改图链）：
 * - http(s) URL / data:image URI：原样放行（data URI 上限 ~4MB，站点端另有硬校验）。
 * - media: 前缀：只属 pixai 域，durable 链明确拒绝（诚实报错，不再 fetch 炸 URL invalid）。
 * - 本地绝对/相对路径：沙箱内读位元组 → 网关 /internal/media/upload（video_upload 同合同，
 *   网关已放行 image/*）→ 平台公网 URL。网关读不到 agent 私有 /tmp，故位元组由沙箱侧送上。
 */
export async function publicImageUrl(
  imageSource: string,
  sessionID: string,
  signal?: AbortSignal,
): Promise<string> {
  const src = (imageSource || "").trim()
  if (!src) throw Object.assign(new Error("图片地址为空，请传 http(s)/data URL 或本地绝对路径"), { code: "bad_request" })
  if (/^https?:\/\//i.test(src)) {
    const frozen=await uploadImageBytes(src,sessionID,signal)
    if(!frozen.url)throw Object.assign(new Error("参考图快照未返回固定产物地址"),{code:"reference_snapshot_missing"})
    return frozen.url
  }
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
  const { buffer, absPath } = await readLocalImageBytes(src,sessionID)
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

/** 从档名/URL 猜 mime：webp/jpg/jpeg/png/gif，未知回 png。 */
export function guessMime(url: string): string {
  const ext = (url.split(".").pop() || "png").toLowerCase().split("?")[0].split("#")[0]
  if (ext === "webp") return "image/webp"
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "gif") return "image/gif"
  return "image/png"
}

// ---------------------------------------------------------------------------
// 模型可用性探测（2026-08-15）：调用生成模型前必须确认可用，避免把请求发给
// 不可用的渠道。权威来源 = 平台 GET /v1/model-status；60 秒 per-model 缓存。
// 2026-08-27：透传 last_24h（最近 24h 真实表现：jobs/delivered/failed/
// success_rate/refunded）——可用 ≠ 表现好，选模型时两个都要看。
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
  /** 最近 24h 真实生图表现（样本只覆盖最近 200 条遥测事件；无样本时缺省）。 */
  last_24h?: ModelLast24h
}

const probeCache = new Map<string, { at: number; result: ProbeResult }>()
const PROBE_TTL_MS = 60_000

/** 探测单一模型是否可用（走 platformFetch，不触发生成、不扣费）。 */
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
          note: resp.ok ? "模型不在 /v1/model-status 清单" : "探测端点不可用",
          checked_at: new Date().toISOString(),
        }
    probeCache.set(model, { at: Date.now(), result })
    return result
  } catch {
    const result: ProbeResult = {
      availability: "unknown",
      note: "探测失败（网络/认证）",
      checked_at: new Date().toISOString(),
    }
    probeCache.set(model, { at: Date.now(), result })
    return result
  }
}

/** 成功回传：{ title?, output: JSON.stringify({ok:true, ...}) } */
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

/** 失败回传：{ title?, output: JSON.stringify({ok:false, error:{code,hint}, ...extra}) } */
export function fail(
  code: string,
  hint: string,
  extra?: Record<string, unknown>,
): { title: string; output: string } {
  const { title, ...rest } = extra ?? {}
  return {
    title: (title as string) ?? "失败",
    output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }),
  }
}
