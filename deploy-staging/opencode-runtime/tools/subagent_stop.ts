import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "停止正在运行的子代理。",
    "何时用：发现跑偏、方向作废、预算失控或任务不再需要时；方向正确但暂时无输出时不要停，等自动唤醒。",
    "何时不用：不要用它代替失败重试。",
    "关键约束：subagent_id 或 all=true 二选一；省略二者＝停全部（本会话名下所有在跑子代理）；mode=hard 立即终止、soft 收尾保成果；已终态回 not_cancelable。",
    "失败处置：not_found 核对 id/label；not_cancelable 表示已终态，不要重试；stop_failed 按 gateway 文本修正；gateway_unreachable 稍后重试。",
    "互指：软停后可用 subagent_message 续跑；查状态用 subagent_status；全新任务重新 subagent_dispatch。",
    "示例：subagent_stop({subagent_id:agent-x7q, mode:soft})",
  ].join("\n"),
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("要停止的 subagent_id（subagent_dispatch 返回值）或 label 前缀；省略=停全部"),
    all: tool.schema.boolean().optional().describe("true=停本会话名下全部在跑的子代理"),
    mode: tool.schema
      .enum(["hard", "soft"])
      .optional()
      .describe(
        "停止方式，缺省 hard：hard=立即终止（默认，现行为）；soft=让它立即收尾并保留已产出成果，走正常收尾后回报原因与起止时间。任务作废才用 hard；只是想让它别再往下跑、但成果要留，用 soft。soft 收尾后仍在接续窗口内，可用 subagent_message 续跑（不必重派）；已终态的 run 会回 not_cancelable（取消是尽力而为，不改写终态）",
      ),
  },
  async execute(args, context) {
    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          ...(args.subagent_id ? { subagent_id: args.subagent_id } : {}),
          ...(args.all === true ? { all: true } : {}),
          ...(args.mode === "hard" || args.mode === "soft" ? { mode: args.mode } : {}),
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        // R3(b)：如实透传 gateway 的错误 code（如 not_cancelable／not_found）与其附带的
        // status/resumable 提示，不再一律压成 stop_failed。
        const code = typeof data?.code === "string" && data.code ? data.code : "stop_failed"
        return fail(code, data?.error || `HTTP ${res.status}`, {
          http_status: res.status,
          ...(data?.status !== undefined ? { status: data.status } : {}),
          ...(data?.resumable === true ? { resumable: true } : {}),
          ...(typeof data?.note === "string" && data.note ? { note: data.note } : {}),
        })
      }
      // R3(a)：soft 与 hard 回执语义不同——soft＝收尾保成果、可续跑（不是「重新派遣」）；
      // hard／缺省＝今日文案逐字不变。读 gateway 回带的新栏位 data.mode 判定。
      const isSoft = data.mode === "soft"
      return ok({
        title: isSoft ? "已请子代理收尾（soft）" : "已停止子代理",
        stopped: data.stopped ?? 0,
        subagent_ids: data.subagent_ids ?? [],
        ...(data.mode !== undefined ? { mode: data.mode } : {}),
        note: isSoft
          ? "已请子代理立即收尾（soft）：它会写完当前成果再正常结束，成果保留。稍后用 subagent_status 看终态，并在接续窗口内用 subagent_message 追加指令续跑——不必重新派遣。"
          : "已终止子代理会话，不会再重试、不会再唤醒你。若任务仍需推进，请重新派遣并修正任务书。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
