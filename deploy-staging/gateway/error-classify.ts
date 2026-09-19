// F3（2026-08-31）：統一錯誤信封——合併原本分散在兩處的正則表：
// workflow-service.ts 的 RETRYABLE_NODE_ERROR（只判 retryable，不含人話）與
// index.ts 的 SUPPLIER_ERROR_HUMANIZERS（只判人話，不含 retryable）。
// 兩表各自維護導致真實漏洞：RETRYABLE_NODE_ERROR 完全沒覆蓋 429/限流/容量飽和，
// 這類上游明確「可重試」的錯誤被節點重試迴圈判成 non-retryable 直接判死——
// R3 診斷「錯誤三層各自為政」的具體病灶之一。單一入口，兩處呼叫，避免下次
// 修一處漏另一處。
export type ErrorClass =
  | "rate_limit"
  | "capacity"
  | "timeout"
  | "network"
  | "auth"
  | "quota"
  | "content"
  | "aborted"
  | "not_found"
  | "input_too_long"
  | "unknown"

export interface ClassifiedError {
  class: ErrorClass
  retryable: boolean
  human: string
}

interface Rule {
  test: RegExp
  class: ErrorClass
  retryable: boolean
  human: string
}

// 順序即優先序：更具體的規則（如 poll+5xx 組合）排在通用規則之前，
// 避免通用 timeout/5xx 規則搶先命中丟失更精確的人話文案。
const RULES: Rule[] = [
  {
    // 2026-08-31：shuai（Cloudflare 前置）间歇性下发不完整证书链。
    test: /unable to verify (?:the )?(?:first )?certificate|self signed certificate|socket connection was closed|unable to verify leaf signature|ERR_TLS/i,
    class: "network",
    retryable: true,
    human: "上游模型服务的网络连接不稳定（证书校验/连接中断），系统已自动换渠道重试，无需你做任何操作。",
  },
  {
    test: /task\s*(?:was\s*)?not\s*found/i,
    class: "not_found",
    retryable: false,
    human: "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。",
  },
  {
    test: /input tokens? exceed/i,
    class: "input_too_long",
    retryable: false,
    human: "输入内容太长，超出了模型单次可读的上限。我会在本轮结束后自动压缩上下文再继续；若反复出现，建议让我分章/分段处理。",
  },
  {
    test: /no enabled supplier capability matches/i,
    class: "unknown",
    retryable: false,
    human: "该模型当前没有可用上游供给（可能不支持此尺寸或比例），请更换模型或调整尺寸后重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}\b502\b|\b502\b[^\n]{0,40}\bpoll\b/i,
    class: "network",
    retryable: true,
    human: "上游画图服务超时（poll 502），节点可在画布上重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}\b50[34]\b|\b50[34]\b[^\n]{0,40}\bpoll\b/i,
    class: "network",
    retryable: true,
    human: "上游画图服务异常（poll 503/504），节点可在画布上重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}(time[ -]?out|timed[ -]?out)|(time[ -]?out|timed[ -]?out)[^\n]{0,40}\bpoll\b/i,
    class: "timeout",
    retryable: true,
    human: "上游画图服务超时（poll 超时），节点可在画布上重试",
  },
  // F3 新增：429/限流/容量飽和是可重試的暫態錯誤——舊 RETRYABLE_NODE_ERROR
  // 完全沒覆蓋，這類節點以前直接判死不重試，浪費了唯一該用上的重試機會。
  {
    test: /\b(overload|overloaded|capacity[_ -]?saturated|rate[ -]?limit|too many requests|http_?429|429)\b/i,
    class: "rate_limit",
    retryable: true,
    human: "上游过载或限流，请稍后重试",
  },
  { test: /\bbad[ -]?gateway\b|\bhttp_?502\b/i, class: "network", retryable: true, human: "上游网关错误（502 Bad Gateway），请稍后重试" },
  { test: /\bservice[ -]?unavailable\b|\bhttp_?503\b/i, class: "network", retryable: true, human: "上游服务暂不可用（503），请稍后重试" },
  { test: /\bgateway[ -]?timeout\b|\bhttp_?504\b/i, class: "network", retryable: true, human: "上游网关超时（504），请稍后重试" },
  {
    test: /\b(fetch failed|econnreset|econnrefused|socket hang[ -]?up|network error)\b/i,
    class: "network",
    retryable: true,
    human: "上游连接中断（网络错误），请稍后重试",
  },
  { test: /\b(time[ -]?out|timed[ -]?out|timeout)\b/i, class: "timeout", retryable: true, human: "上游响应超时，请稍后重试" },
  {
    test: /\b(insufficient[ _-]?(account[ _-]?)?(balance|credit)|quota exceeded|余额不足|欠费)\b/i,
    class: "quota",
    retryable: false, // 欠費重試也不會好，換渠道（F2）才有意義，node 級重試無用
    human: "上游余额或配额不足，请联系维护方",
  },
  {
    test: /\b(unauthorized|forbidden|invalid api key|authentication failed|http_?401|http_?403)\b/i,
    class: "auth",
    retryable: false,
    human: "上游供给认证失败，请联系维护方",
  },
  {
    test: /\b(aborted|cancel(?:led|ed) by user|interrupted by user)\b/i,
    class: "aborted",
    retryable: false,
    human: "已按你的要求中止本轮",
  },
]

/** 統一錯誤分類入口：命中規則表 → {class, retryable, human}；未命中 → unknown/不重試/空人話。 */
export function classifyUpstreamError(message: string): ClassifiedError {
  if (!message) return { class: "unknown", retryable: false, human: "" }
  for (const r of RULES) {
    if (r.test.test(message)) return { class: r.class, retryable: r.retryable, human: r.human }
  }
  return { class: "unknown", retryable: false, human: "" }
}
