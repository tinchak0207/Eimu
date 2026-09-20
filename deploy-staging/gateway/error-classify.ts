// F3（2026-08-31）：統一錯誤信封。0920 收口：全 gateway 唯一一張有序錯誤規則表
// ERROR_RULES，同時承載兩個判定——
//   1. 可重試（原 workflow-service.ts RETRYABLE_NODE_ERROR 單條正則，只判 retryable）
//   2. 人話翻譯（原 index.ts SUPPLIER_ERROR_HUMANIZERS，0919 已抽到 humanize-gw.ts）
// 兩表各自維護曾導致真實漏洞（429/限流不重試、人話與重試判定打架）。現在單表
// 單次掃描同時產出 retryable + human，規則順序即優先序，加規則只改這裡。
//
// 順序語義（0920 凍結，逐訊息與改前兩表行為等價）：
//   - 人話命中順序 = 原 SUPPLIER_ERROR_HUMANIZERS 逐條順序（通用 timeout 在
//     poll 條目之前——"poll timeout" 現場實際命中通用條目，本表照抄現場，
//     不照抄註釋裡的理想順序）。
//   - retryable 逐條對齊原 RETRYABLE_NODE_ERROR 正則在「命中該條的訊息」上的
//     實際輸出。原正則是單條無順序的，部分人話條目內部混合了可重試與不可重試
//     的訊息形態（如 http_502 可重試、"Bad Gateway" 文字形態不可），故少數條目
//     按「緊鄰形態（正則會命中）/視窗形態（不會命中）」拆成兩條，人話逐字相同。
//   - 表尾保留原 RETRYABLE_NODE_ERROR 正則逐字作兜底條目（無人話）：命中前 27
//     條但含關鍵字的訊息（如 "submit 503"、中文「超时」）保持改前 (true, "")。
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

export interface ErrorRule {
  name: string
  pattern: RegExp
  retryable: boolean
  /** 人話文案；缺省 = 只參與可重試判定（兜底關鍵字條目），人話出口回空串。 */
  human?: string
  class: ErrorClass
}

