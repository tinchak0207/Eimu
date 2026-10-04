import { tool } from "@opencode-ai/plugin/tool"
import { visionAnalyzeTool, type VisionToolDef, type VisionToolContext } from "../lib/vision_impl"

/**
 * vision_analyze 薄入口（beast-army R2，2026-09-10；同构 music_gen.ts 接线范式）。
 * 行为真源 = lib/vision_impl.ts（tools/export-vision-tools-staging.ts 机械导出稿），
 * 描述符形状 VisionToolDef → opencode schema 纯机械翻译（vision 参数全为 string，
 * 仅 enum 分支）。禁止手改行为——改真源后重导出并重新落位 vision_impl.ts。
 */
function wrapVisionTool(def: VisionToolDef) {
  return tool({
    description: def.description,
    args: Object.fromEntries(
      Object.entries(def.args).map(([name, spec]) => {
        let s: ReturnType<typeof tool.schema.string>
        if ("enum" in spec && spec.enum) {
          s = tool.schema.enum([...spec.enum]) as never
        } else {
          s = tool.schema.string() as never
        }
        if (!spec.required) s = s.optional() as never
        return [name, s.describe(spec.description)]
      }),
    ),
    async execute(args: Record<string, unknown>, context: VisionToolContext) {
      return def.execute(args, { abort: context.abort })
    },
  })
}

export default wrapVisionTool(visionAnalyzeTool)
