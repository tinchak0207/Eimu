// 從 index.ts 無損抽取（2026-09-19 第二階段 Wave1）：供應商/上游錯誤人話化（S5a banner 起，summarizeArgs 止），原 index.ts 1132–1250 行。
// 0920 收口：SUPPLIER_ERROR_HUMANIZERS 表已整體併入 error-classify.ts 的單一
// 有序表 ERROR_RULES（與 workflow-service 的可重試判定同源，順序即優先序、
// 文案逐字未動）。本檔只留人話出口函數與 code 分流，查表一律走 error-classify。
import { humanForError } from "./error-classify.ts"
import type { UserScript } from "./outbound-sanitize.ts"

/** 英文供應商錯誤 → 中文短句；未命中回空串。（查 ERROR_RULES 單表）
 *  2026-10-04 T2：script 傳入時按書寫體取繁體鏡像（詳見 error-classify.ERROR_HUMAN_HANT）。 */
export function humanizeSupplierError(message: string, script?: UserScript): string {
  return humanForError(message, script)
}

/** 必得中文短句：映射命中 → 映射文；本身就是中文 → 原文；否則帶真實上游
 *  原因原文（截斷）——R5-C：兜底禁止只剩「执行失败，请重试或换一种方式」空話。
 *  2026-10-04 T2：script==="hant" 時三處固定文案（task_not_found／result_not_ready／
 *  兜底外殼）全部出繁體鏡像。 */
export function humanMessageFor(message: string, code?: string, script?: UserScript): string {
  const hant = script === "hant"
  // 0831 誠實歸因：本站自己的 404 曾被兜底包成「上游原因」，誤導用戶與模型連環重試。
  if (code === "task_not_found") {
    return hant
      ? "這個任務 ID 在平台查不到（ID 不完整或已過期）。不要憑記憶猜 ID：調用 image_get_result 不帶參數即可取回本輪全部真實任務 ID 與 URL。"
      : "这个任务 ID 在平台查不到（ID 不完整或已过期）。不要凭记忆猜 ID：调用 image_get_result 不带参数即可取回本轮全部真实任务 ID 与 URL。"
  }
  if (code === "result_not_ready") {
    return hant ? "任務仍在生成中，harness 會自動續接，無需重複查詢。" : "任务仍在生成中，harness 会自动续接，无需重复查询。"
  }
  // 已是中文人話（工具/站點自己寫的 hint）不再套「上游原因」外殼。
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const mapped = humanizeSupplierError(message, script)
  if (mapped) return mapped
  if (/[\u4e00-\u9fff]/.test(message)) return message
  const brief = message.length > 160 ? message.slice(0, 160) + "…" : message
  return hant
    ? `執行失敗（上游原因：${brief}）。請重試或換一種方式`
    : `执行失败（上游原因：${brief}）。请重试或换一种方式`
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

