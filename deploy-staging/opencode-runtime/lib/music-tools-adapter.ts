/**
 * music_gen 工具 opencode 形状机械包装器（Wave1 收尾接线片，2026-09-08）。
 *
 * 形状轮子 = lib/blender-tools-adapter.ts 的 wrapBlenderTool（逐行同构，白名单
 * diff 仅：名称/导入源/context.sessionId 透传三处——MusicToolDef 契约多一个
 * sessionId 栏，opencode execute context 的 sessionID 原样塞进去，音频才能
 * 经 gateway /agent/v1/sessions/<id>/uploads 落盘拼公网 URL）。
 * 行为真源 = lib/music-tools-impl.ts（staging/music-tools/music_tools.ts 落位稿，
 * 描述符形状 MusicToolDef，描述符 → schema 映射纯机械翻译零二次维护面）。
 */
import { tool } from "@opencode-ai/plugin/tool"
import { musicGenTool, type MusicToolDef, type MusicToolContext } from "./music-tools-impl"

export function wrapMusicTool(def: MusicToolDef) {
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
    async execute(args: Record<string, unknown>, context: MusicToolContext) {
      return def.execute(args, { ...context, sessionId: context.sessionID })
    },
  })
}

export { musicGenTool }