export const ERROR_RULES: ErrorRule[] = [
  {
    // 2026-08-31：shuai（Cloudflare 前置）间歇性下发不完整证书链。
    name: "tls-cert-chain",
    pattern: /unable to verify (?:the )?(?:first )?certificate|self signed certificate|socket connection was closed|unable to verify leaf signature|ERR_TLS/i,
    class: "network",
    // 改前現場：純證書錯不含 RETRYABLE 關鍵字 → 節點級不重試（failover 換渠道才是修徑）。
    retryable: false,
    human: "上游模型服务的网络连接不稳定（证书校验/连接中断），系统已自动换渠道重试，无需你做任何操作。",
  },
  {
    name: "task-not-found",
    pattern: /task\s*(?:was\s*)?not\s*found/i,
    class: "not_found",
    retryable: false,
    human: "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。",
  },
  {
    name: "input-too-long",
    pattern: /input tokens? exceed/i,
    class: "input_too_long",
    retryable: false,
    human: "输入内容太长，超出了模型单次可读的上限。我会在本轮结束后自动压缩上下文再继续；若反复出现，建议让我分章/分段处理。",
  },
  {
    name: "no-supplier-capability",
    pattern: /no enabled supplier capability matches/i,
    class: "unknown",
    retryable: false,
    human: "该模型当前没有可用上游供给（可能不支持此尺寸或比例），请更换模型或调整尺寸后重试",
  },
  {
    // 通用 timeout：人話表裡排在 poll 條目之前（照現場順序），凡含 \btimeout\b
    // 或 "timed out" 的訊息人話都是這條；兩種形態原 RETRYABLE 均命中 → 可重試。
    name: "timeout-legacy",
    pattern: /\b(?:timeout|timed out)\b/i,
    class: "timeout",
    retryable: true,
    human: "上游响应超时，请稍后重试",
  },
  {
    // timeout 變體（"time-out"/"time out"/"timed-out"）：原 RETRYABLE 只認
    // "timeout|timed out" 字面，變體不可重試；人話與上一條逐字相同。
    name: "timeout-variants",
    pattern: /\b(?:time[ -]?out|timed[ -]?out)\b/i,
    class: "timeout",
    retryable: false,
    human: "上游响应超时，请稍后重试",
  },
  {
    // poll+5xx 緊鄰形態（"poll 502"）：原 RETRYABLE "poll 5\d\d" 命中 → 可重試。
    name: "poll-502-adjacent",
    pattern: /poll 502\b/i,
    class: "network",
    retryable: true,
    human: "上游画图服务超时（poll 502），节点可在画布上重试",
  },
  {
    // poll+502 視窗形態（"poll failed: 502"，poll 與 502 不緊鄰）：原 RETRYABLE
    // 不命中 → 不可重試；人話與上一條逐字相同。
    name: "poll-502-window",
    pattern: /\bpoll\b[^\n]{0,40}\b502\b|\b502\b[^\n]{0,40}\bpoll\b/i,
    class: "network",
    retryable: false,
    human: "上游画图服务超时（poll 502），节点可在画布上重试",
  },
  {
    name: "poll-503-504-adjacent",
    pattern: /poll 50[34]\b/i,
    class: "network",
    retryable: true,
    human: "上游画图服务异常（poll 503/504），节点可在画布上重试",
  },
  {
    name: "poll-503-504-window",
    pattern: /\bpoll\b[^\n]{0,40}\b50[34]\b|\b50[34]\b[^\n]{0,40}\bpoll\b/i,
    class: "network",
    retryable: false,
    human: "上游画图服务异常（poll 503/504），节点可在画布上重试",
  },
  {
    // 到得了這條的訊息必含 time[ -]?out/timed[ -]?out 形態；實務上通用 timeout
    // 條目（更靠前）已攔走，本條僅為順序完整性保留（照抄原 humanizer 條目）。
    name: "poll-timeout",
    pattern: /\bpoll\b[^\n]{0,40}(time[ -]?out|timed[ -]?out)|(time[ -]?out|timed[ -]?out)[^\n]{0,40}\bpoll\b/i,
    class: "timeout",
    retryable: true,
    human: "上游画图服务超时（poll 超时），节点可在画布上重试",
  },
  {
    // 0913 誠實歸因：附件本地路徑被 fetch 拒（"fetch() URL is invalid"）是參數
    // 問題而非上游故障，重試無效。
    name: "url-invalid",
    pattern: /url is invalid|failed to parse url/i,
    class: "unknown",
    retryable: false,
    human: "图片地址无效（既不是可抓取的 URL，也不是可读的本地文件），属参数问题而非上游故障，重试无效：请传 http(s)/data URL、本地绝对路径或 media: 图片 ID。",
  },
  {
    // http_502 機器形態：原 RETRYABLE "http_5\d\d" 命中 → 可重試。
    name: "http-502-exact",
    pattern: /\bhttp_502\b/i,
    class: "network",
    retryable: true,
    human: "上游网关错误（502 Bad Gateway），请稍后重试",
  },
  {
    // "Bad Gateway" 文字形態：原 RETRYABLE 不認（只認 http_5\d\d）→ 不可重試。
    name: "bad-gateway-text",
    pattern: /\bbad[ -]?gateway\b|\bhttp_?502\b/i,
    class: "network",
    retryable: false,
    human: "上游网关错误（502 Bad Gateway），请稍后重试",
  },
  {
    name: "http-503-exact",
    pattern: /\bhttp_503\b/i,
    class: "network",
    retryable: true,
    human: "上游服务暂不可用（503），请稍后重试",
  },
  {
    name: "service-unavailable-text",
    pattern: /\bservice[ -]?unavailable\b|\bhttp_?503\b/i,
    class: "network",
    retryable: false,
    human: "上游服务暂不可用（503），请稍后重试",
  },
  {
    name: "http-504-exact",
    pattern: /\bhttp_504\b/i,
    class: "network",
    retryable: true,
    human: "上游网关超时（504），请稍后重试",
  },
  {
    // "gateway timeout"（無連字號）含 \btimeout\b → 原 RETRYABLE 命中 → 可重試。
    name: "gateway-timeout-plain",
    pattern: /\bgateway timeout\b/i,
    class: "network",
    retryable: true,
    human: "上游网关超时（504），请稍后重试",
  },
  {
    // "gateway time-out"/"time out" 變體與 "HTTP 504" 裸碼：原 RETRYABLE 不命中
    // → 不可重試（實測 "504 Gateway Time-out" 改前即 non-retryable）。
    name: "gateway-timeout-variants",
    pattern: /\bgateway[ -]?time[ -]?out\b|\bhttp_?504\b/i,
    class: "network",
    retryable: false,
    human: "上游网关超时（504），请稍后重试",
  },
  {
    name: "conn-reset-core",
    pattern: /\b(?:fetch failed|econnreset|econnrefused|socket hang up|network error)\b/i,
    class: "network",
    retryable: true,
    human: "上游连接中断（网络错误），请稍后重试",
  },
  {
    // "socket hang-up"（連字號變體）：原 RETRYABLE 只認 "socket hang up" 空格形。
    name: "socket-hang-up-variant",
    pattern: /\bsocket hang[ -]?up\b/i,
    class: "network",
    retryable: false,
    human: "上游连接中断（网络错误），请稍后重试",
  },
  {
    // 429/限流/過載：原 RETRYABLE_NODE_ERROR 完全沒覆蓋（error-classify 舊註釋
    // 稱已修，但那張表無人引用）——改前現場這類節點級「不可重試」，靠 failover
    // 換渠道。行為等價優先，照抄現場 false；要放開需暴君點頭另案。
    name: "rate-limit",
    pattern: /\b(overload|overloaded|capacity[_ -]?saturated|rate[ -]?limit|too many requests|http_?429|429)\b/i,
    class: "rate_limit",
    retryable: false,
    human: "上游过载或限流，请稍后重试",
  },
  {
    // 0919 誠實歸因（video-director 試產事故）：shuai(new-api) 預扣費閘方言。
    // 話術 0919 暴君釘死，一字不動。欠費重試也不會好，換渠道（F2）才有意義。
    // 注意：正則逐字照抄原 humanize-gw 條目——\b 包中文條目在 JS 裡要求緊鄰
    // ASCII 詞字符才命中（"预扣费额度失败" 開頭的訊息實測不命中），這是原表
    // 既有可能性，合併不改行為；要修另案。
    name: "quota-exhausted",
    pattern: /\b(insufficient[ _-]?(account[ _-]?)?(balance|credit)|quota exceeded|余额不足|欠费|预扣费额度失败|额度不足)\b/i,
    class: "quota",
    retryable: false,
    human: "上游渠道账户余额不足（欠费）：本次调用未提交、未扣费、无产物。这不是模型不可用——充值前重试不会成功，请联系维护方",
  },
  {
    name: "auth-failed",
    pattern: /\b(unauthorized|forbidden|invalid api key|authentication failed|http_?401|http_?403)\b/i,
    class: "auth",
    retryable: false,
    human: "上游供给认证失败，请联系维护方",
  },
  {
    // "aborted"：原 RETRYABLE 明確包含 aborted → 節點級可重試（R8-C/0920：人話
    // 中性「本轮已中止」、UI 不發卡，與節點重試判定是兩回事，照現場 true）。
    name: "aborted-core",
    pattern: /\baborted\b/i,
    class: "aborted",
    retryable: true,
    human: "本轮已中止",
  },
  {
    // "cancelled by user"/"interrupted by user" 形態：原 RETRYABLE 只認 aborted
    // 字面 → 不可重試；人話與上一條逐字相同（0920 中性，不歸因用戶）。
    name: "aborted-variants",
    pattern: /\bcancel(?:led|ed) by user\b|\binterrupted by user\b/i,
    class: "aborted",
    retryable: false,
    human: "本轮已中止",
  },
  {
    // 修復3b（2026-09-19）：確定性死模型（渠道清單裡沒有該模型）不是瞬態故障，
    // 與 failover 零退避（DEAD_MODEL_ERROR_RE）配套。
    name: "dead-model",
    pattern: /no channel candidates remain|model not found/i,
    class: "unknown",
    retryable: false,
    human: "上游渠道暂无此模型，正在自动切换线路重试",
  },
  {
    // 兜底（無人話）：原 RETRYABLE_NODE_ERROR 正則逐字。命中前 27 條之外的訊息
    // 若含這些關鍵字（"submit 503"、"poll 505"、中文「超时」、"econnaborted"、
    // 非邊界 "timeout" 等），改前 (true, "")，合併後必須相同。
    name: "legacy-retryable-keywords",
    pattern: /timeout|timed out|超时|poll 5\d\d|submit 5\d\d|fetch failed|network|econn|socket hang up|aborted|http_5\d\d/i,
    class: "unknown",
    retryable: true,
  },
]

