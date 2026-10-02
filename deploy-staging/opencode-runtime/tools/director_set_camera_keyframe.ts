import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, guardFail, activePlanOf, resolveShot, num, bool, hasVecParams, vecFromParams, projectFrameToSec, newCkfId, shotFrameRangeHint } from "../lib/director-common"
import type { DirectorCameraKeyframe, DirectorKeyframeInterpolation } from "../lib/director/types"

// 3D 导演台摄影机 K 帧（片4，2026-09-02）。schema 照搬 kunpeng cameraKeyframeTool；
// 工具侧合成 updated K 帧数组（锁定保留/同帧去重/排序），一次 updateShot patch.cameraKeyframes 写回。

const INTERPOLATION_VALUES = ["hold", "linear", "smooth", "ease-in", "ease-out"] as const

export default tool({
  description:
    "在绝对工程帧新增或修改摄影机 K 帧，支持位置、注视点、FOV、滚转和缓动。默认不覆盖人工锁定关键帧。",
  args: {
    shot_id: tool.schema.string().describe("目标镜头 ID"),
    keyframe_id: tool.schema.string().optional().describe("要修改的 K 帧 ID；省略时按 project_frame 匹配"),
    project_frame: tool.schema.number().describe("绝对工程帧（24fps）"),
    position_x: tool.schema.number().optional(),
    position_y: tool.schema.number().optional(),
    position_z: tool.schema.number().optional(),
    target_x: tool.schema.number().optional().describe("注视点 X"),
    target_y: tool.schema.number().optional().describe("注视点 Y"),
    target_z: tool.schema.number().optional().describe("注视点 Z"),
    fov: tool.schema.number().optional().describe("视场角 10-100"),
    roll_deg: tool.schema.number().optional().describe("滚转角 -180~180"),
    interpolation: tool.schema.enum(INTERPOLATION_VALUES as unknown as [string, ...string[]]).optional(),
    locked: tool.schema.boolean().optional(),
    override_locked: tool.schema.boolean().optional().describe("仅当用户明确要求覆盖锁定 K 帧时传 true"),
    note: tool.schema.string().optional(),
    reason: tool.schema.string().min(1).describe("一句话说明为什么设置摄影机 K 帧（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, args.shot_id)
      const projectSec = projectFrameToSec(activePlan, args.project_frame)
      const timeSec = projectSec - shot.startSec
      if (timeSec < -1 / 24 || timeSec > shot.durationSec + 1 / 24) {
        // 2026-09-03 驗屍修復 R1-#5：錯誤 hint 帶範圍（該鏡頭的工程幀區間）
        return fail("director_invalid_args", shotFrameRangeHint(Number(args.project_frame), shot.startSec, shot.durationSec))
      }
      const frames = [...(shot.cameraKeyframes ?? [])]
      const existing =
        (args.keyframe_id ? frames.find((item) => item.id === String(args.keyframe_id)) : undefined) ??
        frames.find((item) => Math.abs(item.timeSec - timeSec) < 1 / (24 * 2))
      if (existing?.locked && args.override_locked !== true) {
        return fail("director_blocked", "该摄影机关键帧已被人工锁定，未覆盖")
      }
      const next: DirectorCameraKeyframe = {
        ...existing,
        id: existing?.id ?? newCkfId(),
        timeSec: Math.max(0, Math.min(shot.durationSec, timeSec)),
        position: vecFromParams(args, "position", existing?.position ?? shot.position, [-100, 100]),
        target: vecFromParams(args, "target", existing?.target ?? shot.target, [-100, 100]),
        fov: num(args.fov, existing?.fov ?? shot.fov, 10, 100),
        rollDeg: num(args.roll_deg, existing?.rollDeg ?? shot.rollDeg ?? 0, -180, 180),
        interpolation: (args.interpolation as DirectorKeyframeInterpolation | undefined) ?? existing?.interpolation ?? "smooth",
        locked: bool(args.locked, existing?.locked ?? false),
        source: "agent",
        note: args.note !== undefined ? String(args.note) : existing?.note,
      }
      const updated = [
        ...frames.filter((item) => item.id !== next.id && Math.abs(item.timeSec - next.timeSec) >= 1 / (24 * 2)),
        next,
      ].sort((a, b) => a.timeSec - b.timeSec)
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        { ops: [{ op: "updateShot", shot_id: shot.id, patch: { cameraKeyframes: updated } }], reason: args.reason },
        context.abort,
      )
      return ok({
        camera_keyframe_id: next.id,
        shot_id: shot.id,
        project_frame: Math.round(projectSec * 24),
        total_keyframes: updated.length,
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
