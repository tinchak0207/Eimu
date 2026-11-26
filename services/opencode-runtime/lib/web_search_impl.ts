/**
 * web_search harness 工具 VPS staging 稿（beast 军团 R1，2026-09-10 机械导出）。
 *
 * 本档由 tools/export-web-search-tools-staging.ts 从行为真源 src/lib/web-search-tools.ts
 * 机械导出：真源全文逐行保留（工具定义/ok-fail/Exa 通路/错误铁律/超时全在），
 * 零依赖、无 import，除本注释头外与真源逐行等价。
 * 禁止手改本档——改真源后跑 `npx tsx tools/export-web-search-tools-staging.ts` 重导出。
 *
 * 落位：/opt/agent-harness/workspace/.opencode/lib/web_search_impl.ts
 * env：EXA_API_KEY（Exa Search API 鉴权，写 /opt/agent-harness/.env 与
 *      .env.opencode 双档；TAVILY_API_KEY 暂留）。
 */

/**
 * web_search harness 工具（beast 军团 R1 研究军团搜索弹药，2026-09-10；2026-10-02 上游 Tavily→Exa）。
 *
 * 定义形状同构 src/lib/music-tools.ts 的 MusicToolDef（零依赖：
 * { id, description, args, execute } + ok()/fail() 契约，回 { title, output }，
 * output 为 JSON 字串）；ok/fail 与错误铁律逐行同构 src/lib/music-tools.ts
 * （本工具无会话资产落盘，砍上传/ffprobe/音频专属面，plumbing 契约不动）。
 *
 * 上游通路：Exa REST Search API（技能 build-with-exa 为唯一真源）：
 *   端点  POST https://api.exa.ai/search
 *   鉴权  HTTP header x-api-key（读 env EXA_API_KEY；key 不入 body）
 *   请求  { query, type: "auto"|"deep", contents: { highlights: true }, numResults? }
 *   响应  { requestId, results: [{ title, url, highlights: string[] }], costDollars, searchTime }
 *
 * 参数口径（照技能，不臆造）：默认请求只有 query + type + contents.highlights；
 *   numResults 仅在呼叫方明确传 max_results 时才送（刻意产品决定，否则用服务器默认）；
 *   search_depth 保留旧名，映射 basic→auto、advanced→deep。
 *   include_answer 为 Tavily 专属参数，已移除（产品自有聊天 LLM，只给 /search 当工具）。
 *
 * 错误铁律（同 music-tools 诚实铁律）：缺 key / 非 2xx / 网络层失败一律结构化
 * fail() 带原文摘录与人话 hint，绝不 throw 逃逸、绝不吞错、绝不伪造结果。
 * 超时 20s 硬顶（AbortSignal.timeout）。工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

/** Exa Search API 端点。 */
export const EXA_SEARCH_URL = "https://api.exa.ai/search"

/** 上游响应超时（搜索是轻请求，20s 硬顶）。 */
export const EXA_TIMEOUT_MS = 20_000

/** max_results 默认值。 */
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 8

/** max_results 上限（Exa numResults 上限 20，超出静默收敛到帽值）。 */
export const WEB_SEARCH_MAX_RESULTS_CAP = 20

/** 错误讯息里携带的原文 body 上限（同 music-lyria.ts 口径；截断时显式标注）。 */
const ERROR_BODY_MAX_CHARS = 8000

// ── plumbing（ok/fail 同构 music-tools.ts） ─────────────────────────────────

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

// ── 参数整理助手（同构 music-tools.ts 口径） ────────────────────────────────

export interface WebToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface WebToolContext {
  abort?: AbortSignal
  /** 会话 id（web_search 暂无会话资产落盘；adapter 机械透传保留栏位，同 music-tools-adapter 口径）。 */
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

// ── 鉴权与解析（诚实铁律：不猜不造，缺什么报什么） ───────────────────────────

/** 读 EXA_API_KEY（缺失/空白 → fail-fast 人话报错）。 */
export function requireExaApiKey(): string {
  const key = (process.env.EXA_API_KEY ?? "").trim()
  if (!key) {
    throw new WebSearchToolError(
      "missing_api_key",
      "缺少 EXA_API_KEY（Exa 搜索上游鉴权）。请在 harness 环境配置该 env 后重试。",
    )
  }
  return key
}

/** 从 Exa 响应机械提取 results（title/url/highlights 原样带出）；缺 results 阵列一律抛错（不猜）。 */
export function extractExaResults(body: unknown): {
  results: Array<{ title: string; url: string; highlights: string[] }>
} {
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  const raw = (body as { results?: unknown })?.results
  if (!Array.isArray(raw)) {
    throw new WebSearchToolError(
      "upstream_bad_response",
      `Exa 响应缺少 results 数组（不猜不造）。原文摘录：${excerpt}`,
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
      // search_depth 旧契约 → Exa type：basic→auto（默认）、advanced→deep。
      const exaType = depthRaw === "advanced" ? "deep" : "auto"
      const apiKey = requireExaApiKey()

      // 默认请求 = query + type + contents.highlights（技能推荐形）；其他栏位一律不加。
      // numResults 只在呼叫方明确传 max_results 时才加（＝刻意的产品决定），否则用服务器默认。
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

/** harness-tool-registry.ts 登记用 id 元组（同 MUSIC_HARNESS_TOOL_IDS 范式）。
 *  命名域实锤（2026-09-10 VPS）：opencode 1.18.14 保留 websearch/web_search 命名域，
 *  自订工具档名撞名即被物理移除（ws_probe HAVE / web_search NOT_HAVE 对照实锤），
 *  故 harness 注册名=档名 search_web；id 栏仅 registry 登记用，注册名以档名为准。 */
export const WEB_SEARCH_HARNESS_TOOL_IDS = ["search_web"] as const
