/**
 * music_gen 工具 opencode 形狀機械包裝器（Wave1 收尾接線片，2026-09-08）。
 *
 * 形狀輪子 = lib/blender-tools-adapter.ts 的 wrapBlenderTool（逐行同構，白名單
 * diff 僅：名稱/導入源/context.sessionId 透傳三處——MusicToolDef 契約多一個
 * sessionId 欄，opencode execute context 的 sessionID 原樣塞進去，音頻才能
 * 經 gateway /agent/v1/sessions/<id>/uploads 落盤拼公網 URL）。
 * 行為真源 = lib/music-tools-impl.ts（staging/music-tools/music_tools.ts 落位稿，
 * 描述符形狀 MusicToolDef，描述符 → schema 映射純機械翻譯零二次維護面）。
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
