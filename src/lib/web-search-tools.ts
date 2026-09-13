/**
 * web_search harness 工具（beast 軍團 R1 研究軍團搜索彈藥，2026-09-10）。
 *
 * 定義形狀同構 src/lib/music-tools.ts 的 MusicToolDef（零依賴：
 * { id, description, args, execute } + ok()/fail() 契約，回 { title, output }，
 * output 為 JSON 字串）；ok/fail 與錯誤鐵律逐行同構 src/lib/music-tools.ts
 * （本工具無會話資產落盤，砍上傳/ffprobe/音頻專屬面，plumbing 契約不動）。
 *
 * 上游通路：Tavily REST Search API（docs.tavily.com）：
 *   端點  POST https://api.tavily.com/search
 *   鑑權  body api_key（經典形；讀 env TAVILY_API_KEY）
 *   請求  { api_key, query, max_results, search_depth: "basic"|"advanced", include_answer: true }
 *   響應  { answer?, results: [{title, url, content, score}], response_time }
 *
 * 錯誤鐵律（同 music-tools 誠實鐵律）：缺 key / 非 2xx / 網絡層失敗一律結構化
 * fail() 帶原文摘錄與人話 hint，絕不 throw 逃逸、絕不吞錯、絕不偽造結果。
 * 超時 20s 硬頂（AbortSignal.timeout）。工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

/** Tavily Search API 端點。 */
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search"

/** 上游響應超時（搜索是輕請求，20s 硬頂）。 */
export const TAVILY_TIMEOUT_MS = 20_000

/** max_results 默認值。 */
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 8

/** max_results 上限（Tavily API 上限 20，超出靜默收斂到帽值）。 */
export const WEB_SEARCH_MAX_RESULTS_CAP = 20

/** 錯誤訊息裡攜帶的原文 body 上限（同 music-lyria.ts 口徑；截斷時顯式標注）。 */
const ERROR_BODY_MAX_CHARS = 8000

// ── plumbing（ok/fail 同構 music-tools.ts） ─────────────────────────────────

export type WebToolResult = { title: string; output: string }

function ok(data: Record<string, unknown>): WebToolResult {
  const { title, ...rest } = data
  return { title: (title as string) ?? "完成", output: JSON.stringify({ ok: true, ...rest }) }
}

function fail(code: string, hint: string, extra?: Record<string, unknown>): WebToolResult {
  const { title, ...rest } = extra ?? {}
  return { title: (title as string) ?? "失败", output: JSON.stringify({ ok: false, error: { code, hint }, ...rest }) }
}

export class WebSearchToolError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "WebSearchToolError"
  }
}

function toFail(e: unknown): WebToolResult {
  if (e instanceof WebSearchToolError) return fail(e.code, e.message)
  return fail("web_search_tool_error", `web_search 工具执行异常：${(e as Error)?.message ?? String(e)}`)
}

// ── 參數整理助手（同構 music-tools.ts 口徑） ────────────────────────────────

export interface WebToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface WebToolContext {
  abort?: AbortSignal
  /** 會話 id（web_search 暫無會話資產落盤；adapter 機械透傳保留欄位，同 music-tools-adapter 口徑）。 */
  sessionId?: string
}

export interface WebToolDef {
  id: string
  description: string
  args: Record<string, WebToolArgSpec>
  execute: (args: Record<string, unknown>, context?: WebToolContext) => Promise<WebToolResult>
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined
}

// ── 鑑權與解析（誠實鐵律：不猜不造，缺什麼報什麼） ───────────────────────────

/** 讀 TAVILY_API_KEY（缺失/空白 → fail-fast 人話報錯）。 */
export function requireTavilyApiKey(): string {
  const key = (process.env.TAVILY_API_KEY ?? "").trim()
  if (!key) {
    throw new WebSearchToolError(
      "missing_api_key",
      "缺少 TAVILY_API_KEY（Tavily 搜索上游鑑權）。請在 harness 環境配置該 env 後重試。",
    )
  }
  return key
}

