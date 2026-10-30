// user-facing-error.ts —— 用户可见失败文案的统一出口（2026-10-30 工程审核防线 2）。
//
// 起因（2026-10-30 BURN IT CLEAN 会话）：「执行失败（上游原因：tool failed）」、空白步骤行、
// image.failed 的 reason 原文进聊天 notice、画布 errorDetails 原文直显……同一类错误从十几个
// emit 点各自拼文案，修一个漏一个。本档是**唯一**把失败原文变成用户可见句的函数：
//   - 空串 / tool failed / failed / session error / [object Object] 这类无信息串
//   - 未映射的上游英文、HTTP 码、堆栈、内部路径、内部端点、fail-closed 等运行时句
//   → 一律映射成「什么没完成：原因。下一步：怎么办」；原文只进服务端日志（脱敏、截断）。
// 已是干净中文人话（工具/站点自己写的提示、ERROR_RULES 的 human 栏）原样通过。
// 接线：sse-core.emitToSession → delivery-gate-scrub.scrubVisibleFrame（全部帧的单一咽喉点）
// 对 session.error / tool.result(ok:false) / image|video|audio.failed / canvas.node.updated(error)
// 调本函数，所以任何 emit 点（含其他工作流正在改的文件）发出的失败帧都会过这里。
// 纯函数 + console.error，零 gateway 模组依赖（只读 error-classify 的单表）。
import { classifyUpstreamError, type ErrorClass } from "./error-classify.ts"

export type UserFacingErrorKind = "session" | "tool" | "image" | "video" | "audio" | "node"

const SUBJECT: Record<UserFacingErrorKind, string> = {
  session: "这一轮",
  tool: "这一步",
  image: "这张图",
  video: "这段视频",
  audio: "这段音频",
  node: "这个节点",
}

const NEXT: Record<UserFacingErrorKind, string> = {
  session: "可以直接重发上一条消息；反复出现请告诉我们大概时间，我们按时间查日志",
  tool: "助手会按原因换个方式继续，需要你操作时会单独说明",
  image: "可以直接重试；扣费与退款以本条卡片上的状态为准",
  video: "可以直接重试；扣费与退款以本条卡片上的状态为准",
  audio: "可以直接重试；扣费与退款以本条卡片上的状态为准",
  node: "可以在画布上重试这个节点",
}

const CLASS_REASON: Partial<Record<ErrorClass, string>> = {
  rate_limit: "上游限流",
  capacity: "上游暂时没有可用供给",
  timeout: "上游响应超时",
  network: "与上游的连接中断",
  auth: "上游认证被拒",
  quota: "上游渠道额度不足",
  content: "内容审核未通过",
  not_found: "要找的任务或资源不存在",
  input_too_long: "输入超出模型上限",
  aborted: "本轮被中止",
}

/** 无信息串：只说明「失败了」，不说明原因。 */
const BARE_RE =
  /^(?:tool[ _]?failed|failed|failure|error|err|session[ _]error|backend[ _]error|internal(?:[ _]server)?[ _]error|unknown(?:[ _]error)?|undefined|null|none|n\/a|\[object object\]|生成失败|执行失败|失败|未知错误|未知原因|tool_failed|task_failed)[.。!！]?$/i

