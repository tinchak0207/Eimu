/**
 * memory_recall harness 工具 VPS staging 稿（P0-5，2026-09-15）。
 *
 * 行为真源＝本档；部署落点＝VPS `/opt/agent-harness/workspace/.opencode/lib/memory_recall_impl.ts`。
 * 结构逐行同构 R1 search_web 轮子（VPS `.opencode/lib/web_search_impl.ts`，2026-09-10 机械导出）：
 * 纯零依赖、无 import、同 ok/fail plumbing 契约、同错误铁律（缺参数/非 2xx/网络层失败一律
 * 结构化 fail() 带原文摘录与人话 hint，绝不 throw 逃逸、绝不吞错、绝不伪造结果）、同 20s 超时帽。
 * 白名单偏离（仅此处）：上游通路从「Tavily 外网 + body api_key」改为「gateway loopback + Bearer」，
 * 故删除 TAVILY_* 常量与 requireTavilyApiKey，改为 GATEWAY/HARNESS_API_KEY 读取与
 * POST `${GATEWAY}/agent/v1/memory/recall`；回应解析从 extractTavilyResults 改为 extractRecalledDocs。
 *
 * ⚠ 与 spec 的现场冲突（如实回报）：spec 说「认证头比照 search_web_impl 打中控的同一形状」，
 *   但轮子原文 web_search_impl.ts 打的并非中控（是 https://api.tavily.com/search，鉴权走 body
 *   api_key，无任何 gateway Bearer 头）。仓内真正「打中控 loopback」的形状在 client.ts /
 *   music-tools-impl.ts / director-common.ts：`Authorization: Bearer ${HARNESS_API_KEY}`，
 *   GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"。本片照该同族形状实装
 *   （端点族 /agent/v1/* 走 sk-biz Bearer 闸门，见 gateway 快照 L52/L7882；HARNESS_API_KEY
 *   ＝.env.biz-key，见记忆 2026-09-11-P2b：agent API = Authorization Bearer HARNESS_API_KEY）。
 *
 * 上游通路：中控 gateway loopback（VPS 内）：
 *   端点  POST ${GATEWAY_URL}/agent/v1/memory/recall（由接线片新增，同族 /agent/v1 Bearer 鉴权）
 *   鉴权  Header Authorization: Bearer ${HARNESS_API_KEY}（读 env，缺失 fail-fast 人话报错）
 *   请求  { query, domain?, limit? }（limit 1-5，默认 3，超出收敛到帽值 5）
 *   响应  { results: [{domain, slug, description, body, score?}], count }（契约 §7 top-3 召回形状；
 *          实际栏位以接线片为准，解析层对缺栏宽容、对无 results 阵列抛错不猜）
 *
 * 输出：格式化回「[domain] slug — description\n   body」逐条串接（人与模型都可读），
 *      同时保留原始 docs 供上层需要时取结构。工具文案一律简体（记忆 agent-gateway-copy-rules）。
 */

/** 中控 gateway loopback 基址（默认 http://127.0.0.1:8081，同 music-tools-impl / director-common）。 */
export const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/** memory_recall 端点路径（同族 /agent/v1 Bearer 闸门）。 */
export const MEMORY_RECALL_PATH = "/agent/v1/memory/recall"

/** 上游响应超时（召回是轻请求，20s 硬顶，同 search_web 口径）。 */
export const MEMORY_RECALL_TIMEOUT_MS = 20_000

/** limit 默认值（对齐契约 §7 召回 top-3）。 */
export const MEMORY_RECALL_DEFAULT_LIMIT = 3

/** limit 上限（PRD §6.2 工具规格：limit?≤5，超出静默收敛到帽值）。 */
export const MEMORY_RECALL_LIMIT_CAP = 5

/** 错误讯息里携带的原文 body 上限（同 search_web_impl 口径；截断时显式标注）。 */
const ERROR_BODY_MAX_CHARS = 8000

