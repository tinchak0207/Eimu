import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description:
    "查詢圖片模型列表、每張圖片的幣值成本與當下可用性（報價用，免費不扣費）。**選模硬規則：只從 available_models 裡挑（已按近 24h 真實交付排序，proven_models＝近 24h 真出過圖的，優先用）；availability=unavailable 的模型（無可用渠道／供應商停用／近期 0% 成功）不准提交、不准逐檔試，試了只會白燒時間**。與 video_quote 同源判活（/v1/model-status）。",
  args: {
    model: tool.schema.string().optional().describe("若指定則只回這個模型的定價"),
  },
  async execute(args, context) {
    try {
      const resp = await platformFetch("/models", {}, context.sessionID, context.abort)
      const body = await resp.json().catch(() => ({}))

      if (!resp.ok) {
        const err = await classifyError(resp, body)
        return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms, title: "查詢失敗" })
      }

      const list = body?.data || body?.models || (Array.isArray(body) ? body : [])
      // 判活源（/v1/model-status）：availability 是唯一可推薦依據，靜態目錄不分死活。
      // 2026-10-02 事故：本工具不讀判活源，agent 逐檔試 flux／gpt-image-1.5／image-5-pro
      // （全是「无可用渠道」），得出「圖片通道大面積故障」的錯誤結論。
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
          // 平台 /v1/models 的欄位是 x_capabilities（含 mediaType）；舊代碼抄成
          // m.capabilities（恒 undefined）→ capabilities 恒 null，agent 分不清
          // 圖片/視頻模型，才會拿 seedance-2.0 當圖片報價（2026-08-29 實錘）。
          capabilities: m?.x_capabilities ?? m?.capabilities ?? m?.supported_tasks ?? null,
        }))
        .filter((m: any) => m?.id)
        // 圖片報價工具只該列圖片模型：明確標成 video 的一律剔除（含 args.model
        // 指定視頻模型時也回空，讓 agent 知道該模型不能當圖片報價）。
        .filter((m: any) => !m.capabilities || m.capabilities?.mediaType !== "video")
        .filter((m: any) => (args.model ? m.id === args.model : true))
        .map((m: any) => {
          const s = statusById.get(m.id)
          // 真實結果優先於探測：探測只驗「渠道 /models 回 200」，不驗渠道是否還供該模型
          // （2026-10-02 實錘：hub.linux.do 已下架全部圖片模型，gemini/gpt-image-2.5 系
          // 仍被報 available，真單 100% 422 model not found）。近 24h 有單且 0 交付＝不可薦。
          const jobs = Number(s?.last_24h?.jobs ?? 0)
          const delivered = Number(s?.last_24h?.delivered ?? 0)
          if (s?.availability === "available" && jobs > 0 && delivered === 0) {
            return {
              ...m,
              availability: "unavailable",
              note: `探測顯示渠道可達，但近 24h 真實 ${jobs} 單 0 交付——當作不可用，請換 proven_models`,
              last_24h: s.last_24h,
            }
          }
          return {
            ...m,
            availability: s?.availability ?? "unknown",
            note: s?.note ?? null,
            // 近 24h 真實表現（樣本不足時欄位缺省＝沒數據，不是 0%）。
            last_24h: s?.last_24h ?? null,
          }
        })
        // 排序：available 在前；available 內按近 24h 真實交付數降序（真出過圖的最可信）。
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
        title: "模型報價",
        models,
        available_models: available,
        proven_models: proven,
        unavailable_models: unavailable,
        currency: "coins",
        availability_note: statusKnown
          ? "選模只准用 available_models（proven_models 優先）；unavailable_models 列出的模型提交必失敗，不要逐檔試。圖片通道是否「整體故障」只看 available_models 是否為空，不看死模型。"
          : "判活源 /v1/model-status 暫時讀不到，availability 一律 unknown——此時以 image_generate 真實回執為準，不要據此斷言圖片通道整體故障。",
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查詢失敗" })
    }
  },
})
