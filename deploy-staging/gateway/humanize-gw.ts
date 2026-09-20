// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：供應商/上游錯誤人話化（S5a banner 起，summarizeArgs 止），原 index.ts 1132–1250 行。本段零外部依賴。
// ─── S5a（2026-08-27）：供應商/上游錯誤人話化 ───
// 原文欄位（message 等）一律保留不刪；映射命中時在出站載荷加 human_message
// 中文短句。映射表按序匹配，第一條命中為準。
export const SUPPLIER_ERROR_HUMANIZERS: Array<{ test: RegExp; human: string }> = [
  {
    // 2026-08-31：shuai（Cloudflare 前置）间歇性下发不完整证书链，Bun 报
    // "unable to verify the first certificate"；此类 TLS/连接抖动 failover 会
    // 自动换渠道重试，话术陈述已存在的自动行为。
    test: /unable to verify (?:the )?(?:first )?certificate|self signed certificate|socket connection was closed|unable to verify leaf signature|ERR_TLS/i,
    human: "上游模型服务的网络连接不稳定（证书校验/连接中断），系统已自动换渠道重试，无需你做任何操作。",
  },
  {
    test: /task\s*(?:was\s*)?not\s*found/i,
    human: "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。",
  },
  {
    // R4 實錘（15:08:51）：14 萬字整段入上下文 → APIError "Input token exceed
    // the limit"，session.error 原文直出零中文。compaction 在 idle 自動觸發
    //（maybeCompactSession），此話術只陳述已存在的自動行為，不編造承諾。
    test: /input tokens? exceed/i,
    human: "输入内容太长，超出了模型单次可读的上限。我会在本轮结束后自动压缩上下文再继续；若反复出现，建议让我分章/分段处理。",
  },
  {
    test: /no enabled supplier capability matches/i,
    human: "该模型当前没有可用上游供给（可能不支持此尺寸或比例），请更换模型或调整尺寸后重试",
  },
  { test: /\b(time[ -]?out|timed[ -]?out|timeout)\b/i, human: "上游响应超时，请稍后重试" },
  // R5-C（2026-08-28）：真實上游原因條目。poll 類失敗（輪詢超時/502 網關）
  // 此前落入通用 timeout 或「执行失败，请重试或换一种方式」空話——用戶看不到
  // 真實原因。poll 條目必須排在通用 timeout 條目之前（"poll timeout" 含
  // timeout 詞會被通用條目搶先匹配）。
  {
    test: /\bpoll\b[^\n]{0,40}\b502\b|\b502\b[^\n]{0,40}\bpoll\b/i,
    human: "上游画图服务超时（poll 502），节点可在画布上重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}\b50[34]\b|\b50[34]\b[^\n]{0,40}\bpoll\b/i,
    human: "上游画图服务异常（poll 503/504），节点可在画布上重试",
  },
  {
    test: /\bpoll\b[^\n]{0,40}(time[ -]?out|timed[ -]?out)|(time[ -]?out|timed[ -]?out)[^\n]{0,40}\bpoll\b/i,
    human: "上游画图服务超时（poll 超时），节点可在画布上重试",
  },
  {
    // 0913 誠實歸因：附件本地路徑被 fetch 拒（“fetch() URL is invalid”）曾被兜底
    // 包成「上游原因：…請重試」，參數錯誤誤標上游故障、誘發模型盲目重試連環燒 turn。
    test: /url is invalid|failed to parse url/i,
    human: "图片地址无效（既不是可抓取的 URL，也不是可读的本地文件），属参数问题而非上游故障，重试无效：请传 http(s)/data URL、本地绝对路径或 media: 图片 ID。",
  },
  { test: /\bbad[ -]?gateway\b|\bhttp_?502\b/i, human: "上游网关错误（502 Bad Gateway），请稍后重试" },
  { test: /\bservice[ -]?unavailable\b|\bhttp_?503\b/i, human: "上游服务暂不可用（503），请稍后重试" },
  { test: /\bgateway[ -]?timeout\b|\bhttp_?504\b/i, human: "上游网关超时（504），请稍后重试" },
  { test: /\b(fetch failed|econnreset|econnrefused|socket hang[ -]?up|network error)\b/i, human: "上游连接中断（网络错误），请稍后重试" },
  {
    test: /\b(overload|overloaded|capacity[_ -]?saturated|rate[ -]?limit|too many requests|http_?429|429)\b/i,
    human: "上游过载或限流，请稍后重试",
  },
  // 0919 誠實歸因（video-director 試產事故）：shuai(new-api) 預扣費閘的方言是
  // 「预扣费额度失败, 用户剩余额度: ¥X, 需要预扣费额度: ¥Y」——不含「余额不足/
  // 欠费」字面，舊詞表不命中 → session.error 無 human_message、原文直出，底模在
  // model-not-found 噪音裡把欠費誤讀成「模型不可用」。補方言 + 話術釘死因果：
  // 未提交、未扣費、無產物，充值前重試無效。
  {
    test: /\b(insufficient[ _-]?(account[ _-]?)?(balance|credit)|quota exceeded|余额不足|欠费|预扣费额度失败|额度不足)\b/i,
    human: "上游渠道账户余额不足（欠费）：本次调用未提交、未扣费、无产物。这不是模型不可用——充值前重试不会成功，请联系维护方",
  },
  { test: /\b(unauthorized|forbidden|invalid api key|authentication failed|http_?401|http_?403)\b/i, human: "上游供给认证失败，请联系维护方" },
  // R8-C（2026-08-29）：用戶主動中止（opencode 回 "Tool execution aborted" /
  // "Aborted"）不是失敗，此前漏映射 → 原樣包成「执行失败（上游原因：…）」英文
  // 黑話甩給用戶。0920 改中性話術：events-translate 的 abort 分支已攔截不發卡，
  // 此條僅作殘餘防線（其他呼叫方如 toolErrorPayload/媒體路由）——絕不歸因於
  // 用戶（系統自殺輪也曾命中此條彈「已按你的要求中止」＝栽贓）。
  { test: /\b(aborted|cancel(?:led|ed) by user|interrupted by user)\b/i, human: "本轮已中止" },
  // 修復3b（2026-09-19）：確定性死模型（渠道清單裡沒有該模型）不是瞬態故障——
  // new-api 的巨長 trace 原文直出瀏覽器刷屏（事故實錘）。人話化為切線提示，
  // 與 failover 零退避（DEAD_MODEL_ERROR_RE）配套。
  { test: /no channel candidates remain|model not found/i, human: "上游渠道暂无此模型，正在自动切换线路重试" },
]

