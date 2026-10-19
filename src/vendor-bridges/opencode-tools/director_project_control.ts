import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail } from "../lib/director-common"

// 3D 导演台工程控制（片4，2026-09-02）。kunpeng projectControlTool 的三个 operation 属
// 前端运行时命令（switch-workshop-shot / recognize-storyboard / repair-scene，dispatchDirectorRuntimeCommand），
// gateway 文档存储不含该面（片1-3 移植范围外）→ switch_shot/recognize_storyboard 走
// setActiveShot（shot_no→shot id 回读映射，等价语义），repair_scene 走 save（文档侧无可修白模可见性状态）。

export default tool({
  description:
    "切换同一工坊项目的分镜白模/动作预演，手动重新识别分镜图，或修复白模可见性。切换前会保存当前工程；重新识别可能调用视觉模型，必须由用户确认。",
  args: {
    operation: tool.schema.enum(["switch_shot", "recognize_storyboard", "repair_scene"]).describe("工程操作"),
    shot_no: tool.schema.string().optional().describe("switch_shot 时的分镜编号"),
    mode: tool.schema.enum(["storyboard", "video-prompt"]).optional().describe("switch_shot 时的预演模式，默认 video-prompt"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么做这次工程操作（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const operation = String(args.operation ?? "")
      if (operation === "switch_shot") {
        const shotNo = String(args.shot_no ?? "")
        if (!shotNo) return fail("director_invalid_args", "switch_shot 需要提供 shot_no（分镜编号）")
        const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
        const plan = (
          state.project as { plans?: Array<{ id: string; shots: Array<{ id: string; name: string }> }> }
        ).plans?.find((p) => p.id === state.active_plan_id)
        const target = plan?.shots.find((s) => s.name.includes(shotNo)) ?? plan?.shots.find((s) => s.name === shotNo)
        if (!target) return fail("director_not_found", `当前项目找不到分镜 ${shotNo}`)
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "setActiveShot", shot_id: target.id }], reason: args.reason },
          context.abort,
        )
        return ok({ switching_to: shotNo, shot_id: target.id, mode: args.mode === "storyboard" ? "storyboard" : "video-prompt", asynchronous: true, revision: data.revision })
      }
      if (operation === "recognize_storyboard") {
        return fail(
          "director_unsupported",
          "recognize_storyboard（重新调用视觉识别分镜图）在本会话工具面不可用：该操作属前端运行时命令，需要用户在界面确认后手动触发。可先用 director_get_state 读取现有分镜元数据。",
        )
      }
      if (operation === "repair_scene") {
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "save" }], reason: args.reason },
          context.abort,
        )
        return ok({ repair_started: false, saved: true, note: "文档侧白模可见性无损坏状态可修；已保存当前工程。若预演画面异常请在前端界面手动修复。", revision: data.revision })
      }
      return fail("director_invalid_args", `不支持的工程操作 ${operation}`)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
