// entity-resolve.ts —— 工作流节点生成的行内实体 tag（`@[种类:名称]`）解析**薄客户端**。
//
// 为什么是薄客户端而不是自己解析：token 展开、卡库查询、参考图落地（data:image → Blob）
// 已经在站点端点 `POST /api/biz/character-resolve` 实作，且**已在生产实锤**（agent 工具那条
// 路送 4 个行内 tag，真的带回 4 张参考图）。闸道这里只做四件事：要不要打（零 token 不打）、
// 呼叫、回应形状校验、fail-open + 短 TTL 快取。**不重写 regex、不查卡库**——复制第二套解析
// 必然与站点漂移（禁造轮子）。
//
// 硬契约（设计，不是偷懒）：**token 解析失败永远不能阻断生成**。任何非 200／形状不符／逾时／
// 缺 key → 回原始 prompt + 空 refs，并印一行 warn。warn **只印 prompt 长度与 HTTP status**，
// prompt 全文与任何凭证永不落 log。

import { createHash } from "node:crypto"
import { PLATFORM_BASE } from "./constants-gateway.ts"

/**
 * token 标记。这里**只做「要不要打这一枪」的判定**，不做语法解析——真正的语法
 * （种类字正/简/英、名称段长度、未命中保留）全在站点 `src/lib/entity-tokens.ts`。
 */
export const ENTITY_TOKEN_MARKER = "@["

/**
 * 解析端点。挂 `/api/biz/*` 而非 `/v1/*`：生产 `next.config.mjs` 的 beforeFiles 把
 * `/v1/:path*` 与 `/api/v1/:path*` 整体代理到控制面 origin（那棵树没有卡模型档），
 * 只有 `/api/biz/*` 是 Vercel 全功能应用在服务。
 */
export const ENTITY_RESOLVE_PATH = "/api/biz/character-resolve"

/**
 * 参考图上限。与控制面 `MAX_REFERENCE_IMAGES`（`src/lib/biz-image-references.ts`）同一把尺：
 * 超过上限控制面直接 400 `invalid_reference_images`（不静默截断），所以**送出前**就要截。
 */
export const MAX_ENTITY_REFERENCES = 5

/**
 * 端点逾时 6s（保守值）。理由：这一位于生成提交前的热路径，而生成本身 60–300s，
 * 6s 只占 2–10%；端点内部工作只有「卡库读 + 少量 Blob 落地」，正常 <1s。
 * 选 6s 而非 2s 是为了容忍卡库读取抖动——逾时后 fail-open 代价是「这轮不展开」，
 * 比「整批生成卡住」便宜。
 */
export const ENTITY_RESOLVE_TIMEOUT_MS = 6_000

/**
 * 快取 TTL 30s。理由：同一轮工作流的多个节点在数秒内连发（同一模板的节点常共用提示词
 * 片段），30s 足以吃住同轮与立刻重试；同时把「用户刚建卡就重跑」的陈旧窗口压到 30s 内。
 * **只快取 200 的成功回应**（含「token 未命中、原样保留」这种权威答案）——失败一律不快取，
 * 下一次呼叫立刻重试。
 */
export const ENTITY_RESOLVE_CACHE_TTL_MS = 30_000

/** 快取容量上限（防无界增长）。满了整表清空重建，不做 LRU——prompt 种类数有限，代价可忽略。 */
export const ENTITY_RESOLVE_CACHE_MAX = 200

export interface EntityResolveResult {
  /** 展开后的 prompt；零 token／fail-open 时与输入逐位元相同。 */
  prompt: string
  /** 可直接送控制面的参考图（http(s)，已去重、已截上限）。 */
  reference_images: string[]
}

// ─────────────────────────────────────────── 纯函式（零 I/O，可单测）

/** prompt 是否含行内实体 tag 标记。热路径第一道闸：不含 → 零 HTTP 呼叫。 */
export function hasEntityToken(prompt: string): boolean {
  return typeof prompt === "string" && prompt.includes(ENTITY_TOKEN_MARKER)
}

/**
 * 参考图清洗：只留 http(s)（控制面契约要求；`data:` 由站点端点落地成公网 URL，不由闸道处理）、
 * 保序去重、截到上限。非阵列／脏项一律**丢弃不抛**——参考图是增强，不让一张脏图把生成打失败。
 */
