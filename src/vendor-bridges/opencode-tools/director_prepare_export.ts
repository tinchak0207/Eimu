import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail, activePlanOf, resolveShot, projectFrameToSec, num } from "../lib/director-common"

// 3D 导演台导出准备（片4，2026-09-02）。kunpeng prepareExportTool 的 set-export-range/
// set-output-path/open-panel 属前端运行时命令（导出面板/输出路径是 UI 概念），gateway 文档
// 存储不含导出运行时 → 本工具做「范围校验 + 工程保存」的文档侧等价操作，明确不做导出。

export default tool({
  description:
    "设置导出工作区并打开导出面板，但不会开始导出。用户必须在界面检查范围和保存位置后手动点击导出。",
  args: {
    in_frame: tool.schema.number().describe("导出起点（绝对工程帧）"),
    out_frame: tool.schema.number().describe("导出终点（绝对工程帧）"),
    output_path: tool.schema.string().optional().describe("可选的绝对 .mp4 路径。"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么准备导出（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, undefined)
      const max = Math.round((activePlan ? (shot.startSec + shot.durationSec) : 0) * 24)
      const inFrame = Math.round(num(args.in_frame, 0, 0, Math.max(0, max - 1)))
      const outFrame = Math.round(num(args.out_frame, max, inFrame + 1, max))
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        { ops: [{ op: "save" }], reason: args.reason },
        context.abort,
      )
      return ok({
        prepared: true,
        in_frame: inFrame,
        out_frame: outFrame,
        requires_manual_export_confirmation: true,
        next: "请用户在右侧导出面板检查并点击导出。",
        note: "不会开始导出。本会话工具面只做范围校验与工程保存；正式成片导出走 timeline_master（先 check 后 export）。",
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})

// projectFrameToSec 供未来扩展 in/out 校验复用（保持与 wheel 帧语义同源）
void projectFrameToSec
