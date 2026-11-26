import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, FPS_OUT } from "../lib/director-common"

// 3D 导演台读取面（片4，2026-09-02）：包 gateway（loopback）GET /agent/v1/director/state。
// schema 照搬 kunpeng directorTools.ts getStateTool；存取层白名单：zustand→GATEWAY loopback。
// 2026-09-03 验尸修复 R2：默认 summary 模式（gateway R1-#1 已支持 ?mode=summary，剥 joints/keyframes
// 阵列，体积约 1/3）；需要完整 K 帧座标时显式传 mode=full。

const GATEWAY_DESC =
  "读取导演台状态：当前帧、真实对象 ID、镜头、人物动作（含起止位置与 K 帧摘要）、姿态模板、贝塞尔路径摘要、摄影机 K 帧、锁定状态、检查结果和可用模板。默认返回摘要模式（结构+动作摘要+health，剥离关节座标，体积约 1/3）；需要完整 K 帧座标（含关节）时传 mode=full。任何修改前和修改后都必须调用。"

export default tool({
  description: GATEWAY_DESC,
  args: {
    mode: tool.schema
      .enum(["summary", "full"])
      .optional()
      .describe("读取模式；默认 summary=结构+动作摘要（剥离关节座标）；full=完整 K 帧座标（含关节）"),
  },
  async execute(args, context) {
    try {
      const mode = args.mode === "full" ? "full" : "summary"
      const data = await directorFetch(context.sessionID, "state", "GET", undefined, context.abort, `&mode=${mode}`)
      return ok({
        title: mode === "summary" ? "导演台状态（摘要）" : "导演台状态",
        fps: FPS_OUT,
        project: data.project,
        active_plan_id: data.active_plan_id,
        active_shot_id: data.active_shot_id,
        health: data.health,
        revision: data.revision,
        initialized: data.initialized,
        ...(mode === "summary"
          ? { meta: "当前为摘要模式；关键帧座标已剥离，需要完整座标用 mode=full" }
          : {}),
        rules: [
          "所有写操作使用返回的真实 ID",
          "帧率固定 24fps",
          "默认不覆盖人工锁定",
          "修改后再次读取状态复核",
        ],
        isolation: "导演台只操作白模工程元数据；不会把来源视频或正式资产加入导演台。",
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return directorFail(e)
    }
  },
})