export function sanitizeEntityReferences(input: unknown, limit: number = MAX_ENTITY_REFERENCES): string[] {
  if (!Array.isArray(input) || !(limit > 0)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input) {
    const url = typeof item === "string" ? item.trim() : ""
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 端点回应形状校验（纯函式）。契约：`{ prompt: string, reference_images: string[], warnings: string[] }`。
 * 形状不符（缺 prompt／prompt 空／reference_images 非阵列／整体非物件）→ `null` → 呼叫端 fail-open。
 * 空 prompt 也算不符：把它写进 payload 会让「提交空提示词」溜过上层的 `if (!prompt)` 守卫。
 */
export function parseEntityResolveResponse(raw: unknown): EntityResolveResult | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as { prompt?: unknown; reference_images?: unknown }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return null
  if (!Array.isArray(body.reference_images)) return null
  return { prompt: body.prompt, reference_images: sanitizeEntityReferences(body.reference_images) }
}

/**
 * 快取键：prompt + refs + target + apiKey 的 sha256（**禁把 prompt 明文当 Map key 存**——prompt 可能含
 * 用户私有素材描述，明文键会让整个 Map 变成可读的内容索引）。target 必须进键：同一段文字在
 * 视觉／音频两条链路上的展开结果不同，混用会互相污染。
 * apiKey 也必须进键：卡库按使用者隔离（`listCharacterCards(userId)`），同一段 prompt 在两个使用者
 * 下面是**不同的展开结果与不同的卡参考图**——共用键会把 A 的卡图喂进 B 的生成请求。
 */
export function entityResolveCacheKey(
  prompt: string,
  refs: readonly string[],
  target?: EntityResolveTarget,
  apiKey?: string,
): string {
  return createHash("sha256")
    .update(apiKey ?? "")
    .update("\u0000")
    .update(target ?? "")
    .update("\u0000")
    .update(prompt)
    .update("\u0000")
    .update(refs.join("\n"))
    .digest("hex");
}

// ─────────────────────────────────────────── 快取与警告

interface EntityResolveCacheEntry {
  value: EntityResolveResult
  expiresAt: number
}

const resolveCache = new Map<string, EntityResolveCacheEntry>()

/** 清空快取（测试接缝；生产不需要呼叫）。 */
export function clearEntityResolveCache(): void {
  resolveCache.clear()
}

/** fail-open 警告：**只印原因（固定字面量）、prompt 长度、status**；prompt 全文与 key 永不落 log。 */
function warnFailOpen(reason: string, promptLength: number, status: number | string): void {
  console.warn(`[entity-resolve] ${reason}，本次不展开行内实体 tag（fail-open）；prompt_length=${promptLength} status=${status}`)
}

// ─────────────────────────────────────────── 网路呼叫

/**
 * 生成链路（站点 `POST /api/biz/character-resolve` 的 `target` 值域）。
 * 缺省＝不带此键（站点视为 `"image"`，**请求体逐位元不变**）；`"audio"`＝只有音频卡参与。
 */
export type EntityResolveTarget = "image" | "audio";

export interface EntityResolveDeps {
  /** 测试接缝：注入假 fetch 以断言呼叫次数与回应形状。 */
  fetchImpl?: typeof fetch
  /** 测试接缝：注入时钟以验 TTL。 */
  now?: () => number
  /**
   * **呼叫端必须显式传入的使用者 key**（`workflow-gw.ts` 的 `session.apiKey`、
   * `handleTts` 的第一参数 `key`——同一把站点 `/api/biz/*` 与 `/v1/*` 都认的 biz key）。
   * **禁止任何从 `process.env` 读 key 的路径**：平台自己的服务帐号 key 名下
   * 的卡库与使用者不同（`listCharacterCards(userId)` 按使用者隔离），用它解析＝永远零张卡，
   * 且若服务帐号名下哪天有卡，会把**别人的卡**灌进每个使用者的生成请求（跨租户风险）。
   * 缺 key ⇒ **零 HTTP + fail-open**（原 prompt、空 refs，warn `status=no_key`）。
   */
  apiKey?: string
  /** 测试接缝：覆写站点 origin（预设 `PLATFORM_BASE`）。 */
  baseUrl?: string
  /**
   * 生成链路。**缺省＝不带 `target` 键**（既有视觉行为，请求体零漂移）；
   * 音频链路用 `resolveAudioEntityTokens`（它会填 `"audio"`）。
   */
  target?: EntityResolveTarget
}

/** 逾时 signal 与呼叫端 signal 并用（`AbortSignal.any` 不可用时退回纯逾时）。 */
function withTimeout(callerSignal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!callerSignal) return timeout
  const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return typeof anyOf === "function" ? anyOf([callerSignal, timeout]) : timeout
}

