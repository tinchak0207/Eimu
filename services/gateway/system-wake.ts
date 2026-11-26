// H14 补完：系统唤醒文本判定（叶模组，避免 sessions-http/session-read 与事件处理器循环 import；
// 唯一依赖 humanize-gw → error-classify 皆为叶）。
import { basenameServerPathsInText } from "./humanize-gw.ts"
// 2026-10-25：进度回报 / 回报队列也会以 user 角色进 opencode。只认「完成|失败」会让它们
// 在用户从 idle 回来时画成用户气泡，并在上下文里按用户发言反复保留。
const WAKE_HEAD_RE = /^\s*【子代理(?:完成|失败|进度回报|报告阻塞|提问)·系[统統]自动唤醒】/
const QUEUE_HEAD_RE = /^\s*【子代理回报队列·系[统統]事实】/
const TERMINAL_WAKE_RE = /【子代理(?:完成|失败)·系[统統]自动唤醒】/

export function isSystemWakeText(text: unknown): boolean {
  return typeof text === "string" && (WAKE_HEAD_RE.test(text) || QUEUE_HEAD_RE.test(text))
}

/** 完成/失败宣告在正文中的起点。队列块顶在前面时 > 0；没有宣告时 -1。 */
export function terminalSubagentWakeIndex(text: string): number {
  const m = TERMINAL_WAKE_RE.exec(text)
  return m ? m.index : -1
}

/**
 * 进度、回报队列、阻塞、提问：不是完成宣告。显示通道整条丢掉。
 * 队列块后面若接了完成/失败，不算隐藏——调用方改从宣告处起显示。
 */
export function isHiddenSubagentBusText(text: unknown): boolean {
  if (!isSystemWakeText(text) || typeof text !== "string") return false
  return terminalSubagentWakeIndex(text) < 0
}

/** 显示通道用：完成/失败被队列块顶在前面时，从宣告处起保留。 */
export function clientVisibleWakeText(text: string): string {
  const i = terminalSubagentWakeIndex(text)
  // 2026-10-31：artifact_path 等服务端绝对路径只留文件名（与工具参数同一 helper）。
  return basenameServerPathsInText(i > 0 ? text.slice(i) : text)
}

/** 耐久收件箱 / 网关机制注入 / 插件投递的通知：入库可能是 user，但实时从不上屏，历史同样不回传。
 *  后四种与 opencode-runtime/plugin/eimu-guard.ts SYSTEM_INJECTED_USER_TEXT_RE 同源（插件在另一部署树，
 *  无法 import；改那边须同步这里）：后台命令完成通知、Monitor 结果、目标验收提醒、目标卡。 */
const INTERNAL_MECHANISM_RE = /^\s*(?:【(?:生成结果耐久收件箱|系统注入|技能索引|目标验收)|后台命令已结束|\[Monitor Result\]|<eimu-goal-card>)/

/**
 * compaction 摘要讯息（实时与历史共用判据）：实时由 opencode-event-handler 把这类讯息标成
 * "compaction" 角色、text/reasoning 都不上屏；历史端点据同一判据整条丢弃。
 * 注意 user 讯息的 info.summary 是对象（{diffs}），只认 assistant 的 summary===true。
 */
export function isCompactionSummaryInfo(info: unknown): boolean {
  if (!info || typeof info !== "object") return false
  const i = info as { role?: unknown; summary?: unknown; mode?: unknown; agent?: unknown }
  return i.role === "assistant" && (i.summary === true || i.mode === "compaction" || i.agent === "compaction")
}
/** compaction 触发 part（所属讯息整条按 compaction 处理）。 */
export const COMPACTION_PART_TYPE = "compaction"
export function isInternalMechanismText(text: unknown): boolean {
  return typeof text === "string" && INTERNAL_MECHANISM_RE.test(text)
}

/** opencode / 上游把 AGENTS 等塞进 <system-reminder>；读路径一律剥掉。 */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi
export function stripSystemReminders(text: string): string {
  const next = text.replace(SYSTEM_REMINDER_RE, "")
  return next === text ? text : next.replace(/\n{3,}/g, "\n\n").trim()
}