/** 統一錯誤分類入口：命中規則表 → {class, retryable, human}；未命中 → unknown/不重試/空人話。 */
export function classifyUpstreamError(message: string): ClassifiedError {
  if (!message) return { class: "unknown", retryable: false, human: "" }
  for (const r of ERROR_RULES) {
    if (r.pattern.test(message)) return { class: r.class, retryable: r.retryable, human: r.human ?? "" }
  }
  return { class: "unknown", retryable: false, human: "" }
}

/**
 * 節點級可重試判定（原 workflow-service.ts RETRYABLE_NODE_ERROR 的單表等價物）：
 * 首條命中規則的 retryable 即結果；未命中任何規則 → false（與原正則未命中一致）。
 */
export function isRetryableNodeError(message: string | null | undefined): boolean {
  if (!message) return false
  for (const r of ERROR_RULES) {
    if (r.pattern.test(message)) return r.retryable
  }
  return false
}

/** 人話查表（原 humanize-gw humanizeSupplierError 的單表等價物）：首條命中規則
 *  的人話即結果；無人話條目（兜底關鍵字）或未命中 → 空串。 */
export function humanForError(message: string): string {
  if (!message) return ""
  for (const r of ERROR_RULES) {
    if (r.pattern.test(message)) return r.human ?? ""
  }
  return ""
}