/** 内部/上游痕迹：出现即不让原文进用户视线。 */
const INTERNAL_RE =
  /fail-closed|\bat [\w$.<>]+ \(|\n\s+at |Error:|Exception|Traceback|\b(?:HTTP|status)\s*\d{3}\b|\/(?:opt|home|tmp|var|root|srv|usr)\/|\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?|ECONN\w+|ETIMEDOUT|ENOENT|EACCES|EPERM|sk-[A-Za-z0-9]|Bearer\s|api[_-]?key|stack|undefined|null\b|[{}]|\bses_[A-Za-z0-9]{6,}|tool failed|预扣费|剩余额度|[¥￥]\s*\d/i

/** 空壳句：去掉「失败/请重试/换一种方式」这类套话和标点后什么都不剩（有中文但没说原因）。 */
const HOLLOW_FILLER_RE =
  /执行失败|生成失败|调用失败|处理失败|操作失败|任务失败|失败了|失败|出错了|出错|发生错误|请重试|请稍后(?:再)?(?:重)?试|稍后再试|或换一种方式|换一种方式|抱歉|[（(]\s*(?:tool[ _]?failed|failed|error|unknown)\s*[)）]|[，。、；：,.;:!！?？\s（）()]/gi
function isHollow(t: string): boolean {
  HOLLOW_FILLER_RE.lastIndex = 0
  return t.replace(HOLLOW_FILLER_RE, "").trim() === ""
}
/** 中文句里夹着英文裸失败码（「工作流未能启动（failed）」）＝没给原因。 */
const PAREN_BARE_RE = /[（(]\s*(?:tool[ _]?failed|failed|error|unknown|undefined|null)\s*[)）]/i

/** 旧兜底壳「执行失败（上游原因：X）。请重试或换一种方式」——X 重新过本函数。 */
export const LEGACY_UPSTREAM_SHELL_RE = /执行失败（上游原因：((?:[^（）]|（[^（）]*）)*)）。?(?:请重试或换一种方式)?/g

/** 连续 4 个以上英文词＝上游英文原句（中文句里零星的模型名、参数名不算）。 */
const ENGLISH_RUN_RE = /[A-Za-z][A-Za-z'_-]+(?:[\s,;:().?!]+[A-Za-z][A-Za-z'_-]+){3,}/
/** 内部路径/本地文件 URL：就地换成「本地文件」，句子其余信息保留。 */
const LOCAL_PATH_RE = /(?:file:\/\/)?\/(?:opt|home|tmp|var|root|srv|usr)\/[^\s，。；、）)"'」]*/g
/** 账务状态前缀：确定状态必须留在用户视线里（「已退款：<上游英文>」只换后半句）。 */
const STATUS_PREFIX_RE = /^((?:已退款|未扣费|未扣款|已扣费|已扣款|已返还|退款中|已全额退款)[^：:]{0,12}[：:])\s*/

function redactForLog(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/([?&](?:key|token|sig|signature|access_token|api_key)=)[^&\s]+/gi, "$1***")
    .slice(0, 600)
}

function reasonOf(raw: string): string {
  if (/plan mode|计划模式|权限求值|fail-closed/i.test(raw)) return "运行时的安全检查暂时不可用，写入类操作被保守拦下"
  const cls = classifyUpstreamError(raw).class
  const byClass = CLASS_REASON[cls]
  if (byClass) return byClass
  if (/\b5\d\d\b|unavailable|refused|reset|fetch failed|bad gateway/i.test(raw)) return "服务暂时不可用"
  if (/\b(?:400|422)\b|invalid|validation|schema|required|must be|expected/i.test(raw)) return "参数没有被接受"
  if (/\b40[13]\b|forbidden|unauthori[sz]ed|permission|denied/i.test(raw)) return "权限或登录状态被拒"
  if (/hard stop|waiting_budget|queue wait exceeded|queueMaxWait|without any provider/i.test(raw)) return "排队等候超时，一直没有拿到可用的上游"
  if (/预扣费|剩余额度|balance exhaust|insufficient (?:balance|quota)/i.test(raw)) return "平台的上游渠道额度暂时不足（不是你账户余额的问题）"
  if (/disk is full|no space left|ENOSPC/i.test(raw)) return "服务端存储空间不足"
  if (/\b409\b|conflict/i.test(raw)) return "状态冲突（可能已经在处理中）"
  if (/exceeded \d+ bytes|too large|output limit|too long/i.test(raw)) return "工具输出超过上限"
  if (/unable to connect|connect(?:ion)? (?:refused|reset|closed)|socket hang up/i.test(raw)) return "与上游的连接中断"
  if (/request failed|retry later/i.test(raw)) return "上游请求失败"
  return "服务返回了无法识别的错误（详情已记录）"
}

export interface UserFacingErrorOpts {
  kind: UserFacingErrorKind
  /** 日志定位：帧名、工具名、会话 id 等（不含 secrets）。 */
  where?: string
  /** 测试/回放可关日志。 */
  silent?: boolean
}

