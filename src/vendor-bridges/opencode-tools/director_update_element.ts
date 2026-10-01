import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail, activePlanOf, resolveShot, elementState, hasVecParams, vecFromParams } from "../lib/director-common"
import type { DirectorElement } from "../lib/director/types"

// 3D 导演台对象变换（片4，2026-09-02）。schema 照搬 kunpeng updateElementTool；
// op = updateShotElementState（patch: position/rotationDeg/scale/visible）。缺轴回退当前值（elementState）。

export default tool({
  description:
    "修改指定镜头内对象的位置、旋转、缩放或可见性。只写入该镜头，不污染其他镜头；必须使用 director_get_state 返回的 element_id/shot_id。",
  args: {
    shot_id: tool.schema.string().optional().describe("目标镜头 ID；缺省=当前活动镜头"),
    element_id: tool.schema.string().describe("对象 ID（director_get_state 返回的真实 ID）"),
    position_x: tool.schema.number().optional(),
    position_y: tool.schema.number().optional(),
    position_z: tool.schema.number().optional(),
    rotation_x: tool.schema.number().optional().describe("绕 X 轴旋转（度）"),
    rotation_y: tool.schema.number().optional().describe("绕 Y 轴旋转（度）"),
    rotation_z: tool.schema.number().optional().describe("绕 Z 轴旋转（度）"),
    scale_x: tool.schema.number().optional(),
    scale_y: tool.schema.number().optional(),
    scale_z: tool.schema.number().optional(),
    visible: tool.schema.boolean().optional(),
    reason: tool.schema.string().min(1).describe("一句话说明为什么修改（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, args.shot_id)
      const elements = (state.project as { elements?: DirectorElement[] }).elements ?? []
      const element = elements.find((item) => item.id === String(args.element_id))
      if (!element) return fail("director_not_found", `找不到对象 ${String(args.element_id)}`)
      const current = elementState(shot, element)
      const patch: Record<string, unknown> = {}
      if (hasVecParams(args, "position")) patch.position = vecFromParams(args, "position", current.position, [-100, 100])
      if (hasVecParams(args, "rotation")) patch.rotationDeg = vecFromParams(args, "rotation", current.rotationDeg, [-360, 360])
      if (hasVecParams(args, "scale")) patch.scale = vecFromParams(args, "scale", current.scale, [0.05, 20])
      if (args.visible !== undefined) patch.visible = args.visible
      if (Object.keys(patch).length === 0) return fail("director_invalid_args", "没有提供可修改的对象参数")
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        { ops: [{ op: "updateShotElementState", shot_id: shot.id, element_id: element.id, patch }], reason: args.reason },
        context.abort,
      )
      return ok({ updated: element.id, shot_id: shot.id, state: { ...current, ...patch }, revision: data.revision })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
