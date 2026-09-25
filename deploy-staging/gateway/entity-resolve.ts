// entity-resolve.ts —— 工作流節點生成的行內實體 tag（`@[種類:名稱]`）解析**薄客戶端**。
//
// 為什麼是薄客戶端而不是自己解析：token 展開、卡庫查詢、參考圖落地（data:image → Blob）
// 已經在站點端點 `POST /api/biz/character-resolve` 實作，且**已在生產實錘**（agent 工具那條
// 路送 4 個行內 tag，真的帶回 4 張參考圖）。閘道這裡只做四件事：要不要打（零 token 不打）、
// 呼叫、回應形狀校驗、fail-open + 短 TTL 快取。**不重寫 regex、不查卡庫**——複製第二套解析
// 必然與站點漂移（禁造輪子）。
//
// 硬契約（設計，不是偷懶）：**token 解析失敗永遠不能阻斷生成**。任何非 200／形狀不符／逾時／
// 缺 key → 回原始 prompt + 空 refs，並印一行 warn。warn **只印 prompt 長度與 HTTP status**，
// prompt 全文與任何憑證永不落 log。

import { createHash } from "node:crypto"
import { PLATFORM_BASE } from "./constants-gateway.ts"

/**
 * token 標記。這裡**只做「要不要打這一槍」的判定**，不做語法解析——真正的語法
 * （種類字正/簡/英、名稱段長度、未命中保留）全在站點 `src/lib/entity-tokens.ts`。
 */
export const ENTITY_TOKEN_MARKER = "@["

/**
 * 解析端點。掛 `/api/biz/*` 而非 `/v1/*`：生產 `next.config.mjs` 的 beforeFiles 把
 * `/v1/:path*` 與 `/api/v1/:path*` 整體代理到控制面 origin（那棵樹沒有卡模型檔），
 * 只有 `/api/biz/*` 是 Vercel 全功能應用在服務。
 */
export const ENTITY_RESOLVE_PATH = "/api/biz/character-resolve"

/**
 * 參考圖上限。與控制面 `MAX_REFERENCE_IMAGES`（`src/lib/biz-image-references.ts`）同一把尺：
 * 超過上限控制面直接 400 `invalid_reference_images`（不靜默截斷），所以**送出前**就要截。
 */
export const MAX_ENTITY_REFERENCES = 5

/**
 * 端點逾時 6s（保守值）。理由：這一位於生成提交前的熱路徑，而生成本身 60–300s，
 * 6s 只佔 2–10%；端點內部工作只有「卡庫讀 + 少量 Blob 落地」，正常 <1s。
 * 選 6s 而非 2s 是為了容忍卡庫讀取抖動——逾時後 fail-open 代價是「這輪不展開」，
 * 比「整批生成卡住」便宜。
 */
export const ENTITY_RESOLVE_TIMEOUT_MS = 6_000

/**
 * 快取 TTL 30s。理由：同一輪工作流的多個節點在數秒內連發（同一模板的節點常共用提示詞
 * 片段），30s 足以吃住同輪與立刻重試；同時把「用戶剛建卡就重跑」的陳舊窗口壓到 30s 內。
 * **只快取 200 的成功回應**（含「token 未命中、原樣保留」這種權威答案）——失敗一律不快取，
 * 下一次呼叫立刻重試。
 */
export const ENTITY_RESOLVE_CACHE_TTL_MS = 30_000

/** 快取容量上限（防無界增長）。滿了整表清空重建，不做 LRU——prompt 種類數有限，代價可忽略。 */
export const ENTITY_RESOLVE_CACHE_MAX = 200

export interface EntityResolveResult {
  /** 展開後的 prompt；零 token／fail-open 時與輸入逐位元相同。 */
  prompt: string
  /** 可直接送控制面的參考圖（http(s)，已去重、已截上限）。 */
  reference_images: string[]
}

// ─────────────────────────────────────────── 純函式（零 I/O，可單測）

