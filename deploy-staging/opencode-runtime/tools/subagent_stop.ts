import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "停止正在运行的子代理（subagent）。用于：发现子代理跑偏/方向已作废/预算失控/任务不再需要时，主动刹车——停止后该子代理的会话被终止、不再换模重试、不再被交付闸门重派、也不会再唤醒你。参数二选一：给 subagent_id 停指定的那一个（也接受 label 前缀）；省略 subagent_id 或给 all=true 停本会话名下全部在跑的子代理。停止不是失败重试的替代品——方向对但暂时无输出的情况应等自动唤醒，不要滥用。",
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("要停止的 subagent_id（subagent_dispatch 返回值）或 label 前缀；省略=停全部"),
    all: tool.schema.boolean().optional().describe("true=停本会话名下全部在跑的子代理"),
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
        }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail("stop_failed", data?.error || `HTTP ${res.status}`)
      }
      return ok({
        title: "已停止子代理",
        stopped: data.stopped ?? 0,
        subagent_ids: data.subagent_ids ?? [],
        note: "已终止子代理会话，不会再重试、不会再唤醒你。若任务仍需推进，请重新派遣并修正任务书。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
