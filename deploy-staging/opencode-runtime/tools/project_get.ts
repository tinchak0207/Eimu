// project_get — 读工程图（S9）。三个视图：digest（≤6144B）/ node（≤4096B）/ events（≤20 行，≤2048B）。
// 长轮询由网关按 events.jsonl 的 seq 游标实现，事件到达即返回；工具侧上限 60 秒（见 project-client）。
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { projectGet } from "../lib/project-client"

/** 与契约 ProjectGetArgs 对齐的 zod 形状（测试用同一实例做 fixtures 往返）。 */
export const projectGetArgsSchema = tool.schema.object({
  view: tool.schema.enum(["digest", "node", "events"]).optional().describe("digest（默认）=摘要；node=单节点；events=事件流"),
  node: tool.schema.string().optional().describe("view:\"node\" 时的节点 id（digest 里的节点 id 原样使用）"),
  since: tool.schema.number().int().min(0).optional().describe("view:\"events\" 时的 seq 游标（用回执里的 cursor）"),
  wait_sec: tool.schema.number().min(0).max(90).optional().describe("等待变化的最长秒数（0..90，工具侧上限 60）；事件到达即返回"),
  detail: tool.schema.enum(["summary", "full"]).optional().describe("view:\"node\" 时的详细程度"),
})

export default tool({
  description:
    "读工程图（唯一真相）。开始任何工作前先 view:\"digest\" 看现状（状态计数/失败与阻塞/钉住与漂移/待决问题/预算授权/最近事件）。\n" +
    "· view:\"digest\"：工程摘要，确定性生成，≤6144B。\n" +
    "· view:\"node\" + node:\"<id>\"：单节点详情（params/inputs/outputs/pinned/drift/lastRun/error）；detail:\"full\" 取完整 guidance。\n" +
    "· view:\"events\" + since:<cursor>：seq 之后的事件（≤20 行）。带上回执里的 cursor 继续取，不要从 0 重读。\n" +
    "wait_sec：events/digest 视图可等待变化（0..90，工具侧最多等 60 秒），事件到达即返回；回执的 cursor 是下一次的起点。",
  args: projectGetArgsSchema.shape,
  async execute(args, context) {
    const r = await projectGet(context.sessionID, args)
    if (!r.ok) {
      return fail(r.error?.code ?? "project_get_failed", r.error?.message ?? "工程读取失败", { status: r.status })
    }
    const receipt = r.data ?? {}
    if (receipt.ok !== true) {
      return fail("node_not_found", "节点不存在；先用 view:\"digest\" 看现有节点 id。")
    }
    return ok(receipt as Record<string, unknown>)
  },
})
