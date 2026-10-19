/**
 * memory_recall 薄入口（P0-5，2026-09-15；逐行同构 VPS R1 search_web.ts 范式，
 * 白名单偏离仅名称/描述符 import 路径——wrap 函数体、tool import、execute 透传全不动）。
 *
 * 部署落点：VPS `/opt/eimu-harness/workspace/.opencode/tools/memory_recall.ts`
 * （配套 lib：`/opt/eimu-harness/workspace/.opencode/lib/memory_recall_impl.ts`）。
 * 注册名 = tools/ 档名 = `memory_recall`。命名域教训（09-10 实锤）：opencode 1.18.14
 * 保留 websearch/web_search 命名域，撞名档被物理移除；`memory_recall` 非保留名，OK。
 *
 * 构形铁律（R1 教训 [[search-web-harness-tool-r1-0910]]，2026-09-10 实锤）：
 * `@opencode-ai/plugin/tool` 的 import 必须放在本薄入口档**内**（内联 wrap），
 * 不可下沉到 lib 二层——plugin import 在 lib 层时工具不被载入（music_gen/blender 家族/
 * web_search 旧构形实测 NOT_HAVE）。lib/memory_recall_impl.ts 保持纯零依赖 verbatim。
 *
 * 生效需 `systemctl restart opencode-server`（工具面变更，记忆 timeline-buildout 三锤）。
 */

import { tool } from "@opencode-ai/plugin/tool"
import { memoryRecallTool, type MemoryToolDef, type MemoryToolContext } from "../lib/memory_recall_impl"

/**
 * wrap：描述符 MemoryToolDef → opencode schema 纯机械翻译（逐行同构 search_web.ts
 * 的 wrapWebTool，白名单 diff 仅函数/型别名；MemoryToolContext 契约含 sessionId
 * 透传栏，与 WebToolContext 同口径）。
 * 禁止手改行为——改真源后重导出并重新落位 memory_recall_impl.ts 与本档。
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
