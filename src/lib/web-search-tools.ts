/**
 * web_search harness 工具（beast 軍團 R1 研究軍團搜索彈藥，2026-09-10；2026-10-02 上游 Tavily→Exa）。
 *
 * 定義形狀同構 src/lib/music-tools.ts 的 MusicToolDef（零依賴：
 * { id, description, args, execute } + ok()/fail() 契約，回 { title, output }，
 * output 為 JSON 字串）；ok/fail 與錯誤鐵律逐行同構 src/lib/music-tools.ts
 * （本工具無會話資產落盤，砍上傳/ffprobe/音頻專屬面，plumbing 契約不動）。
 *
 * 上游通路：Exa REST Search API（技能 build-with-exa 為唯一真源）：
 *   端點  POST https://api.exa.ai/search
 *   鑑權  HTTP header x-api-key（讀 env EXA_API_KEY；key 不入 body）
 *   請求  { query, type: "auto"|"deep", contents: { highlights: true }, numResults? }
 *   響應  { requestId, results: [{ title, url, highlights: string[] }], costDollars, searchTime }
 *
 * 參數口徑（照技能，不臆造）：默認請求只有 query + type + contents.highlights；
 *   numResults 僅在呼叫方明確傳 max_results 時才送（刻意產品決定，否則用服務器默認）；
 *   search_depth 保留舊名，映射 basic→auto、advanced→deep。
 *   include_answer 為 Tavily 專屬參數，已移除（產品自有聊天 LLM，只給 /search 當工具）。
 *
 * 錯誤鐵律（同 music-tools 誠實鐵律）：缺 key / 非 2xx / 網絡層失敗一律結構化
 * fail() 帶原文摘錄與人話 hint，絕不 throw 逃逸、絕不吞錯、絕不偽造結果。
 * 超時 20s 硬頂（AbortSignal.timeout）。工具文案一律簡體（記憶 agent-gateway-copy-rules）。
 */

/** Exa Search API 端點。 */
export const EXA_SEARCH_URL = "https://api.exa.ai/search"

/** 上游響應超時（搜索是輕請求，20s 硬頂）。 */
export const EXA_TIMEOUT_MS = 20_000

/** max_results 默認值。 */
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 8

/** max_results 上限（Exa numResults 上限 20，超出靜默收斂到帽值）。 */
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

/** 讀 EXA_API_KEY（缺失/空白 → fail-fast 人話報錯）。 */
export function requireExaApiKey(): string {
  const key = (process.env.EXA_API_KEY ?? "").trim()
  if (!key) {
    throw new WebSearchToolError(
      "missing_api_key",
      "缺少 EXA_API_KEY（Exa 搜索上游鑑權）。請在 harness 環境配置該 env 後重試。",
    )
  }
  return key
}

/** 從 Exa 響應機械提取 results（title/url/highlights 原樣帶出）；缺 results 陣列一律拋錯（不猜）。 */
export function extractExaResults(body: unknown): {
  results: Array<{ title: string; url: string; highlights: string[] }>
} {
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  const raw = (body as { results?: unknown })?.results
  if (!Array.isArray(raw)) {
    throw new WebSearchToolError(
      "upstream_bad_response",
      `Exa 响应缺少 results 数组（不猜不造）。原文摘錄：${excerpt}`,
    )
  }
  const results = raw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({
      ...(typeof r.title === "string" ? { title: r.title } : { title: "" }),
      ...(typeof r.url === "string" ? { url: r.url } : { url: "" }),
      highlights: Array.isArray(r.highlights) ? (r.highlights as string[]) : [],
    }))
  return { results }
}

// ── web_search 工具 ──────────────────────────────────────────────────────────

