/**
 * web_search 薄入口（beast 军团 R1，2026-09-10；同构 tools/music_gen.ts 模式）。
 */

import { tool } from "@opencode-ai/plugin/tool"
import { webSearchTool, type WebToolDef, type WebToolContext } from "../lib/web_search_impl"

/**
 * wrap：描述符 WebToolDef → opencode schema 纯机械翻译（逐行同构
 * lib/music-tools-adapter.ts 的 wrapMusicTool，白名单 diff 仅名称；
 * WebToolContext 契约含 sessionId 透传栏，与 MusicToolContext 同口径）。
 * 禁止手改行为——改真源后重导出并重新落位 web_search_impl.ts 与本档。
 */
function wrapWebTool(def: WebToolDef) {
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
    async execute(args: Record<string, unknown>, context: WebToolContext) {
      return def.execute(args, { ...context, sessionId: context.sessionID })
    },
  })
}

export default wrapWebTool(webSearchTool)
