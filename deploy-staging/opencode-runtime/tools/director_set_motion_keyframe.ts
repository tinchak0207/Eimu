import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, guardFail, activePlanOf, resolveShot, resolveAction, num, bool, hasVecParams, vecFromParams, projectFrameToSec, newKfId, actionFrameRangeHint } from "../lib/director-common"
import { smoothPathFrame, cornerPathFrame } from "../lib/director/pathCurve"
import { findPose } from "../lib/director/poses"
import type { DirectorMotionKeyframe, DirectorKeyframeInterpolation } from "../lib/director/types"

// 3D 导演台动作 K 帧（片4，2026-09-02）。schema 照搬 kunpeng motionKeyframeTool；
// 工具侧本地合成 updated K 帧数组（含锁定保留/同帧去重/路径整平），一次 updateAction 写回。
// 姿态关节（joints）由 findPose 轮子提供；path 整平用轮子 pathCurve（lib/director 原样部署）。

const INTERPOLATION_VALUES = ["hold", "linear", "smooth", "ease-in", "ease-out"] as const

export default tool({
  description:
    "在绝对工程帧新增或修改演员动作 K 帧，可写位置、旋转、缓动、曲线路径和手柄；单个人物还可写姿态，群演仅写整体阵列运动。默认不覆盖人工锁定关键帧。",
  args: {
    shot_id: tool.schema.string().describe("目标镜头 ID"),
    action_id: tool.schema.string().describe("动作 ID"),
    keyframe_id: tool.schema.string().optional().describe("要修改的 K 帧 ID；省略时按 project_frame 匹配"),
    project_frame: tool.schema.number().describe("绝对工程帧（24fps）"),
    position_x: tool.schema.number().optional(),
    position_y: tool.schema.number().optional(),
    position_z: tool.schema.number().optional(),
    rotation_x: tool.schema.number().optional(),
    rotation_y: tool.schema.number().optional(),
    rotation_z: tool.schema.number().optional(),
    pose_id: tool.schema.string().optional().describe("姿态模板 ID（单个人物可用；见 director_get_state 的 capabilities.pose_templates）"),
    interpolation: tool.schema.enum(INTERPOLATION_VALUES as unknown as [string, ...string[]]).optional(),
    path_mode: tool.schema.enum(["corner", "smooth"]).optional().describe("corner=直角路径（自动补路径 K 帧），smooth=贝塞尔平滑"),
    path_in_x: tool.schema.number().optional(),
    path_in_y: tool.schema.number().optional(),
    path_in_z: tool.schema.number().optional(),
    path_out_x: tool.schema.number().optional(),
    path_out_y: tool.schema.number().optional(),
    path_out_z: tool.schema.number().optional(),
    locked: tool.schema.boolean().optional(),
    override_locked: tool.schema.boolean().optional().describe("仅当用户明确要求覆盖锁定 K 帧时传 true"),
    note: tool.schema.string().optional(),
    reason: tool.schema.string().min(1).describe("一句话说明为什么设置 K 帧（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const state = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort)
      const activePlan = activePlanOf(state)
      if (!activePlan) return fail("director_not_initialized", "导演工程尚未初始化；（通常会自动播种；若仍报错请用 director_manage_plan(operation=add_plan)）")
      const shot = resolveShot(state, activePlan, args.shot_id)
      const action = resolveAction(shot, args.action_id)
      const projectSec = projectFrameToSec(activePlan, args.project_frame)
      const timeSec = projectSec - shot.startSec - action.startSec
      if (timeSec < -1 / 24 || timeSec > action.durationSec + 1 / 24) {
        // 2026-09-03 驗屍修復 R1-#5：錯誤 hint 帶範圍（該動作的工程幀區間 + 鏡頭內幀區間）
        return fail("director_invalid_args", actionFrameRangeHint(Number(args.project_frame), shot.startSec, action.startSec, action.durationSec))
      }
      const frames = [...(action.keyframes ?? [])]
      const existing =
        (args.keyframe_id ? frames.find((item) => item.id === String(args.keyframe_id)) : undefined) ??
        frames.find((item) => Math.abs(item.timeSec - timeSec) < 1 / (24 * 2))
      if (existing?.locked && args.override_locked !== true) {
        return fail("director_blocked", "该人物关键帧已被人工锁定，未覆盖")
      }
      const actor = ((state.project as { elements?: Array<{ id: string; kind: string }> }).elements ?? []).find(
        (item) => item.id === action.elementId,
      )
      const supportsPose = actor?.kind === "mannequin"
      const pose = supportsPose && args.pose_id ? findPose(String(args.pose_id)) : undefined
      if (supportsPose && args.pose_id && !pose) {
        return fail("director_invalid_args", `找不到姿态模板 ${String(args.pose_id)}`)
      }
      const fallbackPosition = existing?.position ?? action.from
      const fallbackRotation = existing?.rotationDeg ?? { x: 0, y: 0, z: 0 }
      const next: DirectorMotionKeyframe = {
        ...existing,
        id: existing?.id ?? newKfId(),
        timeSec: Math.max(0, Math.min(action.durationSec, timeSec)),
        position: hasVecParams(args, "position") ? vecFromParams(args, "position", fallbackPosition, [-100, 100]) : fallbackPosition,
        rotationDeg: hasVecParams(args, "rotation") ? vecFromParams(args, "rotation", fallbackRotation, [-360, 360]) : fallbackRotation,
        joints: supportsPose ? pose?.joints ?? existing?.joints : undefined,
        interpolation: (args.interpolation as DirectorKeyframeInterpolation | undefined) ?? existing?.interpolation ?? "smooth",
        pathMode: (args.path_mode as "corner" | "smooth" | undefined) ?? existing?.pathMode,
        pathIn: hasVecParams(args, "path_in") ? vecFromParams(args, "path_in", existing?.pathIn ?? { x: 0, y: 0, z: 0 }, [-100, 100]) : existing?.pathIn,
        pathOut: hasVecParams(args, "path_out") ? vecFromParams(args, "path_out", existing?.pathOut ?? { x: 0, y: 0, z: 0 }, [-100, 100]) : existing?.pathOut,
        locked: bool(args.locked, existing?.locked ?? false),
        source: "agent",
        note: args.note !== undefined ? String(args.note) : existing?.note,
      }
      // 2026-09-03 驗屍修復 R1-#4：同幀去重窗從半幀（1/48）放寬到一幀（1/24）——
      // 真實會話彈跳實錘（fd22bd6e rev49/55）：用戶 K 幀 t=1.0 與模板填充 K 幀 t=1.025
      // （0.6 幀間隔）共存，回放位置 15,-2→11.4,-1.64→15,-2 來回彈跳；
      // 24fps 口徑下一幀槽內的兩幀不可分辨，保留用戶幀（next）、丟棄近鄰模板殘留。
      // 人工鎖定幀永不在此丟棄（鎖定幀保留，與工具「默認不覆蓋鎖定 K 幀」契約一致）。
      let updated: DirectorMotionKeyframe[] = [
        ...frames.filter((item) => item.id !== next.id && (item.locked || Math.abs(item.timeSec - next.timeSec) >= 1 / 24)),
        next,
      ].sort((a, b) => a.timeSec - b.timeSec)
      if (args.path_mode === "smooth" && !hasVecParams(args, "path_in") && !hasVecParams(args, "path_out")) {
        updated = smoothPathFrame(updated, next.id)
      }
      if (args.path_mode === "corner") updated = cornerPathFrame(updated, next.id)
      // 2026-09-03 驗屍修復 R2：首/末 K 幀 from/to 同步。真實會話 rev57-68 實錘：打錨點 K 幀更新了
      // keyframes 但 action.from/to 元數據滯留（gateway updateAction 只合併 patch 不重錨），
      // 播放用 keyframes 不受損、元數據說謊。若本次寫入的 K 幀是動作首/末 K 幀（timeSec 最小/最大），
      // 同一把 updateAction patch 順帶把 from/to 對齊該 K 幀 position（不另發請求）。
      const syncedFields: string[] = []
      if (updated[0]?.id === next.id) syncedFields.push("from")
      if (updated[updated.length - 1]?.id === next.id) syncedFields.push("to")
      const patch: Record<string, unknown> = { keyframes: updated, source: "agent" }
      if (syncedFields.includes("from")) patch.from = { ...next.position }
      if (syncedFields.includes("to")) patch.to = { ...next.position }
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        { ops: [{ op: "updateAction", shot_id: shot.id, action_id: action.id, patch }], reason: args.reason },
        context.abort,
      )
      return ok({
        keyframe_id: next.id,
        action_id: action.id,
        project_frame: Math.round(projectSec * 24),
        total_keyframes: updated.length,
        path_mode: args.path_mode ?? next.pathMode ?? "corner",
        ...(syncedFields.length ? { meta: `动作${syncedFields.join("/")}已同步到该 K 帧位置（元数据不再滞留）` } : {}),
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
