// project_run — 跑工程图（S9）。准入（可运行性/报价/预算/确认）全在网关 S6；
// 工具只提交请求并转述回执。非 dry_run 的执行链在网关后台跑，回执 status=started，
// 用 project_get(view:"events", since:cursor, wait_sec:N) 等结果；dry_run 只回报价。
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { projectRun } from "../lib/project-client"

/** 与契约 ProjectRunArgs 对齐的 zod 形状（测试用同一实例做 fixtures 往返）。 */
export const projectRunArgsSchema = tool.schema.object({
  targets: tool.schema.array(tool.schema.string()).optional().describe("要跑的节点 id；省略=全图（只跑签名变化的）"),
  mode: tool.schema.enum(["incremental", "force"]).optional().describe("incremental（默认）只跑变化；force 强制重跑 targets 及其下游"),
  dry_run: tool.schema.boolean().optional().describe("true = 只报价，不提交任何生成"),
  budget_coins: tool.schema.number().min(0).optional().describe("本次运行的钱上限（与工程预算取小）"),
  wait_sec: tool.schema.number().min(0).max(90).optional().describe("等待本轮结束的秒数（工具侧上限 60）；到点未完成回 running，用 cursor 继续看"),
})

export default tool({
  description:
    "运行工程图：按签名增量执行（命中缓存的节点不重跑、不重复扣费）。targets 省略=全图。\n" +
    "dry_run:true 只回报价（quote.coins/run/reuse/pinned/unknownPrice），不提交任何生成。\n" +
    "回执 status：quoted（仅报价）/started（后台已开跑）/running/done/partial/failed/needs_user（等用户确认花费）/rejected（附 reason）。" +
    "status=needs_user 时不要重复提交同一笔；把 reason 里的 request_id 原样转述给用户，确认后再次 project_run 即可续上。\n" +
    "跑完看 project_get(view:\"events\", since:cursor)；交付只认 export 节点的产物。",
  args: projectRunArgsSchema.shape,
  async execute(args, context) {
    const r = await projectRun(context.sessionID, args)
    if (!r.ok) {
      return fail(r.error?.code ?? "project_run_failed", r.error?.message ?? "运行请求失败", { status: r.status })
    }
    return ok(r.data ?? {})
  },
})
