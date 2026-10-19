// H14 补完：系统唤醒文本判定（叶模组，无依赖，避免 sessions-http/session-read 与事件处理器循环 import）。
const SYSTEM_WAKE_RE = /^\s*【子代理(?:完成|失败|失败)·系[统统]自动唤醒】/
export function isSystemWakeText(text: unknown): boolean {
  return typeof text === "string" && SYSTEM_WAKE_RE.test(text)
}
