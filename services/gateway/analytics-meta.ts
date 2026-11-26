/**
 * analytics-meta.ts — 落入 log/journal 的自由字串的型别层签核 ＋ 出口遮罩
 *
 * 设计取自 Claude Code analytics 的 brand-type 手法（`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`，
 * 见其 src/services/analytics/index.ts：以 `never` 为目标型别，逼呼叫端当场 `as` 签核）
 * ——**只取设计概念，未复制其程式码**。我方把守门从「code/filepath」聚焦到本产品真正的泄漏面：
 * secret／token。gateway 自身的 console.log 会进 journalctl，是本专案目前最弱的出口
 * （grep 不到任何同构手法，见 2026-10-02 任务记录）。
 *
 * 两个机制：
 *  ① 型别层签核：`LogSafeText` = `never`。任何自由字串要当成「可落 log」使用时，必须经
 *     `redactForLog()` 产出（或明示 `as LogSafeText` 签名并自负），否则编译不过。这是编译期闸门。
 *  ② 出口遮罩：`redactForLog()` / `redactMeta()` 对已知 secret 样式做遮罩，保留可辨识前缀。
 *
 * 诚实边界：型别层是「提醒＋签核」，不是保证；真正的保证是每个 log 出口都先过 redactForLog。
 * 本模组刻意零依赖（不 import 任何 gateway 档），避免循环 import，任何档案都能安全引用。
 */

/**
 * 签核点（设计取自 Claude Code analytics brand type，未复制程式码）。
 * 目标型别是 `never`：任何字串都不可直接赋值，必须当场 `as` 转型才编得过——逼开发者签名。
 */
export type AnalyticsMeta_I_VERIFIED_THIS_IS_NOT_A_SECRET = never

/**
 * 「已确认不含 secret、可写入 log/journal」的自由文字。
 * 唯一正规产出是 `redactForLog()`（先遮罩再签核）；手动 `as LogSafeText` 等于自行签名负责。
 */
export type LogSafeText = AnalyticsMeta_I_VERIFIED_THIS_IS_NOT_A_SECRET

/** 遮罩标记（稳定字面，供测试与人眼辨识）。 */
export const REDACT_MARKER = "已遮罩"

/** 预设单行上限：避免把超大 blob 灌进 journal（超出即截断）。 */
export const DEFAULT_LOG_MAX_LEN = 4000

/** 保留可辨识前缀后套遮罩标记，例如 `sk-FAKE-1234` → `sk-F…（已遮罩，长度 12）`。 */
function maskValue(prefix: string, value: string): string {
  const head = value.slice(0, 4)
  return `${prefix}${head}…（${REDACT_MARKER}，长度 ${value.length}）`
}

/**
 * 已知 secret 样式的遮罩器（依序套用）。
 * 涵盖需求指定的全部形态：`sk-…`、`Bearer <token>`、`key=`/`token=`/`secret=`/`password=` 后面的值、
 * 长 base64、JWT（三段 base64url）。
 * 顺序理由：Bearer 先于 sk（保留 `Bearer` 前缀），JWT 先于通用 base64（避免把 JWT 拆成数段）。
 */
const REDACTORS: Array<(s: string) => string> = [
  // ① Bearer <token>
  (s) => s.replace(/(\bBearer\s+)([A-Za-z0-9._~+/=\-]{6,})/gi, (_m, p1: string, p2: string) => maskValue(p1, p2)),
  // ② sk-… API key（含 sk-biz-… 等变体）
  (s) => s.replace(/\bsk-[A-Za-z0-9._\-]{4,}/g, (m) => maskValue("", m)),
  // ③ JWT（header.payload.signature，三段 base64url）
  (s) => s.replace(/\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{2,}/g, (m) => maskValue("", m)),
  // ④ key=value / token: value / secret= / password=（值至少 4 字元才遮，避免误遮 key=1）
  (s) =>
    s.replace(
      /\b(key|token|secret|password|passwd|api[_\-]?key|access[_\-]?token|refresh[_\-]?token)(\s*[:=]\s*)(["']?)([^\s"'&,;]{4,})/gi,
      (_m, k: string, sep: string, _q: string, v: string) => maskValue(k + sep, v),
    ),
  // ⑤ 长 base64/blob（保守门槛 32+，避免误遮一般长单词／中文）
  (s) => s.replace(/[A-Za-z0-9+/]{32,}={0,2}/g, (m) => maskValue("", m)),
]

/** 任意输入 → 可读文字（Error 取 name+message；物件走 JSON，坏掉则退回 String）。 */
function toText(input: unknown): string {
  if (typeof input === "string") return input
  if (input instanceof Error) return `${input.name}: ${input.message}`
  if (input === null) return "null"
  if (input === undefined) return "undefined"
  if (typeof input === "object") {
    try {
      return JSON.stringify(input) ?? String(input)
    } catch {
      return "[unserializable]"
    }
  }
  return String(input)
}

/**
 * 把任意输入转成「可安全落 log」的文字：先遮罩已知 secret 样式，再截断到上限，
 * 最后以 brand type 签核。函数回传型别是 `LogSafeText`（= never）——这是唯一的正规签核入口。
 */
export function redactForLog(input: unknown, opts: { maxLen?: number } = {}): LogSafeText {
  const maxLen = opts.maxLen ?? DEFAULT_LOG_MAX_LEN
  let s = toText(input)
  for (const r of REDACTORS) {
    try {
      s = r(s)
    } catch {
      // 单一 pattern 失败不影响其他遮罩器（fail-open，安全侧仍会走截断）
    }
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + `…（已截断，原长 ${s.length}）`
  return s as LogSafeText
}

/** 键名看起来就是 secret 时，整个字串值不再逐 pattern 比对，直接整值遮罩。 */
const SECRET_KEY_RE = /token|secret|password|passwd|authorization|cookie|api[-_]?key|bearer/i

/**
 * 递回遮罩一个结构（object/array）中的所有字串值，供「把整包 metadata 落 log」的出口使用。
 * - 字串值 → redactForLog
 * - 数字／布林／null → 原样
 * - 键名命中 SECRET_KEY_RE → 整值遮罩（不依赖值本身长得像不像 secret）
 * - 深度上限 8、circular 以 WeakSet 防护
 */
export function redactMeta(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof input === "string") return redactForLog(input)
  if (input === null || typeof input !== "object") return input
  if (depth >= 8) return "[depth-limit]"
  if (seen.has(input)) return "[circular]"
  seen.add(input)
  if (Array.isArray(input)) return input.map((x) => redactMeta(x, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && SECRET_KEY_RE.test(k)) out[k] = maskValue("", v)
    else out[k] = redactMeta(v, depth + 1, seen)
  }
  return out
}

/**
 * journal 出口：先遮罩整行再写 stdout/stderr。呼叫端若传自由字串，会在此处被遮罩，
 * 但**要拿型别层签核**仍得自己用 `redactForLog()` 产出 `LogSafeText`（见 metrics-gw 的 brand sink）。
 */
export function logLine(level: "info" | "error", text: unknown, extra?: unknown): void {
  const line = redactForLog(text)
  const tail = extra === undefined ? undefined : redactForLog(extra)
  if (tail === undefined) {
    if (level === "error") console.error(line)
    else console.log(line)
  } else if (level === "error") console.error(line, tail)
  else console.log(line, tail)
}