/** 判定一段文本是否已是可直接给用户看的人话（有中文、无内部痕迹、不是空话）。 */
export function isPresentableErrorText(text: string): boolean {
  const t = text.trim()
  if (!t || BARE_RE.test(t) || isHollow(t)) return false
  if (!/[\u4e00-\u9fff]/.test(t)) return false
  if (PAREN_BARE_RE.test(t)) return false
  if (ENGLISH_RUN_RE.test(t)) return false
  if (INTERNAL_RE.test(t)) return false
  LEGACY_UPSTREAM_SHELL_RE.lastIndex = 0
  if (LEGACY_UPSTREAM_SHELL_RE.test(t)) return false
  return t.length <= 400
}

/**
 * 唯一出口：失败原文 → { text: 用户可见整句（原因＋下一步）, reason: 短原因（给「生成失败（…）」这类外壳用） }。
 * 原文不回传，只记服务端日志。已是干净中文人话 → 原样返回（不重复加壳）。
 */
export function userFacingErrorParts(raw: unknown, opts: UserFacingErrorOpts): { text: string; reason: string } {
  const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw)
  const out = mapToUserFacing(text, opts.kind)
  if (!opts.silent && out.text !== text) {
    console.error(
      `[gateway] user-facing-error kind=${opts.kind}${opts.where ? ` where=${opts.where}` : ""} raw=${JSON.stringify(redactForLog(text))} → ${JSON.stringify(out.text)}`,
    )
  }
  return out
}

function mapToUserFacing(text: string, kind: UserFacingErrorKind): { text: string; reason: string } {
  if (isPresentableErrorText(text)) return { text, reason: text }
  // 账务确定状态前缀保留，只改写后半句。
  const pm = STATUS_PREFIX_RE.exec(text)
  if (pm && text.length > pm[0].length) {
    const rest = mapToUserFacing(text.slice(pm[0].length), kind)
    return { text: `${pm[1]}${rest.text}`, reason: `${pm[1]}${rest.reason}` }
  }
  // 本地路径就地脱敏，剩下的若已是人话就保留（「第 1 张参考图（本地文件）入库后未拿到公网 URL…」）。
  LOCAL_PATH_RE.lastIndex = 0
  if (LOCAL_PATH_RE.test(text)) {
    LOCAL_PATH_RE.lastIndex = 0
    const redacted = text.replace(LOCAL_PATH_RE, "本地文件")
    if (isPresentableErrorText(redacted)) return { text: redacted, reason: redacted }
  }
  // 「<上游英文>: <站点中文原因与方案>」→ 取中文段。
  const cjk = text.search(/[\u4e00-\u9fff]/)
  if (cjk > 0 && ENGLISH_RUN_RE.test(text.slice(0, cjk))) {
    const zh = text.slice(cjk).replace(/\s*\b(?:request[_ ]?id|trace[_ ]?id|task[_ ]?id)\b[\s\S]*$/i, "").trim()
    if (isPresentableErrorText(zh)) return { text: zh, reason: zh }
  }
  // 上游英文命中错误规则表 → 用表里的人话（已带下一步）。
  LEGACY_UPSTREAM_SHELL_RE.lastIndex = 0
  const inner = text.replace(LEGACY_UPSTREAM_SHELL_RE, "$1").trim()
  // 运行时自身的安全检查（plan mode / fail-closed）不是上游问题，不能借上游规则表说成「上游超时」。
  const runtimeGate = /plan mode|计划模式|权限求值|fail-closed/i.test(inner)
  const mapped = inner && !runtimeGate ? classifyUpstreamError(inner).human : ""
  let out: { text: string; reason: string }
  if (mapped && isPresentableErrorText(mapped)) {
    out = { text: mapped, reason: mapped.replace(/[。.]$/, "") }
  } else {
    const reason = !inner || BARE_RE.test(inner) || isHollow(inner) || PAREN_BARE_RE.test(inner) ? "没有拿到具体原因（已记录，我们会按时间排查）" : reasonOf(inner)
    out = { text: `${SUBJECT[kind]}没有完成：${reason}。下一步：${NEXT[kind]}。`, reason }
  }
  return out
}

export function userFacingError(raw: unknown, opts: UserFacingErrorOpts): string {
  return userFacingErrorParts(raw, opts).text
}
