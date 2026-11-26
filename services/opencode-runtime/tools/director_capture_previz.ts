import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail, activePlanOf, resolveShot } from "../lib/director-common"

// 3D 导演台预演关键帧导出（S4，2026-10-22）。
// WebGL 截帧在前端（capturePlanKeyframes → uploadAgentAttachments）；本工具把已上传的
// https URL 写回 shot.previz.keyframes（与 ShotJson.previz / workflow-gw-submit
// reference_images 消费点同形）。不保证 MP4。

export default tool({
  description:
    "把预演关键帧 https URL 写入镜头 shot.previz.keyframes，供下游视频 reference_images。" +
    "实际 WebGL 截图与附件上传在前端画布（capturePlanKeyframes + 会话附件通道）；" +
    "本工具只做写回与范围确认。仍不产出 MP4。",
  args: {
    shot_id: tool.schema.string().optional().describe("目标镜头 ID；缺省=当前活动镜头"),
    keyframe_urls: tool.schema
      .array(tool.schema.string())
      .min(1)
      .max(8)
      .describe("已上传的预演关键帧 https URL（通常首/中/尾 3 张）"),
    motion_ref: tool.schema.string().optional().describe("可选 motion_ref（ShotJson.previz.motion_ref）"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么写回预演关键帧（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) {
        return fail(
          "director_not_initialized",
          "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）",
        )
      }
      const shot = resolveShot(state, activePlan, args.shot_id)
      const urls = (args.keyframe_urls ?? [])
        .map((u) => String(u).trim())
        .filter((u) => u.length > 0)
      if (!urls.length) {
        return fail(
          "director_invalid_args",
          "需要 keyframe_urls（https）。请先在前端跑 capturePlanKeyframes + 会话附件上传，或把已有 URL 传入。",
        )
      }
      const invalid = urls.find((u) => !/^https?:\/\//i.test(u))
      if (invalid) {
        return fail("director_invalid_args", "keyframe_urls 必须是 http(s) URL；本地 dataURL/路径请先上传。")
      }
      const previz: { keyframes: string[]; motion_ref?: string } = { keyframes: urls }
      if (args.motion_ref !== undefined && String(args.motion_ref).trim()) {
        previz.motion_ref = String(args.motion_ref).trim()
      }
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        {
          ops: [
            { op: "updateShot", shot_id: shot.id, patch: { previz } },
            { op: "save" },
          ],
          reason: args.reason,
        },
        context.abort,
      )
      return ok({
        updated_shot_id: shot.id,
        previz,
        keyframe_count: urls.length,
        mp4: null,
        note: "已写回 shot.previz.keyframes；网关 workflow-gw-submit 会并进 reference_images。MP4 整段导出仍未接入。",
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