/** 英文供應商錯誤 → 中文短句；未命中回空串。 */
export function humanizeSupplierError(message: string): string {
  if (!message) return ""
  for (const h of SUPPLIER_ERROR_HUMANIZERS) if (h.test.test(message)) return h.human
  return ""
}

/** 必得中文短句：映射命中 → 映射文；本身就是中文 → 原文；否則帶真實上游
 *  原因原文（截斷）——R5-C：兜底禁止只剩「执行失败，请重试或换一种方式」空話。 */
export function humanMessageFor(message: string, code?: string): string {
  // 0831 誠實歸因：本站自己的 404 曾被兜底包成「上游原因」，誤導用戶與模型連環重試。
  if (code === "task_not_found") {
    return "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。"
  }
  if (code === "result_not_ready") {
    return "任务仍在生成中，harness 会自动续接，无需重复查询。"
  }
  // 已是中文人話（工具/站點自己寫的 hint）不再套「上游原因」外殼。
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const mapped = humanizeSupplierError(message)
  if (mapped) return mapped
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const brief = message.length > 160 ? message.slice(0, 160) + "…" : message
  return `执行失败（上游原因：${brief}）。请重试或换一种方式`
}

export function summarizeArgs(args?: unknown): string {
  if (!args) return ""
  if (typeof args !== "object") {
    const t = String(args)
    return t.length > 500 ? t.slice(0, 500) + "…" : t
  }
  if (Object.keys(args as Record<string, unknown>).length === 0) return ""
  let s: string
  try {
    s = JSON.stringify(args)
  } catch {
    s = String(args)
  }
  return s.length > 500 ? s.slice(0, 500) + "…" : s
}

