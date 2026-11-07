import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/**
 * 按 id 删除这个用户的一条长期记忆（硬删除，不可恢复）。
 * 通道＝POST /internal/memory/forget（loopback-only），ownerKey 由网关派生，只能删本人的 private 记忆。
 */
export default tool({
  description: [
    "删除这个用户的一条长期记忆（硬删除，不可恢复）。",
    "只在用户明确说「忘掉／删掉／别再记这个」时用；流程：先 user_memory_recall 找到对应条目拿到 id，向用户确认是哪一条（若有多条相近），再用 id 调本工具；删完如实告诉用户删了什么。",
    "forget_text：用一句话写出要忘掉的那件事（用用户的原话关键词，如「品牌主色 青禾茶舍 松针绿」）。给了它，网关会把对话历史里复述同一件事的片段也一并抹掉并封存，之后 chat_history_search 不会再翻出来——用户说「忘掉」就必须带上。",
    "如果 user_memory_recall 查不到条目（事实只存在于对话历史里），不要空手回答「没有可删」：只传 forget_text 调本工具，同样能把历史里的复述抹掉。",
    "不能删平台共享记忆；不要为了「整理」自作主张删用户的记忆。",
  ].join("\n"),
  args: {
    id: tool.schema.string().optional().describe("记忆 id（mem-加16位十六进制），来自 user_memory_recall；记忆库里没有对应条目时可省略"),
    forget_text: tool.schema.string().optional().describe("要从对话历史里一并抹掉的那件事，一句话（用户原话关键词）"),
  },
  async execute(args, context) {
    const id = typeof args.id === "string" ? args.id.trim() : ""
    const forgetText = typeof args.forget_text === "string" ? args.forget_text.trim() : ""
    if (id && !/^mem-[a-f0-9]{16}$/.test(id)) return fail("invalid_id", "id 必须是 user_memory_recall 返回的 mem-xxxxxxxxxxxxxxxx。")
    if (!id && !forgetText) return fail("invalid_args", "需要 id（来自 user_memory_recall）或 forget_text（要从历史里抹掉的那件事）。")
    const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : ""
    if (!sessionID) return fail("missing_session", "memory_forget 需要会话上下文（sessionID），当前调用没有。")
    try {
      const res = await fetch(`${GATEWAY}/internal/memory/forget`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({ session_id: sessionID, ...(id ? { id } : {}), ...(forgetText ? { forget_text: forgetText } : {}) }),
        signal: AbortSignal.timeout(20000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, any>
      if (!res.ok || data.ok !== true) {
        const code = typeof data?.error?.code === "string" ? data.error.code : "memory_forget_failed"
        const message = typeof data?.error?.message === "string" ? data.error.message : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status })
      }
      const deleted = Number(data.deleted ?? 0)
      const history = Number(data.history_turns_removed ?? 0)
      const title = deleted > 0 ? "记忆已删除" : id ? "没有找到这条记忆" : "历史里的复述已抹掉"
      const note = [
        id ? (deleted > 0 ? "记忆已硬删除，不可恢复。" : "id 不属于该用户或已被删除。") : "",
        forgetText ? `对话历史里 ${history} 条相关片段已删除，同类内容今后不会再被检索到。` : "",
      ].filter(Boolean).join(" ")
      return ok({ title, deleted, history_turns_removed: history, note })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