export const webSearchTool: WebToolDef = {
  id: "search_web",
  description:
    "联网搜索最新资料的**预设通用网页搜索工具**（search_web，Exa 上游）：人物／新闻／公司／概念／事实查证／一般资料都先用本工具；返回网页结果列表（标题/链接/高亮片段），研究类任务的实证弹药——结论必须带 URL 出处，禁止只凭内部知识作答。" +
    "**除非使用者明确要求某平台（B站／GitHub／Reddit）的站内内容，否则不要优先挑平台工具。**" +
    "要 B站中文影音／GitHub 开源专案／Reddit 英文社群口碑的站内内容 → 改用 search_aggregate；要某一页的全文内容或程式库/框架文档 → 改用 smart_search。",
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
      description: "搜索深度：basic=快速（映射 Exa type=auto，默认），advanced=更全面但更慢（映射 Exa type=deep）。",
    },
  },
  async execute(rawArgs, context) {
    try {
      const query = asString(rawArgs.query)
      if (!query) {
        return fail("invalid_args", "缺少必填参数 query：需要搜索查询词。")
      }
      const maxResultsProvided = rawArgs.max_results !== undefined && rawArgs.max_results !== null
      let maxResults = WEB_SEARCH_DEFAULT_MAX_RESULTS
      if (maxResultsProvided) {
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
      // search_depth 舊契約 → Exa type：basic→auto（默認）、advanced→deep。
      const exaType = depthRaw === "advanced" ? "deep" : "auto"
      const apiKey = requireExaApiKey()

      // 默認請求 = query + type + contents.highlights（技能推薦形）；其他欄位一律不加。
      // numResults 只在呼叫方明確傳 max_results 時才加（＝刻意的產品決定），否則用服務器默認。
      const requestBody: Record<string, unknown> = {
        query,
        type: exaType,
        contents: { highlights: true },
      }
      if (maxResultsProvided) requestBody.numResults = maxResults

      let response: Response
      try {
        response = await fetch(EXA_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify(requestBody),
          signal: context?.abort ?? AbortSignal.timeout(EXA_TIMEOUT_MS),
        })
      } catch (e) {
        throw new WebSearchToolError(
          "upstream_timeout",
          `Exa 搜索请求失败（网络层或超时 ${EXA_TIMEOUT_MS} ms）：${(e as Error)?.message ?? String(e)}`,
        )
      }
      const bodyText = await response.text().catch(() => "")
      if (!response.ok) {
        const excerpt = bodyText.slice(0, ERROR_BODY_MAX_CHARS) || "(空)"
        if (response.status === 401 || response.status === 403) {
          throw new WebSearchToolError(
            "upstream_auth_error",
            `Exa 鉴权失败（HTTP ${response.status}）：EXA_API_KEY 无效或权限不足。原文 body：${excerpt}`,
          )
        }
        if (response.status === 429) {
          throw new WebSearchToolError(
            "upstream_rate_limited",
            `Exa 触发限流（HTTP 429），请稍后重试。原文 body：${excerpt}`,
          )
        }
        throw new WebSearchToolError(
          "upstream_http_error",
          `Exa 返回 HTTP ${response.status}。原文 body：${excerpt}`,
        )
      }
      let body: unknown
      try {
        body = JSON.parse(bodyText)
      } catch {
        throw new WebSearchToolError(
          "upstream_bad_response",
          `Exa 响应不是合法 JSON（HTTP ${response.status}）。原文前 2000 字符：${bodyText.slice(0, 2000)}`,
        )
      }

      const picked = extractExaResults(body)
      const requestIdRaw = (body as { requestId?: unknown })?.requestId
      const requestId = typeof requestIdRaw === "string" && requestIdRaw.trim() !== "" ? requestIdRaw : undefined
      const costDollars = (body as { costDollars?: unknown })?.costDollars
      return ok({
        title: "搜索完成",
        query,
        search_depth: depthRaw,
        max_results: maxResults,
        result_count: picked.results.length,
        coverage_notice: "已用通用网页搜索；若要 B站／GitHub／Reddit 的站内内容请用 search_aggregate。",
        results: picked.results,
        ...(requestId ? { requestId } : {}),
        ...(costDollars !== undefined ? { costDollars } : {}),
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
