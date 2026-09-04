import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, num } from "../lib/director-common"

// 3D 导演台播放控制（片4，2026-09-02）：op 線格式 camelCase（片3 坑①）。
// seek=setCurrentTime（幀→秒）、play/pause=setPlaying、undo/redo/save 同名 op。
//kunpeng transportTool 守衛文案照搬。

export default tool({
  description:
    "控制导演台播放头、播放、暂停、逐帧定位、撤销、重做和保存。seek 使用绝对工程帧。",
  args: {
    action: tool.schema
      .enum(["seek", "play", "pause", "undo", "redo", "save"])
      .describe("播放控制动作"),
    frame: tool.schema
      .number()
      .optional()
      .describe("seek 时的绝对工程帧，24fps。"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么做这次操作（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const op =
        args.action === "seek"
          ? { op: "setCurrentTime", time_sec: Math.round(num(args.frame, 0, 0)) / 24 }
          : args.action === "play"
            ? { op: "setPlaying", playing: true }
            : args.action === "pause"
              ? { op: "setPlaying", playing: false }
              : { op: args.action }
      const data = await directorFetch(context.sessionID, "op", "POST", { ops: [op], reason: args.reason }, context.abort)
      return ok({
        action: args.action,
        current_frame: Math.round(Number((data.project as { currentTimeSec?: number })?.currentTimeSec ?? 0) * 24),
        success: true,
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return directorFail(e)
    }
  },
})
