// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：供應商/上游錯誤人話化（S5a banner 起，summarizeArgs 止），原 index.ts 1132–1250 行。
// 0920 收口：SUPPLIER_ERROR_HUMANIZERS 表已整體併入 error-classify.ts 的單一
// 有序表 ERROR_RULES（與 workflow-service 的可重試判定同源，順序即優先序、
// 文案逐字未動）。本檔只留人話出口函數與 code 分流，查表一律走 error-classify。
import { humanForError } from "./error-classify.ts"

/** 英文供應商錯誤 → 中文短句；未命中回空串。（查 ERROR_RULES 單表） */
export function humanizeSupplierError(message: string): string {
  return humanForError(message)
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

