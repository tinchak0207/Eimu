import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, guardFail, activePlanOf, resolveShot, num, framesToSec } from "../lib/director-common"
import { cameraPatchFromTemplate } from "../lib/director/cameraTemplates"
import type { DirectorSequenceShot } from "../lib/director/types"

// 3D 导演台镜头管理（片4，2026-09-02）。schema 照搬 kunpeng manageShotTool；
// add=op addShot；update=op updateShot（camera_move 走 cameraPatchFromTemplate 轮子，
// 保留人工锁定 K 帧同轮子 L582-588）；delete=op removeShot；reorder=op reorderShot。

const CAMERA_MOVE_IDS = [
  "static", "push", "pull", "truck-left", "truck-right",
  "crane-up", "crane-down", "pan-left", "pan-right",
  "tilt-up", "tilt-down", "orbit", "arc-left", "arc-right",
  "follow", "tracking", "steadicam", "handheld", "handheld-intense",
  "jib-up", "jib-down", "zoom-in", "zoom-out", "dolly-zoom",
  "whip-pan-left", "whip-pan-right", "roll-left", "roll-right",
] as const

export default tool({
  description:
    "新增、修改、复制顺序或删除镜头。update 可改名称、时长、运镜、景别和备注；删除必须是用户明确要求。",
  args: {
    operation: tool.schema.enum(["add", "update", "delete", "reorder"]).describe("镜头操作"),
    shot_id: tool.schema.string().optional().describe("目标镜头 ID（update/delete/reorder 必填）"),
    name: tool.schema.string().optional(),
    duration_frames: tool.schema.number().optional().describe("镜头时长（帧，24fps；6-2400）"),
    camera_move: tool.schema
      .enum(CAMERA_MOVE_IDS as unknown as [string, ...string[]])
      .optional()
      .describe("运镜模板 ID（完整语义见 director_get_state 的 capabilities.camera_moves）"),
    shot_scale: tool.schema
      .enum(["extreme-wide", "wide", "medium", "medium-close", "close-up", "extreme-close-up"])
      .optional()
      .describe("景别"),
    notes: tool.schema.string().optional(),
    target_index: tool.schema.number().optional().describe("reorder 目标下标（0 起）"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么做这次镜头操作（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const op = String(args.operation)
      if (op === "add") {
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          {
            ops: [
              {
                op: "addShot",
                shot: {
                  ...(args.name !== undefined ? { name: String(args.name) } : {}),
                  ...(args.duration_frames !== undefined ? { durationSec: framesToSec(num(args.duration_frames, 90, 6, 2400)) } : {}),
                  ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
                },
              },
            ],
            reason: args.reason,
          },
          context.abort,
        )
        const changed = (data.changed as string[] | undefined)?.find((entry) => entry.startsWith("shot:"))
        return ok({ created_shot_id: changed ? changed.slice("shot:".length) : null, revision: data.revision })
      }
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, args.shot_id)
      if (op === "delete") {
        if (activePlan.shots.length <= 1) return fail("director_blocked", "方案至少保留一个镜头")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "removeShot", shot_id: shot.id }], reason: args.reason },
          context.abort,
        )
        return ok({ deleted_shot_id: shot.id, revision: data.revision })
      }
      if (op === "reorder") {
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "reorderShot", shot_id: shot.id, to_index: Math.round(num(args.target_index, 0, 0, activePlan.shots.length - 1)) }], reason: args.reason },
          context.abort,
        )
        return ok({ reordered_shot_id: shot.id, target_index: args.target_index ?? null, revision: data.revision })
      }
      if (op === "update") {
        const patch: Partial<DirectorSequenceShot> = {}
        if (args.name !== undefined) patch.name = String(args.name)
        if (args.duration_frames !== undefined) {
          patch.durationSec = framesToSec(num(args.duration_frames, shot.durationSec * 24, 6, 2400))
        }
        if (args.camera_move !== undefined) {
          const move = args.camera_move as DirectorSequenceShot["cameraMove"]
          const generated = cameraPatchFromTemplate({ ...shot, durationSec: patch.durationSec ?? shot.durationSec }, move)
          const lockedFrames = (shot.cameraKeyframes ?? []).filter((frame) => frame.locked)
          patch.cameraMove = move
          patch.cameraEnd = generated.cameraEnd
          patch.cameraKeyframes = [
            ...(generated.cameraKeyframes ?? []).filter(
              (candidate) => !lockedFrames.some((locked) => Math.abs(locked.timeSec - candidate.timeSec) < 1 / 24),
            ),
            ...lockedFrames,
          ].sort((left, right) => left.timeSec - right.timeSec)
        }
        if (args.shot_scale !== undefined) patch.shotScale = args.shot_scale as DirectorSequenceShot["shotScale"]
        if (args.notes !== undefined) patch.notes = String(args.notes)
        if (!Object.keys(patch).length) return fail("director_invalid_args", "没有提供镜头修改参数")
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          { ops: [{ op: "updateShot", shot_id: shot.id, patch }], reason: args.reason },
          context.abort,
        )
        return ok({ updated_shot_id: shot.id, patch, revision: data.revision })
      }
      return fail("director_invalid_args", `不支持的镜头操作 ${op}`)
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
