/**
 * memory_recall harness 工具 VPS staging 稿（P0-5，2026-09-15）。
 *
 * 行為真源＝本檔；部署落點＝VPS `/opt/agent-harness/workspace/.opencode/lib/memory_recall_impl.ts`。
 * 結構逐行同構 R1 search_web 輪子（VPS `.opencode/lib/web_search_impl.ts`，2026-09-10 機械導出）：
 * 純零依賴、無 import、同 ok/fail plumbing 契約、同錯誤鐵律（缺參數/非 2xx/網絡層失敗一律
 * 結構化 fail() 帶原文摘錄與人話 hint，絕不 throw 逃逸、絕不吞錯、絕不偽造結果）、同 20s 超時帽。
 * 白名單偏離（僅此處）：上游通路從「Tavily 外網 + body api_key」改為「gateway loopback + Bearer」，
 * 故删除 TAVILY_* 常量與 requireTavilyApiKey，改為 GATEWAY/HARNESS_API_KEY 讀取與
 * POST `${GATEWAY}/agent/v1/memory/recall`；回應解析從 extractTavilyResults 改為 extractRecalledDocs。
 *
 * ⚠ 與 spec 的現場衝突（如實回報）：spec 說「認證頭比照 search_web_impl 打中控的同一形狀」，
 *   但輪子原文 web_search_impl.ts 打的並非中控（是 https://api.tavily.com/search，鑑權走 body
 *   api_key，無任何 gateway Bearer 頭）。倉內真正「打中控 loopback」的形狀在 client.ts /
 *   music-tools-impl.ts / director-common.ts：`Authorization: Bearer ${HARNESS_API_KEY}`，
 *   GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"。本片照該同族形狀實裝
 *   （端點族 /agent/v1/* 走 sk-biz Bearer 閘門，見 gateway 快照 L52/L7882；HARNESS_API_KEY
 *   ＝.env.biz-key，見記憶 2026-09-11-P2b：agent API = Authorization Bearer HARNESS_API_KEY）。
 *
 * 上游通路：中控 gateway loopback（VPS 內）：
 *   端點  POST ${GATEWAY_URL}/agent/v1/memory/recall（由接線片新增，同族 /agent/v1 Bearer 鑑權）
 *   鑑權  Header Authorization: Bearer ${HARNESS_API_KEY}（讀 env，缺失 fail-fast 人話報錯）
 *   請求  { query, domain?, limit? }（limit 1-5，默認 3，超出收斂到帽值 5）
 *   響應  { results: [{domain, slug, description, body, score?}], count }（契約 §7 top-3 召回形狀；
 *          實際欄位以接線片為準，解析層對缺欄宽容、對無 results 陣列拋錯不猜）
 *
 * 輸出：格式化回「[domain] slug — description\n   body」逐條串接（人與模型都可讀），
 *      同時保留原始 docs 供上層需要時取結構。工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

/** 中控 gateway loopback 基址（默認 http://127.0.0.1:8081，同 music-tools-impl / director-common）。 */
export const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/** memory_recall 端點路徑（同族 /agent/v1 Bearer 閘門）。 */
export const MEMORY_RECALL_PATH = "/agent/v1/memory/recall"

/** 上游響應超時（召回是輕請求，20s 硬頂，同 search_web 口徑）。 */
export const MEMORY_RECALL_TIMEOUT_MS = 20_000

/** limit 默認值（對齊契約 §7 召回 top-3）。 */
export const MEMORY_RECALL_DEFAULT_LIMIT = 3

/** limit 上限（PRD §6.2 工具規格：limit?≤5，超出靜默收斂到帽值）。 */
export const MEMORY_RECALL_LIMIT_CAP = 5

/** 錯誤訊息裡攜帶的原文 body 上限（同 search_web_impl 口徑；截斷時顯式標注）。 */
const ERROR_BODY_MAX_CHARS = 8000

