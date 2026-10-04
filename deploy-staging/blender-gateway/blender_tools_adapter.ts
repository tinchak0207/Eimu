/**
 * blender_* 三工具 opencode 形状机械包装器（staging 稿，片 AJ，2026-09-06）。
 *
 * 行为真源 = blender-tools-impl.ts（由 tools/export-blender-tools-staging.ts 从
 * src/lib/blender-tools.ts 机械导出，BlenderToolDef 描述符形状）。本档把它包装成
 * opencode tool()（形状轮子 = src/vendor-bridges/opencode-tools/director_*.ts 的
 * tool({ description, args, execute }) + { title, output: JSON 字串 } 契约）。
 * 描述符 → schema 的映射是纯机械翻译：string→string、number→number、boolean→boolean、
 * enum→enum、required 缺省→optional；args 名/描述/enum 全部取自工具自带定义，
 * 零二次维护面（真源改 args，包装自动跟随）。
 *
 * VPS 落位（完整命令见同目录 PATCH-PLAN.md）：
 *   本档整份 → /opt/agent-harness/workspace/.opencode/lib/blender-tools-adapter.ts
 *   三个 3 行 adapter → .opencode/tools/blender_{exec,render,export_gltf}.ts：
 *     import { wrapBlenderTool, blenderExecTool } from "../lib/blender-tools-adapter"
 *     export default wrapBlenderTool(blenderExecTool)
 *
 * 产物取回（片 AJ）：exec/render 成功 output 带 artifact_base_url，agent 用
 * `${artifact_base_url}?path=${encodeURIComponent(artifact.path)}` 经桥取回字节；
 * 沙箱不自持档案，禁止在沙箱 ls 等产物。
 */
import { tool } from "@opencode-ai/plugin/tool"
import {
  blenderExecTool,
  blenderRenderTool,
  blenderExportGltfTool,
  type BlenderToolDef,
  type BlenderToolContext,
} from "./blender-tools-impl"

export function wrapBlenderTool(def: BlenderToolDef) {
  return tool({
    description: def.description,
    args: Object.fromEntries(
      Object.entries(def.args).map(([name, spec]) => {
        let s: ReturnType<typeof tool.schema.string>
        if (spec.type === "string") {
          s = ("enum" in spec && spec.enum ? tool.schema.enum([...spec.enum]) : tool.schema.string()) as never
        } else if (spec.type === "number") {
          s = tool.schema.number() as never
        } else {
          s = tool.schema.boolean() as never
        }
        if (!spec.required) s = s.optional() as never
        return [name, s.describe(spec.description)]
      }),
    ),
    async execute(args: Record<string, unknown>, context: BlenderToolContext) {
      return def.execute(args, context)
    },
  })
}

export { blenderExecTool, blenderRenderTool, blenderExportGltfTool }