/** HARNESS_API_KEY fallback（读不到 .env.opencode 时的兜底来源，同 music-tools-impl）。 */
const HARNESS_API_KEY_FALLBACK = process.env.HARNESS_API_KEY || ""

// ── plumbing（ok/fail 逐行同构 web_search_impl.ts） ──────────────────────────

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

// ── 参数整理助手（同构 web_search_impl 口径） ────────────────────────────────

export interface MemoryToolArgSpec {
  type: "string" | "number" | "boolean"
  required: boolean
  description: string
  enum?: readonly string[]
}

export interface MemoryToolContext {
  abort?: AbortSignal
  /** 会话 id（memory_recall 无需会话资产落盘；adapter 机械透传保留栏位，同 web_search_impl 口径）。 */
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

// ── 鉴权与解析（诚实铁律：不猜不造，缺什么报什么） ───────────────────────────

/** 读 HARNESS_API_KEY（缺失/空白 → fail-fast 人话报错，镜像 requireTavilyApiKey）。 */
export function requireHarnessApiKey(): string {
  const key = (HARNESS_API_KEY_FALLBACK || process.env.HARNESS_API_KEY || "").trim()
  if (!key) {
    throw new MemoryRecallToolError(
      "missing_api_key",
      "缺少 HARNESS_API_KEY（memory_recall 走中控 /agent/v1 Bearer 闸门）。请在 harness 环境配置该 env 后重试。",
    )
  }
  return key
}

/** 召回条目（对齐契约 §1 AgentMemoryDoc 的注入子集；缺栏宽容为空字串，不猜）。 */
export interface RecalledDoc {
  domain: string
  slug: string
  description: string
  body: string
  score?: number
}

/** 从中控召回响应机械提取 results 阵列；缺 results 一律抛错（不猜不造）。 */
export function extractRecalledDocs(body: unknown): { docs: RecalledDoc[]; count: number } {
  const excerpt = JSON.stringify(body)?.slice(0, 2000) ?? ""
  const raw = (body as { results?: unknown; docs?: unknown })?.results
    ?? (body as { docs?: unknown })?.docs
  if (!Array.isArray(raw)) {
    throw new MemoryRecallToolError(
      "upstream_bad_response",
      `中控召回响应缺少 results 数组（不猜不造）。原文摘录：${excerpt}`,
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

/** 格式化召回条目为「[domain] slug — description\n   body」（PRD §6.2 工具回传形状）。 */
export function formatRecalledDocs(docs: RecalledDoc[]): string {
  if (docs.length === 0) return ""
  return docs
    .map((d) => `[${d.domain}] ${d.slug} — ${d.description}\n   ${d.body}`)
    .join("\n\n")
}

// ── memory_recall 工具 ───────────────────────────────────────────────────────

export const memoryRecallTool: MemoryToolDef = {
  id: "memory_recall",
  description: [
    "从平台共享记忆库召回领域知识正文（memory_recall）。",
    "何时用：共享目录摘要不足以落地，需要读某条全文时。",
    "何时不用：摘要已足够、或只是通用常识时不要召回。",
    "关键约束：返回 [domain] slug — description 与 body；记忆是写下那一刻的观察，可能过期，与现场冲突时以现场为准并说明冲突；limit 1-5，默认 3。",
    "示例：memory_recall({query:\"纪录片 节奏 卡点\", limit:3})",
  ].join("\n"),
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

/** harness-tool-registry.ts 登记用 id 元组（同 WEB_SEARCH_HARNESS_TOOL_IDS 范式）。
 *  命名域教训（2026-09-10 VPS 实锤）：opencode 1.18.14 保留 websearch/web_search 命名域，
 *  自订工具档名撞名即被物理移除。memory_recall 非保留名（保留名域无此词），OK；
 *  注册名=tools/ 档名（memory_recall），id 栏仅 registry 登记用。 */
export const MEMORY_RECALL_HARNESS_TOOL_IDS = ["memory_recall"] as const