/** 從 Tavily 響應機械提取 results 與 answer；缺 results 陣列一律拋錯（不猜）。 */
export function extractTavilyResults(body: unknown): {
  results: Array<{ title: string; url: string; content: string; score?: number }>
  answer?: string
} {
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  const raw = (body as { results?: unknown })?.results
  if (!Array.isArray(raw)) {
    throw new WebSearchToolError(
      "upstream_bad_response",
      `Tavily 响应缺少 results 数组（不猜不造）。原文摘錄：${excerpt}`,
    )
  }
  const results = raw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      ...(typeof r.title === "string" ? { title: r.title } : { title: "" }),
      ...(typeof r.url === "string" ? { url: r.url } : { url: "" }),
      ...(typeof r.content === "string" ? { content: r.content } : { content: "" }),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
    }))
  const answerRaw = (body as { answer?: unknown })?.answer
  const answer = typeof answerRaw === "string" && answerRaw.trim() !== "" ? answerRaw : undefined
  return { results, ...(answer ? { answer } : {}) }
}

// ── web_search 工具 ──────────────────────────────────────────────────────────

export const webSearchTool: WebToolDef = {
  id: "search_web",
  description:
    "联网搜索最新资料（search_web，Tavily 上游）：返回网页结果列表（标题/链接/内容摘要）与 AI 摘要。研究类任务的实证弹药——结论必须带 URL 出处，禁止只凭内部知识作答。",
  args: {
    query: {
      type: "string",
      required: true,
      description:
        "搜索查询词，中英文均可。研究类任务建议一次聚焦一个子问题。例：2026 日本动漫行业趋势 市场规模",
    },
    max_results: {
      type: "number",
      required: false,
      description: "返回结果条数，1-20，默认 8。",
    },
    search_depth: {
      type: "string",
      required: false,
      enum: ["basic", "advanced"],
      description: "搜索深度：basic=快速（默认），advanced=更全面但更慢。",
    },
  },
  async execute(rawArgs, context) {
    try {
      const query = asString(rawArgs.query)
      if (!query) {
        return fail("invalid_args", "缺少必填参数 query：需要搜索查询词。")
      }
      let maxResults = WEB_SEARCH_DEFAULT_MAX_RESULTS
      if (rawArgs.max_results !== undefined && rawArgs.max_results !== null) {
        const n = typeof rawArgs.max_results === "number" ? rawArgs.max_results : Number(rawArgs.max_results)
        if (!Number.isFinite(n) || n < 1) {
          return fail("invalid_args", `max_results 需为 1-20 的数字，收到 "${String(rawArgs.max_results)}"。`)
        }
        maxResults = Math.min(Math.round(n), WEB_SEARCH_MAX_RESULTS_CAP)
      }
      const depthRaw = asString(rawArgs.search_depth) ?? "basic"
      if (depthRaw !== "basic" && depthRaw !== "advanced") {
        return fail("invalid_args", `search_depth 只接受 "basic" 或 "advanced"，收到 "${depthRaw}"。`)
      }
      const apiKey = requireTavilyApiKey()

      let response: Response
      try {
        response = await fetch(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults,
            search_depth: depthRaw,
            include_answer: true,
          }),
          signal: context?.abort ?? AbortSignal.timeout(TAVILY_TIMEOUT_MS),
        })
      } catch (e) {
        throw new WebSearchToolError(
          "upstream_request_failed",
          `Tavily 搜索请求失败（网络层或超时 ${TAVILY_TIMEOUT_MS} ms）：${(e as Error)?.message ?? String(e)}`,
        )
      }
      const bodyText = await response.text().catch(() => "")
      if (!response.ok) {
        throw new WebSearchToolError(
          "upstream_http_error",
          `Tavily 返回 HTTP ${response.status}。原文 body：${bodyText.slice(0, ERROR_BODY_MAX_CHARS) || "(空)"}`,
        )
      }
      let body: unknown
      try {
        body = JSON.parse(bodyText)
      } catch {
        throw new WebSearchToolError(
          "upstream_bad_response",
          `Tavily 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
        )
      }

      const picked = extractTavilyResults(body)
      return ok({
        title: "搜索完成",
        query,
        search_depth: depthRaw,
        max_results: maxResults,
        result_count: picked.results.length,
        results: picked.results,
        ...(picked.answer ? { answer: picked.answer } : {}),
      })
    } catch (e) {
      return toFail(e)
    }
  },
}

/** harness-tool-registry.ts 登記用 id 元組（同 MUSIC_HARNESS_TOOL_IDS 範式）。
 *  命名域實錘（2026-09-10 VPS）：opencode 1.18.14 保留 websearch/web_search 命名域，
 *  自訂工具檔名撞名即被物理移除（ws_probe HAVE / web_search NOT_HAVE 對照實錘），
 *  故 harness 註冊名=檔名 search_web；id 欄僅 registry 登記用，註冊名以檔名為準。 */
export const WEB_SEARCH_HARNESS_TOOL_IDS = ["search_web"] as const
