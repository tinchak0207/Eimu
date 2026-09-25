import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description:
    "查詢影片模型列表與幣值成本（報價用，免費不扣費）。與 image_quote 對偶：本工具只回影片模型（mediaType=video）。**報價硬規則：只有 availability=available 的模型才允許寫進任何計劃/預算/推薦——availability=unavailable 的模型就是模型選擇器裡灰掉的那些，引用即欺客**。注意 upstream_billing：per_task=按條計費（seedance-2.0 系，5s/15s 同價，短片不省錢）；per_second=按秒計費（seedance-2.5 系等）。報價必須先看這個字段再乘單價，否則會報錯價。要生成影片時先用本工具查模型與單價，再用 workflow_* 工具或 image_generate kind=video 提交。查圖片模型請用 image_quote。",
  args: {
    model: tool.schema.string().optional().describe("若指定則只回這個影片模型的定價"),
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
      const statusResp = await platformFetch("/model-status", {}, context.sessionID, context.abort).catch(() => null)
      const statusBody = statusResp && statusResp.ok ? await statusResp.json().catch(() => ({})) : {}
      const statusList: any[] = statusBody?.models ?? []
      const availabilityById = new Map<string, { availability: string; note: string | null }>()
      for (const s of statusList) {
        if (s?.id) availabilityById.set(s.id, { availability: s.availability ?? "unknown", note: s.note ?? null })
      }
      const models = list
        .map((m: any) => ({
          id: m?.id,
          name: m?.name || m?.id,
          coins_per_second: m?.x_coins_per_second ?? null,
          capabilities: m?.x_capabilities ?? m?.capabilities ?? m?.supported_tasks ?? null,
        }))
        .filter((m: any) => m?.id)
        // 影片報價工具只列影片模型：非 video 一律剔除（含 args.model 指定圖片模型時回空，
        // 讓 agent 知道該模型不是影片模型；圖片報價請用 image_quote）。
        .filter((m: any) => m.capabilities?.mediaType === "video")
        .filter((m: any) => (args.model ? m.id === args.model : true))
        .map((m: any) => ({
          ...m,
          resolutions: m.capabilities?.resolutions ?? [],
          durations: m.capabilities?.durations ?? [],
          audio: m.capabilities?.audio ?? false,
          reference_images: m.capabilities?.referenceImages ?? false,
          default_resolution: m.capabilities?.defaultResolution ?? null,
          default_duration: m.capabilities?.defaultDuration ?? null,
        }))
        .map((m: any) => {
          const cps = m.coins_per_second as Record<string, number> | null | undefined
          const defRes = m.default_resolution as string | null
          const defaultRate = cps && defRes && typeof cps[defRes] === "number" ? cps[defRes] : null
          // INC-0830：計費方式標註——seedance-2.0 系上游按條統一價（5s/15s 同價），
          // 報價若按秒乘會算錯；seedance-2.5 系按秒；其他模型無實據回 null。
          const billing = /^seedance-2\.0/.test(m.id) ? "per_task" : /^seedance-2\.5/.test(m.id) ? "per_second" : null
          const status = availabilityById.get(m.id)
          const availability = status?.availability ?? "unknown"
          return {
            id: m.id,
            name: m.name,
            availability,
            note: status?.note,
            upstream_billing: billing,
            coins_per_second: m.coins_per_second,
            resolutions: m.resolutions,
            durations: m.durations,
            audio: m.audio,
            reference_images: m.reference_images,
            default_resolution: m.default_resolution,
            default_duration: m.default_duration,
            default_coins_per_second: defaultRate,
          }
        })
        // 可用優先排序：available 在前，unavailable/unknown 沉底——但保留在列表裡
        // 並帶明確死因，讓 agent 知道模型存在但當下不可薦。
        .sort((a: any, b: any) => {
          const rank = (x: any) => (x.availability === "available" ? 0 : 1)
          return rank(a) - rank(b) || a.id.localeCompare(b.id)
        })

      const available = models.filter((m: any) => m.availability === "available").map((m: any) => m.id)
      return ok({
        title: "影片模型報價",
        models,
        available_models: available,
        currency: "coins",
        pricing_note:
          "影片計費先看 upstream_billing：per_task=按條統一價（如 seedance-2.0 系，5s/15s 同價，報價=單價×條數，缺時長照樣按條扣，短片不省錢）；per_second=按秒（coins_per_second 依解析度分檔，總價=單價×時長）。其他模型字段為 null 時以平台實扣為准。**計劃/預算/推薦只准用 available_models 裡的模型——availability=unavailable 的模型（模型選擇器已灰）寫進計劃=向用戶報虛價**。生成影片用 workflow_* 工具或 image_generate kind=video，shot JSON 必填 output.duration_seconds。圖片模型請用 image_quote。",
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查詢失敗" })
    }
  },
})