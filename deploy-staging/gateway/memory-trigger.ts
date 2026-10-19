/**
 * memory-trigger.ts — 「该写记忆」信号的确定性侦测（纯函式，2026-10-19）。
 *
 * 目的：session.idle 收盘时用**可解释的固定规则**判断这一轮是否值得进入记忆提炼队列。
 * 只做侦测，不做判断内容、不呼叫 LLM、不读写任何 IO。异步入队与审计在 memory-queue.ts，
 * 接线在 opencode-event-handler.ts（收盘路径 fire-and-forget）。
 *
 * 规则（与工单逐条对应）：
 *   - turnAborted      → 不触发（用户主动叫停不是学习信号）。
 *   - user_correction  → userText 命中纠正样板。
 *   - tool_failure     → upstreamError 非空或 turnRetries ≥ 1。
 *   - repeated_failure → turnRetries ≥ 2 或 repeatedToolFailures；并同时保留 tool_failure。
 *
 * sample 纪律：只取 userText 前 120 字元（换行压成空格）；无 userText 时只留**错误分类词**，
 * 不透传 error 原文。脱敏后保证不含 sk-／Bearer／AIza／邮箱／@／URL。纯函式：无 IO、
 * 不读 env、不取 Date.now。
 */

export type MemorySignalKind = "user_correction" | "tool_failure" | "repeated_failure"

export interface MemoryTurnFacts {
  userText?: string | null
  turnTextChars?: number
  turnRetries?: number
  repeatedToolFailures?: boolean
  turnAborted?: boolean
  upstreamError?: string | null
}

export interface MemorySignalResult {
  triggered: boolean
  kinds: MemorySignalKind[]
  /** ≤200 字元、无凭证、供人工查看。 */
  sample: string
}

/**
 * 纠正样板：用户明确指出上一轮做错/要求返工的措辞。
 * 刻意保留工单给的样板集合（不扩不缩），保证规则可解释、可回放。
 */
const CORRECTION_RE =
  /(?:不是这样|你错了|不对|应该|别再|又错|我说过|纠正|重新|搞错|为什么还)/

const SAMPLE_MAX_CHARS = 120

/** 错误分类词：只输出类别，绝不外泄原文（原文可能含 URL／key／账户信息）。 */
function classifyUpstreamError(error: string): string {
  const e = error.toLowerCase()
  if (/credit|balance|quota|insufficient|欠费|余额/.test(e)) return "account_credit"
  if (/401|403|unauthorized|forbidden|invalid.?key|authentication|鉴权|无权限/.test(e)) return "auth"
  if (/429|rate.?limit|too.?many.?requests|overload|过载|限流/.test(e)) return "rate_limit"
  if (/timeout|timed.?out|etimedout|超时/.test(e)) return "timeout"
  if (/tls|econnreset|econnrefused|socket|network|fetch failed|connection|断线|连接/.test(e)) return "network"
  if (/model|模型|404/.test(e)) return "model_unavailable"
  return "upstream_error"
}

/**
 * sample 脱敏：凭证/身份/URL 先替换，再压换行、再截断。
 * 替换成固定占位符（而非删除），人工仍能看出「这里原本有敏感内容」。
 *
 * 2026-10-19 P2-4：补齐键值对凭证（password/passwd/pwd/token/secret/api_key 等，
 * `key=value` 与 `key: value` 皆收，值可为引号包裹）、`sk-\S+`、`Bearer\s+\S+`、
 * `AIza...`；邮箱与 URL 维持既有处理；最后硬截 120 字元。
 * 2026-10-19 补中文键名（密码/验证码/密钥/口令/令牌/凭据）与全角冒号 `：`；
 * 中文键无 `\b` 边界，故英文键用负向后行断言界定起点、中文键不套该断言。
 * 本函式同时供 enqueueMemorySignal 内部再脱敏一次（入队层不依赖调用方）。
 */
export function sanitizeMemorySample(text: string | null | undefined): string {
  if (typeof text !== "string" || text.length === 0) return ""
  const redacted = text
    // 键值对凭证：整对替换（先于 sk-/URL 处理，避免值被拆散后残留键名）。
    // 英文键名需左侧非 word 边界（避免把 mypassword 当成 password）；中文键名不套
    // 该断言（`abc密码：x` 这类紧贴 ASCII 的中文键也必须收）。全角冒号与半角同收。
    .replace(
      /(?:(?<![A-Za-z0-9_])(?:password|passwd|pwd|token|secret|api[_-]?key)|(?:密码|验证码|密钥|口令|令牌|凭据))\s*[:=：]\s*(?:"[^"]*"|'[^']*'|[^\s&;,'"]+)/gi,
      "[redacted]",
    )
    // Bearer / sk- key / Google API key（整段替换）。
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\bsk-\S+/gi, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]+/g, "[redacted]")
    // URL（含协议或 www.）。
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\bwww\.[^\s]+/gi, "[url]")
    // 邮箱 → 占位符（此步必须早于 @ 清理，否则会把邮箱切成两半）。
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    // 剩余 @（例如 @handle）一律不留。
    .replace(/@/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
  const chars = Array.from(redacted)
  return chars.length > SAMPLE_MAX_CHARS ? chars.slice(0, SAMPLE_MAX_CHARS).join("") : redacted
}

/** 纯函式信号侦测（确定性；同一 facts 永远得到同一结果）。 */
export function detectMemorySignals(facts: MemoryTurnFacts): MemorySignalResult {
  const kinds: MemorySignalKind[] = []
  const add = (kind: MemorySignalKind): void => {
    if (!kinds.includes(kind)) kinds.push(kind)
  }

  // 用户主动叫停：不是学习信号，整体不触发。
  if (facts.turnAborted === true) {
    return { triggered: false, kinds, sample: "" }
  }

  const userText = typeof facts.userText === "string" ? facts.userText : ""
  const retries = typeof facts.turnRetries === "number" && Number.isFinite(facts.turnRetries)
    ? Math.max(0, Math.floor(facts.turnRetries))
    : 0
  const upstreamError =
    typeof facts.upstreamError === "string" ? facts.upstreamError.trim() : ""

  if (userText.trim().length > 0 && CORRECTION_RE.test(userText)) add("user_correction")

  const toolFailure = upstreamError.length > 0 || retries >= 1
  if (toolFailure) add("tool_failure")

  const repeated = retries >= 2 || facts.repeatedToolFailures === true
  if (repeated) {
    // 重复失败必然也是工具/上游失败：两个标签同时保留，避免下游只看到一个窄标签。
    add("tool_failure")
    add("repeated_failure")
  }

  let sample = sanitizeMemorySample(userText)
  if (!sample) {
    // 无用户文本时只给分类词或重试次数，绝不给 error 原文。
    if (upstreamError) sample = `错误分类=${classifyUpstreamError(upstreamError)}`
    else if (repeated) sample = `连续失败重试=${retries}`
  }

  return { triggered: kinds.length > 0, kinds, sample }
}
