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

/** 原生文件/终端工具：参数原文就是命令与路径。 */
const NATIVE_HARNESS_TOOLS = new Set(["bash", "read", "glob", "grep", "list", "ls", "write", "edit", "patch"])
/** agent 自身挽具（工作区、.opencode/skills、路由提示词、本机内部端点）——不是用户的文件。 */
const HARNESS_INTERNAL_RE =
  /\/opt\/agent-harness(?![\w.-])|(?:^|[\s/"'=:;(])\.opencode(?:[/"'\s;]|$)|_prompt-routing|\b127\.0\.0\.1\b|\blocalhost:\d+/i
/** 用户自己的上传：任何工具都不按挽具省略，只把路径换成文件名。 */
const USER_UPLOAD_PATH_RE = /(?:file:\/\/)?\/opt\/agent-harness\/workspace\/uploads\/[^\s"'`,，。；;）)\]}]*/g

/**
 * 2026-10-31：原生工具的输入若引用 agent 自身挽具（/opt/agent-harness、.opencode、_prompt-routing、
 * 127.0.0.1／localhost:端口），用户可见面（实时 tool.invoke 的 args_summary、历史端点的 state.input）
 * 整体省略参数；/opt/agent-harness/workspace/uploads/ 下（用户自己的上传）不算挽具。
 */
export function isHarnessInternalToolInput(tool: string, input: unknown): boolean {
  if (!NATIVE_HARNESS_TOOLS.has(tool) || input == null) return false
  let s: string
  try {
    s = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    return false
  }
  USER_UPLOAD_PATH_RE.lastIndex = 0
  return HARNESS_INTERNAL_RE.test(s.replace(USER_UPLOAD_PATH_RE, " "))
}

/** 服务端工作区绝对路径（含 file://）：用户侧只留文件名。 */
const SERVER_ABS_PATH_RE = /(?:file:\/\/)?\/opt\/agent-harness\/[^\s"'`,，。；;）)\]}]*/g
/** 用户本机文件桥：路径是用户自己机器上的，原样保留。 */
const USER_LOCAL_PATH_TOOLS = new Set(["local_files", "local_files_authorize"])

/** 文本里的服务端绝对路径（/opt/agent-harness/…）→ 文件名。 */
export function basenameServerPathsInText(v: string): string {
  SERVER_ABS_PATH_RE.lastIndex = 0
  return v.replace(SERVER_ABS_PATH_RE, (m) => {
    const trimmed = m.replace(/\/+$/, "")
    return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "文件"
  })
}

function basenameServerPaths(v: unknown, depth: number): unknown {
  if (typeof v === "string") return basenameServerPathsInText(v)
  if (depth > 4 || v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map((x) => basenameServerPaths(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = basenameServerPaths(x, depth + 1)
  return out
}

/**
 * 用户可见的工具参数摘要（实时 tool.invoke.args_summary 与历史 state.input 的唯一出口）：
 *  - 原生工具操作 agent 自身挽具 → ""（前端无参数即无展开抽屉）；
 *  - 其余工具参数值里的服务端绝对路径（/opt/agent-harness/…）→ 文件名（用户仍知道看的是哪张图）。
 */
export function visibleToolArgs(tool: string, input: unknown): string {
  if (isHarnessInternalToolInput(tool, input)) return ""
  return summarizeArgs(USER_LOCAL_PATH_TOOLS.has(tool) ? input : basenameServerPaths(input, 0))
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

