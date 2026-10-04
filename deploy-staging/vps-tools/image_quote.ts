import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description:
    "查询图片模型列表、每张图片的币值成本与当下可用性（报价用，免费不扣费）。**选模硬规则：只从 available_models 里挑（已按近 24h 真实交付排序，proven_models＝近 24h 真出过图的，优先用）；availability=unavailable 的模型（无可用渠道／供应商停用／近期 0% 成功）不准提交、不准逐档试，试了只会白烧时间**。与 video_quote 同源判活（/v1/model-status）。",
  args: {
    model: tool.schema.string().optional().describe("若指定则只回这个模型的定价"),
  },
  async execute(args, context) {
    try {
      const resp = await platformFetch("/models", {}, context.sessionID, context.abort)
      const body = await resp.json().catch(() => ({}))

      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查询失败" })
      }

      const list = body?.data || body?.models || (Array.isArray(body) ? body : [])
      // 判活源（/v1/model-status）：availability 是唯一可推荐依据，静态目录不分死活。
      // 2026-10-02 事故：本工具不读判活源，agent 逐档试 flux／gpt-image-1.5／image-5-pro
      // （全是「无可用渠道」），得出「图片通道大面积故障」的错误结论。
      const statusResp = await platformFetch("/model-status", {}, context.sessionID, context.abort).catch(() => null)
      const statusBody = statusResp && statusResp.ok ? await statusResp.json().catch(() => ({})) : {}
      const statusList: any[] = statusBody?.models ?? []
      const statusById = new Map<string, any>()
      for (const s of statusList) if (s?.id) statusById.set(s.id, s)
      const statusKnown = statusById.size > 0

      const models = list
        .map((m: any) => ({
          id: m?.id,
          name: m?.name || m?.id,
          coins_per_image:
            m?.x_coins_per_image ?? m?.coins_per_image ?? m?.price_coins ?? m?.cost ?? null,
          // 平台 /v1/models 的栏位是 x_capabilities（含 mediaType）；旧代码抄成
          // m.capabilities（恒 undefined）→ capabilities 恒 null，agent 分不清
          // 图片/视频模型，才会拿 seedance-2.0 当图片报价（2026-08-29 实锤）。
          capabilities: m?.x_capabilities ?? m?.capabilities ?? m?.supported_tasks ?? null,
        }))
        .filter((m: any) => m?.id)
        // 图片报价工具只该列图片模型：明确标成 video 的一律剔除（含 args.model
        // 指定视频模型时也回空，让 agent 知道该模型不能当图片报价）。
        .filter((m: any) => !m.capabilities || m.capabilities?.mediaType !== "video")
        .filter((m: any) => (args.model ? m.id === args.model : true))
        .map((m: any) => {
          const s = statusById.get(m.id)
          // 真实结果优先于探测：探测只验「渠道 /models 回 200」，不验渠道是否还供该模型
          // （2026-10-02 实锤：hub.linux.do 已下架全部图片模型，gemini/gpt-image-2.5 系
          // 仍被报 available，真单 100% 422 model not found）。近 24h 有单且 0 交付＝不可荐。
          const jobs = Number(s?.last_24h?.jobs ?? 0)
          const delivered = Number(s?.last_24h?.delivered ?? 0)
          if (s?.availability === "available" && jobs > 0 && delivered === 0) {
            return {
              ...m,
              availability: "unavailable",
              note: `探测显示渠道可达，但近 24h 真实 ${jobs} 单 0 交付——当作不可用，请换 proven_models`,
              last_24h: s.last_24h,
            }
          }
          return {
            ...m,
            availability: s?.availability ?? "unknown",
            note: s?.note ?? null,
            // 近 24h 真实表现（样本不足时栏位缺省＝没数据，不是 0%）。
            last_24h: s?.last_24h ?? null,
          }
        })
        // 排序：available 在前；available 内按近 24h 真实交付数降序（真出过图的最可信）。
        .sort((a: any, b: any) => {
          const rank = (x: any) => (x.availability === "available" ? 0 : 1)
          const delivered = (x: any) => Number(x.last_24h?.delivered ?? 0)
          return rank(a) - rank(b) || delivered(b) - delivered(a) || a.id.localeCompare(b.id)
        })

      const available = models.filter((m: any) => m.availability === "available").map((m: any) => m.id)
      const proven = models
        .filter((m: any) => m.availability === "available" && Number(m.last_24h?.delivered ?? 0) > 0)
        .map((m: any) => m.id)
      const unavailable = models
        .filter((m: any) => m.availability === "unavailable")
        .map((m: any) => `${m.id}（${m.note ?? "不可用"}）`)

      return ok({
        title: "模型报价",
        models,
        available_models: available,
        proven_models: proven,
        unavailable_models: unavailable,
        currency: "coins",
        availability_note: statusKnown
          ? "选模只准用 available_models（proven_models 优先）；unavailable_models 列出的模型提交必失败，不要逐档试。图片通道是否「整体故障」只看 available_models 是否为空，不看死模型。"
          : "判活源 /v1/model-status 暂时读不到，availability 一律 unknown——此时以 image_generate 真实回执为准，不要据此断言图片通道整体故障。",
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询失败" })
    }
  },
})
