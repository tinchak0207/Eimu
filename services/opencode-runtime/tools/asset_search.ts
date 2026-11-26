import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description: "接到建模/同形场景/风格复用/找素材请求，先 asset_search 查 blender-3d-assets 包与用户资产包，查空才自造（免费不扣费）。用户说「用我上次保存的/我的素材/我的风格」时也用本工具。",
  args: {
    query: tool.schema
      .string()
      .optional()
      .describe("搜索关键词（标题/标签/摘要），不填则列出全部"),
    limit: tool.schema
      .number()
      .optional()
      .describe("返回数量上限，默认 20，最大 50"),
  },
  async execute(args, context) {
    try {
      const limit = Math.max(1, Math.min(50, args.limit ?? 20))
      const resp = await platformFetch(
        `/assets?q=${encodeURIComponent(args.query ?? "")}&limit=${limit}`,
        {},
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))

      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查询失败" })
      }

      return ok({
        title: "资产包列表",
        packs: (body.packs ?? []).map((p: any) => ({
          id: p.id,
          title: p.title,
          itemCount: p.items?.length ?? 0,
          digest: p.digest ?? null,
          active: p.active === true,
        })),
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询失败" })
    }
  },
})