/** prompt 是否含行內實體 tag 標記。熱路徑第一道閘：不含 → 零 HTTP 呼叫。 */
export function hasEntityToken(prompt: string): boolean {
  return typeof prompt === "string" && prompt.includes(ENTITY_TOKEN_MARKER)
}

/**
 * 參考圖清洗：只留 http(s)（控制面契約要求；`data:` 由站點端點落地成公網 URL，不由閘道處理）、
 * 保序去重、截到上限。非陣列／髒項一律**丟棄不拋**——參考圖是增強，不讓一張髒圖把生成打失敗。
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
 * 端點回應形狀校驗（純函式）。契約：`{ prompt: string, reference_images: string[], warnings: string[] }`。
 * 形狀不符（缺 prompt／prompt 空／reference_images 非陣列／整體非物件）→ `null` → 呼叫端 fail-open。
 * 空 prompt 也算不符：把它寫進 payload 會讓「提交空提示詞」溜過上層的 `if (!prompt)` 守衛。
 */
export function parseEntityResolveResponse(raw: unknown): EntityResolveResult | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as { prompt?: unknown; reference_images?: unknown }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) return null
  if (!Array.isArray(body.reference_images)) return null
  return { prompt: body.prompt, reference_images: sanitizeEntityReferences(body.reference_images) }
}

/**
 * 快取鍵：prompt + refs + target + apiKey 的 sha256（**禁把 prompt 明文當 Map key 存**——prompt 可能含
 * 用戶私有素材描述，明文鍵會讓整個 Map 變成可讀的內容索引）。target 必須進鍵：同一段文字在
 * 視覺／音頻兩條鏈路上的展開結果不同，混用會互相污染。
 * apiKey 也必須進鍵：卡庫按使用者隔離（`listCharacterCards(userId)`），同一段 prompt 在兩個使用者
 * 下面是**不同的展開結果與不同的卡參考圖**——共用鍵會把 A 的卡圖餵進 B 的生成請求。
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

// ─────────────────────────────────────────── 快取與警告

interface EntityResolveCacheEntry {
  value: EntityResolveResult
  expiresAt: number
}

const resolveCache = new Map<string, EntityResolveCacheEntry>()

/** 清空快取（測試接縫；生產不需要呼叫）。 */
export function clearEntityResolveCache(): void {
  resolveCache.clear()
}

/** fail-open 警告：**只印原因（固定字面量）、prompt 長度、status**；prompt 全文與 key 永不落 log。 */
function warnFailOpen(reason: string, promptLength: number, status: number | string): void {
  console.warn(`[entity-resolve] ${reason}，本次不展开行内实体 tag（fail-open）；prompt_length=${promptLength} status=${status}`)
}

// ─────────────────────────────────────────── 網路呼叫

/**
 * 生成鏈路（站點 `POST /api/biz/character-resolve` 的 `target` 值域）。
 * 缺省＝不帶此鍵（站點視為 `"image"`，**請求體逐位元不變**）；`"audio"`＝只有音頻卡參與。
 */
export type EntityResolveTarget = "image" | "audio";

export interface EntityResolveDeps {
  /** 測試接縫：注入假 fetch 以斷言呼叫次數與回應形狀。 */
  fetchImpl?: typeof fetch
  /** 測試接縫：注入時鐘以驗 TTL。 */
  now?: () => number
  /**
   * **呼叫端必須顯式傳入的使用者 key**（`workflow-gw.ts` 的 `session.apiKey`、
   * `handleTts` 的第一參數 `key`——同一把站點 `/api/biz/*` 與 `/v1/*` 都認的 biz key）。
   * **禁止任何從 `process.env` 讀 key 的路徑**：平台自己的服務帳號 key 名下
   * 的卡庫與使用者不同（`listCharacterCards(userId)` 按使用者隔離），用它解析＝永遠零張卡，
   * 且若服務帳號名下哪天有卡，會把**別人的卡**灌進每個使用者的生成請求（跨租戶風險）。
   * 缺 key ⇒ **零 HTTP + fail-open**（原 prompt、空 refs，warn `status=no_key`）。
   */
  apiKey?: string
  /** 測試接縫：覆寫站點 origin（預設 `PLATFORM_BASE`）。 */
  baseUrl?: string
  /**
   * 生成鏈路。**缺省＝不帶 `target` 鍵**（既有視覺行為，請求體零漂移）；
   * 音頻鏈路用 `resolveAudioEntityTokens`（它會填 `"audio"`）。
   */
  target?: EntityResolveTarget
}

