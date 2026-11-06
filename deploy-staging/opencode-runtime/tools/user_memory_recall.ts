import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/**
 * 召回**这个用户的**长期记忆（private 全集，不止会话开头注入的 ≤8 条）。
 * query 留空＝列出「我记得你的全部条目」目录（回答「你都记得我什么」）。
 * 通道＝POST /internal/memory/recall（loopback-only），ownerKey 由网关派生。
 */
export default tool({
  description: [
    "查这个用户被长期记住的东西（偏好、品牌、纠正、项目约定）。不是平台通用知识（那个用 memory_recall）。",
    "何时用：①用户问「你记得我什么／你知道我哪些偏好」→ query 留空，返回完整目录，如实列给用户；②动手前想确认用户是否有相关偏好/约定（风格、品牌色、禁忌）→ 用关键词查；③要遗忘某条前，先用它拿到 id。",
    "返回里的 id 可交给 memory_forget 删除。记忆可能过期：与用户本轮原话冲突时以本轮为准。",
    "如果返回 memory_disabled：用户关闭了记忆或本会话是临时对话——如实说明，不要绕过。",
  ].join("\n"),
  args: {
    query: tool.schema.string().optional().describe("关键词；留空＝列出全部记忆目录"),
    limit: tool.schema.number().optional().describe("有 query 时返回条数，默认 3，最多 5"),
  },
  async execute(args, context) {
    const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : ""
    if (!sessionID) return fail("missing_session", "user_memory_recall 需要会话上下文（sessionID），当前调用没有。")
    try {
      const res = await fetch(`${GATEWAY}/internal/memory/recall`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({
          session_id: sessionID,
          scope: "private",
          query: typeof args.query === "string" ? args.query : "",
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, any>
      if (!res.ok || data.ok !== true) {
        const code = typeof data?.error?.code === "string" ? data.error.code : "user_memory_recall_failed"
        const message = typeof data?.error?.message === "string" ? data.error.message : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status })
      }
      if (Array.isArray(data.private_directory)) {
        return ok({ title: `共 ${data.private_total} 条长期记忆`, total: data.private_total, directory: data.private_directory, note: "列给用户时按 description 概括，不要编造目录里没有的内容。" })
      }
      const list = Array.isArray(data.private) ? data.private : []
      return ok({ title: list.length ? `命中 ${list.length} 条长期记忆` : "没有相关的长期记忆", count: list.length, memories: list })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
