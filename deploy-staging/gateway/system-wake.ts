// H14 补完：系统唤醒文本判定（叶模组，无依赖，避免 sessions-http/session-read 与事件处理器循环 import）。
const SYSTEM_WAKE_RE = /^\s*【子代理(?:完成|失败|失败)·系[统统]自动唤醒】/
export function isSystemWakeText(text: unknown): boolean {
  return typeof text === "string" && SYSTEM_WAKE_RE.test(text)
}

/** 耐久收件箱 / 网关机制注入等：入库可能是 user，但绝不进客户端历史气泡。 */
const INTERNAL_MECHANISM_RE = /^\s*【(?:生成结果耐久收件箱|系统注入|技能索引)/
export function isInternalMechanismText(text: unknown): boolean {
  return typeof text === "string" && INTERNAL_MECHANISM_RE.test(text)
}

/** opencode / 上游把 AGENTS 等塞进 <system-reminder>；读路径一律剥掉。 */
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/gi
export function stripSystemReminders(text: string): string {
  const next = text.replace(SYSTEM_REMINDER_RE, "")
  return next === text ? text : next.replace(/\n{3,}/g, "\n\n").trim()
}
