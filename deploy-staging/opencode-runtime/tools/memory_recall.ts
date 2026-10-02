/**
 * memory_recall 薄入口（P0-5，2026-09-15；逐行同構 VPS R1 search_web.ts 範式，
 * 白名單偏離僅名稱/描述符 import 路徑——wrap 函數體、tool import、execute 透傳全不動）。
 *
 * 部署落點：VPS `/opt/agent-harness/workspace/.opencode/tools/memory_recall.ts`
 * （配套 lib：`/opt/agent-harness/workspace/.opencode/lib/memory_recall_impl.ts`）。
 * 註冊名 = tools/ 檔名 = `memory_recall`。命名域教訓（09-10 實錘）：opencode 1.18.14
 * 保留 websearch/web_search 命名域，撞名檔被物理移除；`memory_recall` 非保留名，OK。
 *
 * 構形鐵律（R1 教訓 [[search-web-harness-tool-r1-0910]]，2026-09-10 實錘）：
 * `@opencode-ai/plugin/tool` 的 import 必須放在本薄入口檔**內**（內聯 wrap），
 * 不可下沉到 lib 二層——plugin import 在 lib 層時工具不被載入（music_gen/blender 家族/
 * web_search 舊構形實測 NOT_HAVE）。lib/memory_recall_impl.ts 保持純零依賴 verbatim。
 *
 * 生效需 `systemctl restart opencode-server`（工具面變更，記憶 timeline-buildout 三錘）。
 */

import { tool } from "@opencode-ai/plugin/tool"
import { memoryRecallTool, type MemoryToolDef, type MemoryToolContext } from "../lib/memory_recall_impl"

/**
 * wrap：描述符 MemoryToolDef → opencode schema 純機械翻譯（逐行同構 search_web.ts
 * 的 wrapWebTool，白名單 diff 僅函數/型別名；MemoryToolContext 契約含 sessionId
 * 透傳欄，與 WebToolContext 同口徑）。
 * 禁止手改行為——改真源後重導出並重新落位 memory_recall_impl.ts 與本檔。
 */
function wrapMemoryTool(def: MemoryToolDef) {
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
    async execute(args: Record<string, unknown>, context: MemoryToolContext) {
      return def.execute(args, { ...context, sessionId: context.sessionID })
    },
  })
}

export default wrapMemoryTool(memoryRecallTool)
