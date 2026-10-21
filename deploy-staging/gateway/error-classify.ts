// F3（2026-08-31）：统一错误信封。0920 收口：全 gateway 唯一一张有序错误规则表
// ERROR_RULES，同时承载两个判定——
//   1. 可重试（原 workflow-service.ts RETRYABLE_NODE_ERROR 单条正则，只判 retryable）
//   2. 人话翻译（原 index.ts SUPPLIER_ERROR_HUMANIZERS，0919 已抽到 humanize-gw.ts）
// 两表各自维护曾导致真实漏洞（429/限流不重试、人话与重试判定打架）。现在单表
// 单次扫描同时产出 retryable + human，规则顺序即优先序，加规则只改这里。
//
// 顺序语义（0920 冻结，逐讯息与改前两表行为等价）：
//   - 人话命中顺序 = 原 SUPPLIER_ERROR_HUMANIZERS 逐条顺序（通用 timeout 在
//     poll 条目之前——"poll timeout" 现场实际命中通用条目，本表照抄现场，
//     不照抄注释里的理想顺序）。
//   - retryable 逐条对齐原 RETRYABLE_NODE_ERROR 正则在「命中该条的讯息」上的
//     实际输出。原正则是单条无顺序的，部分人话条目内部混合了可重试与不可重试
//     的讯息形态（如 http_502 可重试、"Bad Gateway" 文字形态不可），故少数条目
//     按「紧邻形态（正则会命中）/视窗形态（不会命中）」拆成两条，人话逐字相同。
//   - 表尾保留原 RETRYABLE_NODE_ERROR 正则逐字作兜底条目（无人话）：命中前 27
//     条但含关键字的讯息（如 "submit 503"、中文「超时」）保持改前 (true, "")。
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
  /** 人话文案；缺省 = 只参与可重试判定（兜底关键字条目），人话出口回空串。 */
  human?: string
  class: ErrorClass
}

