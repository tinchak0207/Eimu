/**
 * analytics-meta.ts — 落入 log/journal 的自由字串的型別層簽核 ＋ 出口遮罩
 *
 * 設計取自 Claude Code analytics 的 brand-type 手法（`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`，
 * 見其 src/services/analytics/index.ts：以 `never` 為目標型別，逼呼叫端當場 `as` 簽核）
 * ——**只取設計概念，未複製其程式碼**。我方把守門從「code/filepath」聚焦到本產品真正的洩漏面：
 * secret／token。gateway 自身的 console.log 會進 journalctl，是本專案目前最弱的出口
 * （grep 不到任何同構手法，見 2026-10-02 任務記錄）。
 *
 * 兩個機制：
 *  ① 型別層簽核：`LogSafeText` = `never`。任何自由字串要當成「可落 log」使用時，必須經
 *     `redactForLog()` 產出（或明示 `as LogSafeText` 簽名並自負），否則編譯不過。這是編譯期閘門。
 *  ② 出口遮罩：`redactForLog()` / `redactMeta()` 對已知 secret 樣式做遮罩，保留可辨識前綴。
 *
 * 誠實邊界：型別層是「提醒＋簽核」，不是保證；真正的保證是每個 log 出口都先過 redactForLog。
 * 本模組刻意零依賴（不 import 任何 gateway 檔），避免循環 import，任何檔案都能安全引用。
 */

/**
 * 簽核點（設計取自 Claude Code analytics brand type，未複製程式碼）。
 * 目標型別是 `never`：任何字串都不可直接賦值，必須當場 `as` 轉型才編得過——逼開發者簽名。
 */
export type AnalyticsMeta_I_VERIFIED_THIS_IS_NOT_A_SECRET = never

/**
 * 「已確認不含 secret、可寫入 log/journal」的自由文字。
 * 唯一正規產出是 `redactForLog()`（先遮罩再簽核）；手動 `as LogSafeText` 等於自行簽名負責。
 */
export type LogSafeText = AnalyticsMeta_I_VERIFIED_THIS_IS_NOT_A_SECRET

/** 遮罩標記（穩定字面，供測試與人眼辨識）。 */
export const REDACT_MARKER = "已遮罩"

/** 預設單行上限：避免把超大 blob 灌進 journal（超出即截斷）。 */
export const DEFAULT_LOG_MAX_LEN = 4000

/** 保留可辨識前綴後套遮罩標記，例如 `sk-FAKE-1234` → `sk-F…（已遮罩，長度 12）`。 */
function maskValue(prefix: string, value: string): string {
  const head = value.slice(0, 4)
  return `${prefix}${head}…（${REDACT_MARKER}，長度 ${value.length}）`
}

/**
 * 已知 secret 樣式的遮罩器（依序套用）。
 * 涵蓋需求指定的全部形態：`sk-…`、`Bearer <token>`、`key=`/`token=`/`secret=`/`password=` 後面的值、
 * 長 base64、JWT（三段 base64url）。
 * 順序理由：Bearer 先於 sk（保留 `Bearer` 前綴），JWT 先於通用 base64（避免把 JWT 拆成數段）。
 */
const REDACTORS: Array<(s: string) => string> = [
  // ① Bearer <token>
  (s) => s.replace(/(\bBearer\s+)([A-Za-z0-9._~+/=\-]{6,})/gi, (_m, p1: string, p2: string) => maskValue(p1, p2)),
  // ② sk-… API key（含 sk-biz-… 等變體）
  (s) => s.replace(/\bsk-[A-Za-z0-9._\-]{4,}/g, (m) => maskValue("", m)),
  // ③ JWT（header.payload.signature，三段 base64url）
  (s) => s.replace(/\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{2,}/g, (m) => maskValue("", m)),
  // ④ key=value / token: value / secret= / password=（值至少 4 字元才遮，避免誤遮 key=1）
  (s) =>
    s.replace(
      /\b(key|token|secret|password|passwd|api[_\-]?key|access[_\-]?token|refresh[_\-]?token)(\s*[:=]\s*)(["']?)([^\s"'&,;]{4,})/gi,
      (_m, k: string, sep: string, _q: string, v: string) => maskValue(k + sep, v),
    ),
  // ⑤ 長 base64/blob（保守門檻 32+，避免誤遮一般長單詞／中文）
  (s) => s.replace(/[A-Za-z0-9+/]{32,}={0,2}/g, (m) => maskValue("", m)),
]

/** 任意輸入 → 可讀文字（Error 取 name+message；物件走 JSON，壞掉則退回 String）。 */
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
 * 把任意輸入轉成「可安全落 log」的文字：先遮罩已知 secret 樣式，再截斷到上限，
 * 最後以 brand type 簽核。函數回傳型別是 `LogSafeText`（= never）——這是唯一的正規簽核入口。
 */
export function redactForLog(input: unknown, opts: { maxLen?: number } = {}): LogSafeText {
  const maxLen = opts.maxLen ?? DEFAULT_LOG_MAX_LEN
  let s = toText(input)
  for (const r of REDACTORS) {
    try {
      s = r(s)
    } catch {
      // 單一 pattern 失敗不影響其他遮罩器（fail-open，安全側仍會走截斷）
    }
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + `…（已截斷，原長 ${s.length}）`
  return s as LogSafeText
}

/** 鍵名看起來就是 secret 時，整個字串值不再逐 pattern 比對，直接整值遮罩。 */
const SECRET_KEY_RE = /token|secret|password|passwd|authorization|cookie|api[-_]?key|bearer/i

/**
 * 遞迴遮罩一個結構（object/array）中的所有字串值，供「把整包 metadata 落 log」的出口使用。
 * - 字串值 → redactForLog
 * - 數字／布林／null → 原樣
 * - 鍵名命中 SECRET_KEY_RE → 整值遮罩（不依賴值本身長得像不像 secret）
 * - 深度上限 8、circular 以 WeakSet 防護
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
 * journal 出口：先遮罩整行再寫 stdout/stderr。呼叫端若傳自由字串，會在此處被遮罩，
 * 但**要拿型別層簽核**仍得自己用 `redactForLog()` 產出 `LogSafeText`（見 metrics-gw 的 brand sink）。
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
