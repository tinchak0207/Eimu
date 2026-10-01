// H14 補完：系統喚醒文本判定（葉模組，無依賴，避免 sessions-http/session-read 與事件處理器循環 import）。
const SYSTEM_WAKE_RE = /^\s*【子代理(?:完成|失败|失敗)·系[统統]自动唤醒】/
export function isSystemWakeText(text: unknown): boolean {
  return typeof text === "string" && SYSTEM_WAKE_RE.test(text)
}
