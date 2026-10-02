import { tool } from "@opencode-ai/plugin/tool"
import { visionAnalyzeTool, type VisionToolDef, type VisionToolContext } from "../lib/vision_impl"

/**
 * vision_analyze 薄入口（beast-army R2，2026-09-10；同構 music_gen.ts 接線範式）。
 * 行為真源 = lib/vision_impl.ts（tools/export-vision-tools-staging.ts 機械導出稿），
 * 描述符形狀 VisionToolDef → opencode schema 純機械翻譯（vision 參數全為 string，
 * 僅 enum 分支）。禁止手改行為——改真源後重導出並重新落位 vision_impl.ts。
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
