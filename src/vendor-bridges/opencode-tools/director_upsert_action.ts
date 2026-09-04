import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, guardFail, activePlanOf, resolveShot, resolveAction, elementState, num, bool, vecFromParams, hasVecParams } from "../lib/director-common"
import { motionTemplate, createMotionKeyframes } from "../lib/director/motionTemplates"
import type { DirectorActionId } from "../lib/director/types"

// 3D 导演台动作 upsert（片4，2026-09-02）。schema 照搬 kunpeng upsertActionTool；
// 新增=op addAction（seed；gateway 依模板 createMotionKeyframes 生成 K 帧）；
// 修改=op updateAction（工具侧 createMotionKeyframes 重生成 + 保留人工锁定 K 帧，与轮子同款）。

const ACTION_IDS = [
  "stand", "wait", "walk", "fast-walk", "run", "stop",
  "sit", "stand-up", "turn", "look-back", "crouch", "kneel",
  "lie-down", "raise-hand", "wave", "point", "pick-up",
  "put-down", "push", "pull", "open-door", "close-door",
  "hug", "face-to-face", "pass-by", "follow", "dodge",
  "fall", "get-up", "enter-car", "exit-car",
  "sew", "read", "write", "speak", "nod", "shake-head",
  "look-up", "look-down", "look-at", "reach", "hold",
  "idle-breathe", "listen", "hesitate", "bow", "cross-arms",
  "hands-on-hips", "clap", "drink", "phone", "hand-over",
  "receive", "step-back", "step-forward", "glance", "inspect", "knock",
] as const

export default tool({
  description:
    "新增或修改人物、动物或群演的动作片段。群演使用整体阵列的位置、朝向和路径，不使用人体关节。start_shot_frame 是镜头内帧，duration_frames 是动作长度；修改锁定动作必须有用户明确要求并传 override_locked=true。",
  args: {
    shot_id: tool.schema.string().describe("目标镜头 ID"),
    action_id: tool.schema.string().optional().describe("省略时新增动作。"),
    element_id: tool.schema.string().describe("人物/动物/群演对象 ID"),
    action: tool.schema
      .enum(ACTION_IDS as unknown as [string, ...string[]])
      .describe("动作模板 ID（完整语义见 director_get_state 的 capabilities.action_templates）"),
    start_shot_frame: tool.schema.number().optional().describe("镜头内起始帧"),
    duration_frames: tool.schema.number().optional().describe("动作时长（帧）"),
    to_x: tool.schema.number().optional().describe("结束位置 X"),
    to_y: tool.schema.number().optional().describe("结束位置 Y"),
    to_z: tool.schema.number().optional().describe("结束位置 Z"),
    intensity: tool.schema.number().optional().describe("动作强度 0.1-3"),
    locked: tool.schema.boolean().optional(),
    override_locked: tool.schema.boolean().optional().describe("仅当用户明确要求覆盖锁定动作时传 true"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么设置动作（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, args.shot_id)
      const elements = (state.project as { elements?: Array<{ id: string; kind: string }> }).elements ?? []
      const element = elements.find((item) => item.id === String(args.element_id))
      if (!element || (element.kind !== "mannequin" && element.kind !== "crowd")) {
        return fail("director_invalid_args", "动作只能绑定到 director_get_state 返回的人物、动物或群演 ID")
      }
      const template = motionTemplate(String(args.action) as DirectorActionId)
      const existing = args.action_id ? resolveAction(shot, args.action_id) : undefined
      if (existing?.locked && args.override_locked !== true) {
        return fail("director_blocked", "该动作已被人工锁定；只有用户明确要求覆盖时才能传 override_locked=true")
      }
      const stateAtShot = elementState(shot, element as never)
      const startSec =
        num(args.start_shot_frame, Math.round((existing?.startSec ?? 0) * 24), 0, Math.max(0, Math.round(shot.durationSec * 24) - 1)) / 24
      const durationSec =
        num(
          args.duration_frames,
          Math.round((existing?.durationSec ?? template.defaultDurationSec) * 24),
          1,
          Math.max(1, Math.round((shot.durationSec - startSec) * 24)),
        ) / 24
      const from = existing?.from ?? stateAtShot.position
      const suggested = template.moving ? template.suggestedDistance ?? 1.5 : 0
      const fallbackTo = existing?.to ?? { x: from.x, y: from.y, z: from.z - suggested }
      const to = vecFromParams(args, "to", fallbackTo, [-100, 100])
      if (existing) {
        const frames = createMotionKeyframes(template.id, durationSec, from, to, "agent")
        const preservedLocked = (existing.keyframes ?? []).filter((frame) => frame.locked && args.override_locked !== true)
        const generated = frames.filter(
          (frame) => !preservedLocked.some((locked) => Math.abs(locked.timeSec - frame.timeSec) < 1 / 24),
        )
        const keyframes = [...generated, ...preservedLocked].sort((a, b) => a.timeSec - b.timeSec)
        const data = await directorFetch(
          context.sessionID,
          "op",
          "POST",
          {
            ops: [
              {
                op: "updateAction",
                shot_id: shot.id,
                action_id: existing.id,
                patch: {
                  action: template.id,
                  templateId: template.id,
                  startSec,
                  durationSec,
                  from,
                  to,
                  intensity: num(args.intensity, existing.intensity ?? 1, 0.1, 3),
                  locked: bool(args.locked, existing.locked ?? false),
                  source: "agent",
                  keyframes,
                },
              },
            ],
            reason: args.reason,
          },
          context.abort,
        )
        return ok({ updated_action_id: existing.id, shot_id: shot.id, keyframe_count: generated.length + preservedLocked.length, revision: data.revision })
      }
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        {
          ops: [
            {
              op: "addAction",
              shot_id: shot.id,
              action: {
                element_id: element.id,
                action: template.id,
                start_sec: startSec,
                duration_sec: durationSec,
                to,
                intensity: num(args.intensity, 1, 0.1, 3),
                locked: bool(args.locked, false),
              },
            },
          ],
          reason: args.reason,
        },
        context.abort,
      )
      const changed = (data.changed as string[] | undefined)?.find((entry) => entry.startsWith("action:"))
      return ok({
        created_action_id: changed ? changed.slice("action:".length) : null,
        shot_id: shot.id,
        element_id: element.id,
        keyframe_count: 5,
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