/** HARNESS_API_KEY fallback（讀不到 .env.opencode 時的兜底來源，同 music-tools-impl）。 */
const HARNESS_API_KEY_FALLBACK = process.env.HARNESS_API_KEY || ""

// ── plumbing（ok/fail 逐行同構 web_search_impl.ts） ──────────────────────────

export type MemoryToolResult = { title: string; output: string }

function ok(data: Record<string, unknown>): MemoryToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): MemoryToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

export class MemoryRecallToolError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "MemoryRecallToolError"
  }
}

function toFail(e: unknown): MemoryToolResult {
  if (e instanceof MemoryRecallToolError) return fail(e.code, e.message)
  return fail("memory_recall_tool_error", `memory_recall 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

// ── 參數整理助手（同構 web_search_impl 口徑） ────────────────────────────────

export interface MemoryToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface MemoryToolContext {
  abort?: AbortSignal
  /** 會話 id（memory_recall 無需會話資產落盤；adapter 機械透傳保留欄位，同 web_search_impl 口徑）。 */
  sessionId?: string
}

export interface MemoryToolDef {
  id: string
  description: string
  args: Record<string, MemoryToolArgSpec>
  execute: (args: Record<string, unknown>, context?: MemoryToolContext) => Promise<MemoryToolResult>
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

// ── 鑑權與解析（誠實鐵律：不猜不造，缺什麼報什麼） ───────────────────────────

/** 讀 HARNESS_API_KEY（缺失/空白 → fail-fast 人話報錯，鏡像 requireTavilyApiKey）。 */
export function requireHarnessApiKey(): string {
  const key = (HARNESS_API_KEY_FALLBACK || process.env.HARNESS_API_KEY || "").trim()
  if (!key) {
    throw new MemoryRecallToolError(
      "missing_api_key",
      "缺少 HARNESS_API_KEY（memory_recall 走中控 /agent/v1 Bearer 閘門）。請在 harness 環境配置該 env 後重試。",
    )
  }
  return key
}

/** 召回條目（對齊契約 §1 AgentMemoryDoc 的注入子集；缺欄宽容為空字串，不猜）。 */
export interface RecalledDoc {
  domain: string
  slug: string
  description: string
  body: string
  score?: number
}

/** 從中控召回響應機械提取 results 陣列；缺 results 一律拋錯（不猜不造）。 */
export function extractRecalledDocs(body: unknown): { docs: RecalledDoc[]; count: number } {
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  const raw = (body as { results?: unknown; docs?: unknown })?.results
    ?? (body as { docs?: unknown })?.docs
  if (!Array.isArray(raw)) {
    throw new MemoryRecallToolError(
      "upstream_bad_response",
      `中控召回响应缺少 results 数组（不猜不造）。原文摘錄：${excerpt}`,
    )
  }
  const docs: RecalledDoc[] = raw
    .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
    .map((d) => ({
      domain: typeof d.domain === "string" ? d.domain : "",
      slug: typeof d.slug === "string" ? d.slug : "",
      description: typeof d.description === "string" ? d.description : "",
      body: typeof d.body === "string" ? d.body : "",
      ...(typeof d.score === "number" ? { score: d.score } : {}),
    }))
  const countRaw = (body as { count?: unknown })?.count
  const count = typeof countRaw === "number" && Number.isFinite(countRaw) ? countRaw : docs.length
  return { docs, count }
}

/** 格式化召回條目為「[domain] slug — description\n   body」（PRD §6.2 工具回傳形狀）。 */
export function formatRecalledDocs(docs: RecalledDoc[]): string {
  if (docs.length === 0) return ""
  return docs
    .map((d) => `[${d.domain}] ${d.slug} — ${d.description}\n   ${d.body}`)
    .join("\n\n")
}

// ── memory_recall 工具 ───────────────────────────────────────────────────────

export const memoryRecallTool: MemoryToolDef = {
  id: "memory_recall",
  description:
    "从平台共享记忆库召回领域知识正文（memory_recall，中控 /agent/v1/memory/recall）。当共享知识目录里有一条与当前任务相关、但目录摘要不足以落地时，用本工具读该条全文。返回条目列表，每条含 [domain] slug — description 与 body；引用前须记得它记录的是「写下那一刻」的认知、可能已过期，与现场冲突时以现场为准并说明冲突。",
  args: {
    query: {
      type: "string",
      required: true,
      description:
        "检索词，中英文均可，建议聚焦单个子问题或某个知识域。例：日式番剧预告片的镜头节奏",
    },
    domain: {
      type: "string",
      required: false,
      description: "可选：限定一级检索域（如「日本动漫」「电商美妆」），缺省则全域召回。",
    },
    limit: {
      type: "number",
      required: false,
      description: "返回条数，1-5，默认 3。超出上限静默收敛到 5。",
    },
  },
  async execute(rawArgs, context) {
    try {
      const query = asString(rawArgs.query)
      if (!query) {
        return fail("invalid_args", "缺少必填参数 query：需要检索词。")
      }
      const domain = asString(rawArgs.domain)
      let limit = MEMORY_RECALL_DEFAULT_LIMIT
      if (rawArgs.limit !== undefined && rawArgs.limit !== null) {
        const n = typeof rawArgs.limit === "number" ? rawArgs.limit : Number(rawArgs.limit)
        if (!Number.isFinite(n) || n < 1) {
          return fail("invalid_args", `limit 需为 1-5 的数字，收到 "${String(rawArgs.limit)}"。`)
        }
        limit = Math.min(Math.round(n), MEMORY_RECALL_LIMIT_CAP)
      }
      const apiKey = requireHarnessApiKey()

      let response: Response
      try {
        response = await fetch(`${GATEWAY}${MEMORY_RECALL_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query,
            ...(domain ? { domain } : {}),
            limit,
          }),
          signal: context?.abort ?? AbortSignal.timeout(MEMORY_RECALL_TIMEOUT_MS),
        })
      } catch (e) {
        throw new MemoryRecallToolError(
          "upstream_request_failed",
          `中控召回请求失败（网络层或超时 ${MEMORY_RECALL_TIMEOUT_MS} ms）：${(e as Error)?.message ?? String(e)}。请确认 GATEWAY_URL=${GATEWAY} 可达。`,
        )
      }
      const bodyText = await response.text().catch(() => "")
      if (!response.ok) {
        throw new MemoryRecallToolError(
          "upstream_http_error",
          `中控返回 HTTP ${response.status}。原文 body：${bodyText.slice(0, ERROR_BODY_MAX_CHARS) || "(空)"}`,
        )
      }
      let body: unknown
      try {
        body = JSON.parse(bodyText)
      } catch {
        throw new MemoryRecallToolError(
          "upstream_bad_response",
          `中控召回响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
        )
      }

      const picked = extractRecalledDocs(body)
      return ok({
        title: picked.docs.length > 0 ? "召回完成" : "无匹配记忆",
        query,
        ...(domain ? { domain } : {}),
        limit,
        result_count: picked.docs.length,
        formatted: formatRecalledDocs(picked.docs),
        results: picked.docs,
        ...(typeof picked.count === "number" ? { count: picked.count } : {}),
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

/** harness-tool-registry.ts 登記用 id 元組（同 WEB_SEARCH_HARNESS_TOOL_IDS 範式）。
 *  命名域教訓（2026-09-10 VPS 實錘）：opencode 1.18.14 保留 websearch/web_search 命名域，
 *  自訂工具檔名撞名即被物理移除。memory_recall 非保留名（保留名域無此詞），OK；
 *  註冊名=tools/ 檔名（memory_recall），id 欄僅 registry 登記用。 */
export const MEMORY_RECALL_HARNESS_TOOL_IDS = ["memory_recall"] as const