/** 逾時 signal 與呼叫端 signal 併用（`AbortSignal.any` 不可用時退回純逾時）。 */
function withTimeout(callerSignal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!callerSignal) return timeout
  const anyOf = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return typeof anyOf === "function" ? anyOf([callerSignal, timeout]) : timeout
}

/**
 * 解析 prompt 裡的行內實體 tag，回傳「展開後 prompt + 卡參考圖」。
 *
 * 語義（凍結）：
 *   - prompt 不含 `@[` → **原值返回、零 HTTP 呼叫**（熱路徑不得多一次網路往返）。
 *   - 含 `@[` → `POST ${PLATFORM_BASE}/api/biz/character-resolve`，Bearer **呼叫端傳入的
 *     使用者 key**（`deps.apiKey`；`session.apiKey` / `handleTts` 的 `key`），
 *     body `{ prompt, reference_images?: refs }`（refs 已清洗/截上限，避免控制面 400）。
 *   - 任何非 200／形狀不符／逾時／缺 key → **原始 prompt + 空 refs**，不 throw（fail-open 硬契約）。
 *   - 成功回應進快取（鍵＝prompt+refs 雜湊，TTL 見 `ENTITY_RESOLVE_CACHE_TTL_MS`）。
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

  // 只認呼叫端顯式傳入的使用者 key；**沒有任何 env fallback**（見 `EntityResolveDeps.apiKey`）。
  // 這道守衛必須在查快取**之前**：否則無 key 的呼叫會直接吃到別人快取住的展開結果與卡參考圖。
  const apiKey = deps.apiKey ?? ""
  if (!apiKey) {
    warnFailOpen("缺少 apiKey（调用端未传）", prompt.length, "no_key")
    return original
  }

  // 快取鍵帶 apiKey：卡庫按使用者隔離，同一段 prompt 在別人名下是不同的展開結果（見上方說明）。
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
        // 缺省不帶 target 鍵（請求體與改動前逐位元相同）。
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
    // 刻意不印 error.message（可能含 URL 與上游細節），也不印 prompt 與 key。
    warnFailOpen(timedOut ? "解析端点逾时/中止" : "解析端点请求抛错", prompt.length, timedOut ? "timeout" : "error")
    return original
  }
}

// ─────────────────────────────────────────── 音頻鏈路（target: "audio"）

/**
 * 音頻鏈路的行內實體 tag 解析：`POST /api/biz/character-resolve { prompt, target: "audio" }`。
 *
 * 與視覺版**共用同一支薄客戶端**（同一套 fail-open／warn／快取／形狀校驗，禁造第二套）；
 * 差別只有兩處：請求帶 `target: "audio"`（站點只讓音頻卡參與、`reference_images` 一律回空）、
 * 不快取參考圖（音頻鏈路沒有參考圖語義，`refs` 一律空）。
 *
 * **fail-open 硬契約**：任何非 200／形狀不符／逾時／缺 key → 回原文，永不得阻斷音頻生成。
 */
export async function resolveAudioEntityTokens(
  text: string,
  signal?: AbortSignal,
  deps: EntityResolveDeps = {},
): Promise<EntityResolveResult> {
  return resolveEntityTokens(text, [], signal, { ...deps, target: "audio" })
}
