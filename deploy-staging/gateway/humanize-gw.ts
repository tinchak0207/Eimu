// 从 index.ts 无损抽取（2026-09-19 第二阶段 Wave1）：供应商/上游错误人话化（S5a banner 起，summarizeArgs 止），原 index.ts 1132–1250 行。
// 0920 收口：SUPPLIER_ERROR_HUMANIZERS 表已整体并入 error-classify.ts 的单一
// 有序表 ERROR_RULES（与 workflow-service 的可重试判定同源，顺序即优先序、
// 文案逐字未动）。本档只留人话出口函数与 code 分流，查表一律走 error-classify。
import { humanForError } from "./error-classify.ts"

/** 英文供应商错误 → 中文短句；未命中回空串。（查 ERROR_RULES 单表，一律简体）
 *  2026-10-04 W：书写体镜像已拆除，用户可见文案不再按输入书写体切换。 */
export function humanizeSupplierError(message: string): string {
  return humanForError(message)
}

/** 必得中文短句：映射命中 → 映射文；本身就是中文 → 原文；否则带真实上游
 *  原因原文（截断）——R5-C：兜底禁止只剩「执行失败，请重试或换一种方式」空话。
 *  2026-10-04 W：原本按书写体出繁体镜像的三处固定文案收成单一简体。 */
export function humanMessageFor(message: string, code?: string): string {
  // 0831 诚实归因：本站自己的 404 曾被兜底包成「上游原因」，误导用户与模型连环重试。
  if (code === "task_not_found") {
    return "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。"
  }
  if (code === "result_not_ready") {
    return "任务仍在生成中，harness 会自动续接，无需重复查询。"
  }
  // 已是中文人话（工具/站点自己写的 hint）不再套「上游原因」外壳。
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const mapped = humanizeSupplierError(message)
  if (mapped) return mapped
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

