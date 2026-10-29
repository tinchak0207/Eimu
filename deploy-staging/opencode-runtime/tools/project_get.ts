// project_get — 读工程图（S9）。三个视图：digest（≤6144B）/ node（≤4096B）/ events（≤20 行，≤2048B）。
// 长轮询由网关按 events.jsonl 的 seq 游标实现，事件到达即返回；工具侧上限 60 秒（见 project-client）。
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { projectGet } from "../lib/project-client"

/** 与契约 ProjectGetArgs 对齐的 zod 形状（测试用同一实例做 fixtures 往返）。 */
export const projectGetArgsSchema = tool.schema.object({
  view: tool.schema.enum(["digest", "node", "events", "brief"]).optional().describe("digest（默认）=摘要；node=单节点；events=事件流；brief=真实原话索引/正文"),
  message_id: tool.schema.string().optional().describe("view:brief指定原话message_id读正文；不填则分页读原话索引"),
  offset: tool.schema.number().int().min(0).optional().describe("brief索引偏移；指定message_id时是正文码点偏移"),
  limit: tool.schema.number().int().min(1).max(1200).optional().describe("brief每页数量，正文最多1200码点，索引最多16条"),
  node: tool.schema.string().optional().describe("view:\"node\" 时的节点 id（digest 里的节点 id 原样使用）"),
  since: tool.schema.number().int().min(0).optional().describe("view:\"events\" 时的 seq 游标（用回执里的 cursor）"),
  wait_sec: tool.schema.number().min(0).max(90).optional().describe("等待变化的最长秒数（0..90，工具侧上限 60）；事件到达即返回"),
  detail: tool.schema.enum(["summary", "full"]).optional().describe("view:\"node\" 时的详细程度"),
})

export default tool({
  description:
    "读工程图（唯一真相）。开始任何工作前先 view:\"digest\" 看现状（状态计数/节点 id 地图/失败与阻塞/钉住与漂移/待决问题/预算授权/最近事件）。digest 已含最近事件，不必再从 0 读 events。\n" +
    "· view:\"digest\"：工程摘要，确定性生成，≤6144B。\n" +
    "· view:\"node\" + node:\"<id>\"：单节点详情（params/inputs/outputs/pinned/drift/lastRun/error）；detail:\"full\" 取完整 guidance。\n" +
    "· view:\"events\" + since:<cursor>：seq 之后的事件（≤20 行）。带上回执里的 cursor 继续取，不要从 0 重读。\n" +
    "· view:\"brief\"：耐久原话索引；加message_id读取真实正文，offset/limit分页，next_offset续读；storage_truncated=true表示存储已缺失一部分，不能宣称完整原文。\n" +
    "wait_sec：events/digest 视图可等待变化（0..90，工具侧最多等 60 秒），事件到达即返回；回执的 cursor 是下一次的起点。",
  args: projectGetArgsSchema.shape,
  async execute(args, context) {
    const r = await projectGet(context.sessionID, args)
    if (!r.ok) {
      return fail(r.error?.code ?? "project_get_failed", r.error?.message ?? "工程读取失败", { status: r.status })
    }
    const receipt = r.data ?? {}
    if (receipt.ok !== true) {
      if (args.view === "brief") return fail("brief_not_found", String((receipt.error as any)?.message ?? "原话不可读，不能当作没有要求"))
      const known = typeof receipt.known === "string" && receipt.known ? `现有节点：${receipt.known}` : "先用 view:\"digest\" 看「节点」一节里的 id。"
      return fail("node_not_found", `节点 ${String(args.node ?? "")} 不存在。${known}`)
    }
    return ok(receipt as Record<string, unknown>)
  },
})
