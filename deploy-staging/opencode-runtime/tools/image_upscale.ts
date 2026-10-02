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
    "放大圖片（同步 ~20s）。超過 0.1 幣會先跳出扣費確認，用戶確認後才執行。",
  args: {
    image_url: tool.schema.string().describe("原圖 URL"),
    scale: tool.schema.number().optional().describe("放大倍數，預設 2"),
    model: tool.schema.string().optional().describe("放大模型名，省略則用平台預設"),
  },
  async execute(args, context) {
    const scale = args.scale ?? 2
    // 模型可用性強制探測（僅當指定了 model；省略時平台預設）
    if (args.model) {
      const probe = await probeModelAvailable(args.model, context.sessionID, context.abort)
      if (probe.availability === "unavailable") {
        return fail(
          "model_unavailable",
          `放大模型 ${args.model} 目前不可用（${probe.note ?? "渠道故障"}）。請改用其他可用模型，或告知用戶。`,
        )
      }
    }
    try {
      const image = await resolveMediaId(args.image_url, context.sessionID, context.abort)

      // 扣費閘門：單價取自平台目錄；≤0.1 幣屬免確認的低價探索區間。
      // 沒給 model 時 priceForAsync 取不到目錄項，回保守的 FALLBACK_COINS（1 幣），
      // 會落在確認區間 —— 寧可多問一次，不要少扣費提示。
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
          return fail("user_declined", "用戶未確認扣費，已取消。可以改用更便宜的模型或減少張數再試。")
        }
      }

      const resp = await platformFetch(
        "/upscale",
        {
          method: "POST",
          headers: { "idempotency-key": request_id }, // PRD §152：重試不重複扣費
          body: JSON.stringify({ image, factor: scale, ...(args.model ? { model: args.model } : {}) }),
        },
        context.sessionID,
        context.abort,
      )
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "放大失敗" })
      }

      const url = body?.data?.[0]?.url || body?.result_url || body?.url
      const cost_coins = body?.cost_coins ?? body?.x_cost_coins ?? estimate
      // 同步回圖，立即推前端圖片卡；fire-and-forget，失敗不影響 tool
      emitEvent(context.sessionID, "image.done", { url, cost_coins, task_id: request_id }, context.abort).catch(
        () => {},
      )
      return ok({ title: "放大完成", url, cost_coins })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "放大失敗" })
    }
  },
})
