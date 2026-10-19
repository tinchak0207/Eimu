import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail, activePlanOf, resolveShot, resolveAction, bool } from "../lib/director-common"

// 3D 导演台删除面（片4，2026-09-02）。kunpeng deleteTool → gateway ops：
// element=delete_element；action=delete_action；motion/camera K 帧=delete_keyframe。
// 锁定守卫在 gateway（director_blocked），override_locked 透传；存在性守卫文案 gateway 与轮子逐字同源。

export default tool({
  description:
    "删除动作、人物 K 帧、摄影机 K 帧或临时对象。仅在用户明确说删除时调用；锁定内容默认拒绝删除。",
  args: {
    target: tool.schema.enum(["action", "motion_keyframe", "camera_keyframe", "element"]).describe("删除目标类型"),
    shot_id: tool.schema.string().optional().describe("目标镜头 ID（非 element 目标必填；缺省=当前活动镜头）"),
    action_id: tool.schema.string().optional().describe("target=action 或 motion_keyframe 时的动作 ID"),
    keyframe_id: tool.schema.string().optional().describe("target=motion_keyframe 或 camera_keyframe 时的 K 帧 ID"),
    element_id: tool.schema.string().optional().describe("target=element 时的对象 ID"),
    override_locked: tool.schema.boolean().optional().describe("仅当用户明确要求删除锁定内容时传 true"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么删除（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const target = String(args.target ?? "")
      if (target === "element") {
        const id = String(args.element_id ?? "")
        if (!id) return fail("director_invalid_args", "删除对象需要 element_id")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "delete_element", element_id: id }], reason: args.reason },
          context.abort,
        )
        return ok({ deleted_element_id: id, revision: data.revision })
      }
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, args.shot_id)
      if (target === "action") {
        const action = resolveAction(shot, args.action_id)
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "delete_action", shot_id: shot.id, action_id: action.id, ...(args.override_locked !== undefined ? { override_locked: bool(args.override_locked, false) } : {}) }], reason: args.reason },
          context.abort,
        )
        return ok({ deleted_action_id: action.id, revision: data.revision })
      }
      if (target === "motion_keyframe") {
        const action = resolveAction(shot, args.action_id)
        const id = String(args.keyframe_id ?? "")
        if (!id) return fail("director_invalid_args", "删除人物关键帧需要 keyframe_id")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "delete_keyframe", target: "motion_keyframe", shot_id: shot.id, action_id: action.id, keyframe_id: id, ...(args.override_locked !== undefined ? { override_locked: bool(args.override_locked, false) } : {}) }], reason: args.reason },
          context.abort,
        )
        return ok({ deleted_motion_keyframe_id: id, revision: data.revision })
      }
      if (target === "camera_keyframe") {
        const id = String(args.keyframe_id ?? "")
        if (!id) return fail("director_invalid_args", "删除摄影机关键帧需要 keyframe_id")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "delete_keyframe", target: "camera_keyframe", shot_id: shot.id, keyframe_id: id, ...(args.override_locked !== undefined ? { override_locked: bool(args.override_locked, false) } : {}) }], reason: args.reason },
          context.abort,
        )
        return ok({ deleted_camera_keyframe_id: id, revision: data.revision })
      }
      return fail("director_invalid_args", "不支持的删除目标")
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
