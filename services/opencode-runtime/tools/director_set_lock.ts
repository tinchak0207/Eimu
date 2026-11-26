import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, bool } from "../lib/director-common"

// 3D 导演台锁定面（片4，2026-09-02）。kunpeng lockTool → gateway op set_lock 原生形状
// （op 联合中唯一 snake_case 的 op 名，栏位 target/shot_id/action_id/keyframe_id/locked 原样透传）。

export default tool({
  description:
    "锁定或解锁动作、人物 K 帧、摄影机 K 帧。锁定表示后续 Agent 不得修改；解锁必须由用户明确要求。",
  args: {
    target: tool.schema.enum(["action", "motion_keyframe", "camera_keyframe"]).describe("锁定目标类型"),
    shot_id: tool.schema.string().describe("目标镜头 ID"),
    action_id: tool.schema.string().optional().describe("target=action 或 motion_keyframe 时的动作 ID"),
    keyframe_id: tool.schema.string().optional().describe("target=motion_keyframe 或 camera_keyframe 时的 K 帧 ID"),
    locked: tool.schema.boolean().describe("true=锁定，false=解锁"),
    reason: tool.schema.string().min(1).describe("一句话说明为什么锁定/解锁（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        {
          ops: [
            {
              op: "set_lock",
              target: args.target as "action" | "motion_keyframe" | "camera_keyframe",
              shot_id: String(args.shot_id ?? ""),
              ...(args.action_id !== undefined ? { action_id: String(args.action_id) } : {}),
              ...(args.keyframe_id !== undefined ? { keyframe_id: String(args.keyframe_id) } : {}),
              locked: bool(args.locked, true),
            },
          ],
          reason: args.reason,
        },
        context.abort,
      )
      return ok({ target: args.target, locked: bool(args.locked, true), revision: data.revision })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return directorFail(e)
    }
  },
})