/**
 * 解析 prompt 里的行内实体 tag，回传「展开后 prompt + 卡参考图」。
 *
 * 语义（冻结）：
 *   - prompt 不含 `@[` → **原值返回、零 HTTP 呼叫**（热路径不得多一次网路往返）。
 *   - 含 `@[` → `POST ${PLATFORM_BASE}/api/biz/character-resolve`，Bearer **呼叫端传入的
 *     使用者 key**（`deps.apiKey`；`session.apiKey` / `handleTts` 的 `key`），
 *     body `{ prompt, reference_images?: refs }`（refs 已清洗/截上限，避免控制面 400）。
 *   - 任何非 200／形状不符／逾时／缺 key → **原始 prompt + 空 refs**，不 throw（fail-open 硬契约）。
 *   - 成功回应进快取（键＝prompt+refs 杂凑，TTL 见 `ENTITY_RESOLVE_CACHE_TTL_MS`）。
 */
export async function resolveEntityTokens(
  prompt: string,
  refs: readonly string[] = [],
  signal?: AbortSignal,
  deps: EntityResolveDeps = {},
): Promise<EntityResolveResult> {
  const original: EntityResolveResult = { prompt, reference_images: [] }
  if (!hasEntityToken(prompt)) return original

  const explicitRefs = sanitizeEntityReferences(refs)
  const now = deps.now ?? Date.now

  // 只认呼叫端显式传入的使用者 key；**没有任何 env fallback**（见 `EntityResolveDeps.apiKey`）。
  // 这道守卫必须在查快取**之前**：否则无 key 的呼叫会直接吃到别人快取住的展开结果与卡参考图。
  const apiKey = deps.apiKey ?? ""
  if (!apiKey) {
    warnFailOpen("缺少 apiKey（调用端未传）", prompt.length, "no_key")
    return original
  }

  // 快取键带 apiKey：卡库按使用者隔离，同一段 prompt 在别人名下是不同的展开结果（见上方说明）。
  const cacheKey = entityResolveCacheKey(prompt, explicitRefs, deps.target, apiKey)
  const cached = resolveCache.get(cacheKey)
  if (cached && cached.expiresAt > now()) return cached.value

  const fetchImpl = deps.fetchImpl ?? fetch
  const baseUrl = (deps.baseUrl ?? PLATFORM_BASE).replace(/\/+$/, "")
  try {
    const res = await fetchImpl(`${baseUrl}${ENTITY_RESOLVE_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        // 缺省不带 target 键（请求体与改动前逐位元相同）。
        ...(deps.target ? { target: deps.target } : {}),
        ...(explicitRefs.length ? { reference_images: explicitRefs } : {}),
      }),
      signal: withTimeout(signal, ENTITY_RESOLVE_TIMEOUT_MS),
    })
    if (res.status !== 200) {
      warnFailOpen("解析端点返回非 200", prompt.length, res.status)
      return original
    }
    const parsed = parseEntityResolveResponse(await res.json().catch(() => null))
    if (!parsed) {
      warnFailOpen("解析端点回应形状不符", prompt.length, res.status)
      return original
    }
    if (resolveCache.size >= ENTITY_RESOLVE_CACHE_MAX) resolveCache.clear()
    resolveCache.set(cacheKey, { value: parsed, expiresAt: now() + ENTITY_RESOLVE_CACHE_TTL_MS })
    return parsed
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name
    const timedOut = name === "TimeoutError" || name === "AbortError"
    // 刻意不印 error.message（可能含 URL 与上游细节），也不印 prompt 与 key。
    warnFailOpen(timedOut ? "解析端点逾时/中止" : "解析端点请求抛错", prompt.length, timedOut ? "timeout" : "error")
    return original
  }
}

// ─────────────────────────────────────────── 音频链路（target: "audio"）

/**
 * 音频链路的行内实体 tag 解析：`POST /api/biz/character-resolve { prompt, target: "audio" }`。
 *
 * 与视觉版**共用同一支薄客户端**（同一套 fail-open／warn／快取／形状校验，禁造第二套）；
 * 差别只有两处：请求带 `target: "audio"`（站点只让音频卡参与、`reference_images` 一律回空）、
 * 不快取参考图（音频链路没有参考图语义，`refs` 一律空）。
 *
 * **fail-open 硬契约**：任何非 200／形状不符／逾时／缺 key → 回原文，永不得阻断音频生成。
 */
export async function resolveAudioEntityTokens(
  text: string,
  signal?: AbortSignal,
  deps: EntityResolveDeps = {},
): Promise<EntityResolveResult> {
  return resolveEntityTokens(text, [], signal, { ...deps, target: "audio" })
}