export const ERROR_RULES: ErrorRule[] = [
  {
    // 2026-08-31：shuai（Cloudflare 前置）间歇性下发不完整证书链。
    name: "tls-cert-chain",
    pattern: /unable to verify (?:the )?(?:first )?certificate|self signed certificate|socket connection was closed|unable to verify leaf signature|ERR_TLS/i,
    class: "network",
    // 改前现场：纯证书错不含 RETRYABLE 关键字 → 节点级不重试（failover 换渠道才是修径）。
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
    // 2026-09-21 e2e 实锤：视频生成被上游合规过滤器 451 legal_error 永久拒绝
    // （prompt 内容审查不通过或账号/地区无视频权益）。永久拒绝不可重试。
    name: "upstream-compliance-rejection",
    pattern: /compliance filter|legal_error|lacks (?:video )?entitlement/i,
    class: "content",
    retryable: false,
    human: "上游内容安全审查拒绝了这次生成（451），这是永久拒绝：同一提示词重试大概率同样被拒。建议调整提示词中可能触发审查的表述后重新生成，或更换其他模型。",
  },
  {
    name: "no-supplier-capability",
    pattern: /no enabled supplier capability matches/i,
    class: "unknown",
    retryable: false,
    human: "该模型当前没有可用上游供给（可能不支持此尺寸或比例），请更换模型或调整尺寸后重试",
  },
  {
    // 通用 timeout：人话表里排在 poll 条目之前（照现场顺序），凡含 \btimeout\b
    // 或 "timed out" 的讯息人话都是这条；两种形态原 RETRYABLE 均命中 → 可重试。
    name: "timeout-legacy",
    pattern: /\b(?:timeout|timed out)\b/i,
    class: "timeout",
    retryable: true,
    human: "上游响应超时，请稍后重试",
  },
  {
    // timeout 变体（"time-out"/"time out"/"timed-out"）：原 RETRYABLE 只认
    // "timeout|timed out" 字面，变体不可重试；人话与上一条逐字相同。
    name: "timeout-variants",
    pattern: /\b(?:time[ -]?out|timed[ -]?out)\b/i,
    class: "timeout",
    retryable: false,
    human: "上游响应超时，请稍后重试",
  },
  {
    // poll+5xx 紧邻形态（"poll 502"）：原 RETRYABLE "poll 5\d\d" 命中 → 可重试。
    name: "poll-502-adjacent",
    pattern: /poll 502\b/i,
    class: "network",
    retryable: true,
    human: "上游画图服务超时（poll 502），节点可在画布上重试",
  },
  {
    // poll+502 视窗形态（"poll failed: 502"，poll 与 502 不紧邻）：原 RETRYABLE
    // 不命中 → 不可重试；人话与上一条逐字相同。
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
    // 到得了这条的讯息必含 time[ -]?out/timed[ -]?out 形态；实务上通用 timeout
    // 条目（更靠前）已拦走，本条仅为顺序完整性保留（照抄原 humanizer 条目）。
    name: "poll-timeout",
    pattern: /\bpoll\b[^\n]{0,40}(time[ -]?out|timed[ -]?out)|(time[ -]?out|timed[ -]?out)[^\n]{0,40}\bpoll\b/i,
    class: "timeout",
    retryable: true,
    human: "上游画图服务超时（poll 超时），节点可在画布上重试",
  },
  {
    // 0913 诚实归因：附件本地路径被 fetch 拒（"fetch() URL is invalid"）是参数
    // 问题而非上游故障，重试无效。
    name: "url-invalid",
    pattern: /url is invalid|failed to parse url/i,
    class: "unknown",
    retryable: false,
    human: "图片地址无效（既不是可抓取的 URL，也不是可读的本地文件），属参数问题而非上游故障，重试无效：请传 http(s)/data URL、本地绝对路径或 media: 图片 ID。",
  },
  {
    // http_502 机器形态：原 RETRYABLE "http_5\d\d" 命中 → 可重试。
    name: "http-502-exact",
    pattern: /\bhttp_502\b/i,
    class: "network",
    retryable: true,
    human: "上游网关错误（502 Bad Gateway），请稍后重试",
  },
  {
    // "Bad Gateway" 文字形态：原 RETRYABLE 不认（只认 http_5\d\d）→ 不可重试。
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
    // "gateway timeout"（无连字号）含 \btimeout\b → 原 RETRYABLE 命中 → 可重试。
    name: "gateway-timeout-plain",
    pattern: /\bgateway timeout\b/i,
    class: "network",
    retryable: true,
    human: "上游网关超时（504），请稍后重试",
  },
  {
    // "gateway time-out"/"time out" 变体与 "HTTP 504" 裸码：原 RETRYABLE 不命中
    // → 不可重试（实测 "504 Gateway Time-out" 改前即 non-retryable）。
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
    // "socket hang-up"（连字号变体）：原 RETRYABLE 只认 "socket hang up" 空格形。
    name: "socket-hang-up-variant",
    pattern: /\bsocket hang[ -]?up\b/i,
    class: "network",
    retryable: false,
    human: "上游连接中断（网络错误），请稍后重试",
  },
  {
    // 429/限流/过载：原 RETRYABLE_NODE_ERROR 完全没覆盖（error-classify 旧注释
    // 称已修，但那张表无人引用）——改前现场这类节点级「不可重试」，靠 failover
    // 换渠道。行为等价优先，照抄现场 false；要放开需暴君点头另案。
    name: "rate-limit",
    pattern: /\b(overload|overloaded|capacity[_ -]?saturated|rate[ -]?limit|too many requests|http_?429|429)\b/i,
    class: "rate_limit",
    retryable: false,
    human: "上游过载或限流，请稍后重试",
  },
  {
    // 0919 诚实归因（video-director 试产事故）：shuai(new-api) 预扣费闸方言。
    // 话术 0919 暴君钉死，一字不动。欠费重试也不会好，换渠道（F2）才有意义。
    // 注意：正则逐字照抄原 humanize-gw 条目——\b 包中文条目在 JS 里要求紧邻
    // ASCII 词字符才命中（"预扣费额度失败" 开头的讯息实测不命中），这是原表
    // 既有可能性，合并不改行为；要修另案。
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
    // "aborted"：原 RETRYABLE 明确包含 aborted → 节点级可重试（R8-C/0920：人话
    // 中性「本轮已中止」、UI 不发卡，与节点重试判定是两回事，照现场 true）。
    name: "aborted-core",
    pattern: /\baborted\b/i,
    class: "aborted",
    retryable: true,
    human: "本轮已中止",
  },
  {
    // "cancelled by user"/"interrupted by user" 形态：原 RETRYABLE 只认 aborted
    // 字面 → 不可重试；人话与上一条逐字相同（0920 中性，不归因用户）。
    name: "aborted-variants",
    pattern: /\bcancel(?:led|ed) by user\b|\binterrupted by user\b/i,
    class: "aborted",
    retryable: false,
    human: "本轮已中止",
  },
  {
    // 修复3b（2026-09-19）：确定性死模型（渠道清单里没有该模型）不是瞬态故障，
    // 与 failover 零退避（DEAD_MODEL_ERROR_RE）配套。
    name: "dead-model",
    pattern: /no channel candidates remain|model not found/i,
    class: "unknown",
    retryable: false,
    human: "上游渠道暂无此模型，正在自动切换线路重试",
  },
  {
    // 兜底（无人话）：原 RETRYABLE_NODE_ERROR 正则逐字。命中前 27 条之外的讯息
    // 若含这些关键字（"submit 503"、"poll 505"、中文「超时」、"econnaborted"、
    // 非边界 "timeout" 等），改前 (true, "")，合并后必须相同。
    name: "legacy-retryable-keywords",
    pattern: /timeout|timed out|超时|poll 5\d\d|submit 5\d\d|fetch failed|network|econn|socket hang up|aborted|http_5\d\d/i,
    class: "unknown",
    retryable: true,
  },
]

