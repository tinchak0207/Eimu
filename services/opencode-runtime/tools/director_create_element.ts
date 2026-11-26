import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, directorFetch, directorFail, newElementId, vecFromParams, guardFail } from "../lib/director-common"
import { findPose } from "../lib/director/poses"
import type { DirectorElement } from "../lib/director/types"

// 3D 导演台新增临时对象（片4，2026-09-02）。构造逻辑照搬 kunpeng createElementTool L355-372
// （mannequin/animal/crowd 分支 + findPose('stand') 关节）；id=el-<nanoId8>（newElementId）。

export default tool({
  description:
    "按用户明确要求新增临时人物、动物、群众或白模代理道具。不要用它替代项目已有真实人物 ID；已有角色必须复用 director_get_state 返回的对象。",
  args: {
    kind: tool.schema
      .enum(["mannequin", "animal", "crowd", "box", "sphere", "cylinder", "wall"])
      .describe("对象类型：mannequin=人物白模，animal=四足动物，crowd=人群阵列，box/sphere/cylinder/wall=白模代理道具"),
    name: tool.schema.string().describe("对象名称"),
    position_x: tool.schema.number().optional(),
    position_y: tool.schema.number().optional(),
    position_z: tool.schema.number().optional(),
    scale_x: tool.schema.number().optional(),
    scale_y: tool.schema.number().optional(),
    scale_z: tool.schema.number().optional(),
    reason: tool.schema.string().min(1).describe("一句话说明为什么新增（进决策日志，供审计）"),
  },
  async execute(args, context) {
    try {
      const rawKind = String(args.kind ?? "box")
      const id = newElementId()
      const base = {
        id,
        name: String(args.name ?? "").trim() || "临时对象",
        position: vecFromParams(args, "position", { x: 0, y: 0, z: 0 }, [-100, 100]),
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: vecFromParams(args, "scale", { x: 1, y: 1, z: 1 }, [0.05, 20]),
        color: "#9ca3af",
        visible: true,
        groupId: null,
      }
      let element: DirectorElement
      if (rawKind === "mannequin" || rawKind === "animal") {
        element = {
          ...base,
          kind: "mannequin",
          bodyType: rawKind === "animal" ? "animal" : "person",
          animalSpecies: rawKind === "animal" ? "quadruped" : undefined,
          poseId: "stand",
          joints: findPose("stand")?.joints ?? {},
          heightM: rawKind === "animal" ? 0.9 : 1.7,
          identitySource: "temporary",
        } as DirectorElement
      } else if (rawKind === "crowd") {
        element = { ...base, kind: "crowd", rows: 3, cols: 3, spacing: 0.8, poseId: "stand" } as DirectorElement
      } else {
        element = { ...base, kind: rawKind as "box" | "sphere" | "cylinder" | "wall" } as DirectorElement
      }
      const data = await directorFetch(
        context.sessionID,
        "op",
        "POST",
        { ops: [{ op: "addElement", element }], reason: args.reason },
        context.abort,
      )
      // 2026-09-03 验尸修复 R2：kind 一致性。真实会话实锤：kind 请求 animal 返回 kind:"mannequin"
      // 无解释，agent 困惑「警犬建成人形」。返回值与请求不一致时补 note 说明内部表示。
      const note =
        rawKind === "animal" && element.kind === "mannequin"
          ? "已按四足动物创建（内部以 mannequin+bodyType:animal 表示，渲染为狗/猫等体型）"
          : element.kind !== rawKind
            ? `已按 ${rawKind} 创建（内部 kind 表示为 ${element.kind}）`
            : undefined
      return ok({
        created_element_id: id,
        kind: element.kind,
        name: element.name,
        temporary: true,
        ...(note ? { note } : {}),
        revision: data.revision,
      })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err?.code === "auth_error") return fail("auth_error", err.message)
      return guardFail(e)
    }
  },
})
