import { tool } from "@opencode-ai/plugin/tool"
import {
  classifyError,
  confirmSpend,
  emitEvent,
  estimateUpscaleCoins,
  platformFetch,
  probeModelAvailable,
  randomUUID,
  resolveMediaId,
  ok,
  fail,
} from "../lib/client"

export default tool({
  description:
    "放大图片（同步 ~20s）。超过 0.1 币会先跳出扣费确认，用户确认后才执行。",
  args: {
    image_url: tool.schema.string().describe("原图 URL"),
    scale: tool.schema.number().optional().describe("放大倍数，预设 2"),
    model: tool.schema.string().optional().describe("放大模型名，省略则用平台预设"),
  },
  async execute(args, context) {
    const scale = args.scale ?? 2
    // 模型可用性强制探测（仅当指定了 model；省略时平台预设）
    if (args.model) {
      const probe = await probeModelAvailable(args.model, context.sessionID, context.abort)
      if (probe.availability === "unavailable") {
        return fail(
          "model_unavailable",
          `放大模型 ${args.model} 目前不可用（${probe.note ?? "渠道故障"}）。请改用其他可用模型，或告知用户。`,
        )
      }
    }
    try {
      const image = await resolveMediaId(args.image_url, context.sessionID, context.abort)

      // 扣费闸门：单价取自平台目录；≤0.1 币属免确认的低价探索区间。
      // 没给 model 时 priceForAsync 取不到目录项，回保守的 FALLBACK_COINS（1 币），
      // 会落在确认区间 —— 宁可多问一次，不要少扣费提示。
      const estimate = await estimateUpscaleCoins(args.model ?? "", context.sessionID, undefined, context.abort)
      const request_id = randomUUID()
      if (estimate > 0.1) {
        const approved = await confirmSpend(
          {
            sessionID: context.sessionID,
            amount_coins: estimate,
            description: `放大 ${scale}x，预估花费 ${estimate} 币`,
            model: args.model,
            request_id,
          },
          context.abort,
        )
        if (!approved) {
          return fail("user_declined", "用户未确认扣费，已取消。可以改用更便宜的模型或减少张数再试。")
        }
      }

      const resp = await platformFetch(
        "/upscale",
        {
          method: "POST",
          headers: { "idempotency-key": request_id }, // PRD §152：重试不重复扣费
          body: JSON.stringify({ image, factor: scale, ...(args.model ? { model: args.model } : {}) }),
        },
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "放大失败" })
      }

      const url = body?.data?.[0]?.url || body?.result_url || body?.url
      const cost_coins = body?.cost_coins ?? body?.x_cost_coins ?? estimate
      // 同步回图，立即推前端图片卡；fire-and-forget，失败不影响 tool
      emitEvent(context.sessionID, "image.done", { url, cost_coins, task_id: request_id }, context.abort).catch(
        () => {},
      )
      return ok({ title: "放大完成", url, cost_coins })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "放大失败" })
    }
  },
})