// ── 2026-10-04 T2：错误人话家族繁体镜像（2026-10-04 W 拆除）─────────────────
// Hack-H2 §2.3 曾按 ERROR_RULES 的 name 建一张繁体并列表，由 humanForError 按书写体选表。
// 本站只做简体：该镜像表已整体删除，用户可见文案一律取 ERROR_RULES 的 human 栏（简体）。

/** 统一错误分类入口：命中规则表 → {class, retryable, human}；未命中 → unknown/不重试/空人话。 */
export function classifyUpstreamError(message: string): ClassifiedError {
  if (!message) return { class: "unknown", retryable: false, human: "" }
  for (const r of ERROR_RULES) {
    if (r.pattern.test(message)) return { class: r.class, retryable: r.retryable, human: r.human ?? "" }
  }
  return { class: "unknown", retryable: false, human: "" }
}

/**
 * 节点级可重试判定（原 workflow-service.ts RETRYABLE_NODE_ERROR 的单表等价物）：
 * 首条命中规则的 retryable 即结果；未命中任何规则 → false（与原正则未命中一致）。
 */
export function isRetryableNodeError(message: string | null | undefined): boolean {
  if (!message) return false
  for (const r of ERROR_RULES) {
    if (r.pattern.test(message)) return r.retryable
  }
  return false
}

/** 人话查表（原 humanize-gw humanizeSupplierError 的单表等价物）：首条命中规则
 *  的人话即结果；无人话条目（兜底关键字）或未命中 → 空串。
 *  2026-10-04 W：ERROR_RULES 的 human 栏即唯一简体文案，书写体镜像已拆除。 */
export function humanForError(message: string): string {
  if (!message) return ""
  for (const r of ERROR_RULES) {
    if (r.pattern.test(message)) return r.human ?? ""
  }
  return ""
}

// ── 「错误讯息即模型上下文」（2026-10-02 能力片）────────────────────────────────
// 设计取自 Claude Code 的三个概念（**未复制其程式码**，仅取形态后我方式重写）：
//   ① max_output/串流中断后注入隐藏续写讯息（直接续写、勿道歉、勿复述、拆小步骤）；
//   ② 换模型（fallback）时替未收到结果的孤儿 tool_use 补 is_error 语义的补注，
//      让接手模型知道这些调用没跑完、需重做。
// 我方落地通道＝既有 prompt_async 文本 part（opencode 存成 user-role message）：
// 模型可见；使用者不可见——message.part.updated / message.part.delta 的
// isAssistantMessage 闸（opencode-event-handler.ts）不放行 user-role 文本。
// 本模组只产出纯字串，不发任何帧、不碰网路。

/** 续写指示（串流中断／重投）。模型可见、使用者不可见。 */
export const CONTINUATION_DIRECTIVE_MARK = "【系统续写指示】"
export function buildContinuationDirective(): string {
  return (
    `${CONTINUATION_DIRECTIVE_MARK}上一轮回复因上游模型错误在流式传输中断（非你的错误）。` +
    `请从中断处直接续写完成任务：不要道歉、不要复述已完成的内容、不要重新开始；` +
    `若剩余工作较多，请把它拆成更小的步骤继续，不要重复已完成的步骤或工具调用。`
  )
}

export interface OrphanToolUse {
  id?: string
  name?: string
}

/** 换模型时孤儿 tool_use 的补偿：对每个未收到结果的工具调用，注入 is_error 语义的补注。 */
export const ORPHAN_TOOL_USE_MARK = "【工具结果缺失·系统补注】"
export function buildOrphanToolUseDirective(tools: OrphanToolUse[]): string {
  const list = (tools ?? []).filter((t) => t && (t.name || t.id))
  if (list.length === 0) return ""
  const lines = list.map((t) => `- ${t.name || "未知工具"}${t.id ? `（调用 ${t.id}）` : ""}`)
  return (
    `${ORPHAN_TOOL_USE_MARK}以下工具调用因上游中断/换模型而未产生任何结果` +
    `（语义等同 is_error=true，请勿假定它们成功）：\n${lines.join("\n")}\n` +
    `如需其结果，请在续写时重新调用；不要凭记忆臆造它们的结果。`
  )
}

/**
 * failover 重投的模型可见注入文本：续写指示 ＋（若有孤儿工具）补注。
 * hadOutput=false（零产出重投）时不注入续写指示——没有「中断处」可续，重投原任务书即可。
 */
export function buildFailoverInjection(opts: { hadOutput: boolean; orphanTools?: OrphanToolUse[] }): string {
  const parts: string[] = []
  if (opts.hadOutput) parts.push(buildContinuationDirective())
  const orphan = buildOrphanToolUseDirective(opts.orphanTools ?? [])
  if (orphan) parts.push(orphan)
  return parts.join("\n\n")
}
