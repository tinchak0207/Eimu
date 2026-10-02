/**
 * smart_search 薄入口（同構 tools/search_web.ts / tools/search_aggregate.ts 模式）。
 */

import { tool } from "@opencode-ai/plugin/tool"
import { smartSearchTool, type WebToolDef, type WebToolContext } from "../lib/smart_search_impl"

/**
 * wrap：描述符 WebToolDef → opencode schema 純機械翻譯（逐行同構
 * tools/search_web.ts 的 wrapWebTool，白名單 diff 僅名稱；
 * WebToolContext 契約含 sessionId 透傳欄，與 MusicToolContext 同口徑）。
 * 禁止手改行為——改真源後重導出並重新落位 smart_search_impl.ts 與本檔。
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

export default wrapWebTool(smartSearchTool)
