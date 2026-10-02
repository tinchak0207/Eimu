import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description:
    "查詢影片模型列表與幣值成本（報價用，免費不扣費）。與 image_quote 對偶：本工具只回影片模型（mediaType=video）。**報價硬規則：只有 availability=available 的模型才允許寫進任何計劃/預算/推薦——availability=unavailable 的模型就是模型選擇器裡灰掉的那些，引用即欺客**。**計費口徑（R9-A2，與平台實扣同源）：全部影片模型（含 seedance-2.0 系）都按秒扣費——總價 = coins_per_second[解析度] × 時長（秒）；15s 比 10s 貴 1.5 倍，不存在「5s/15s 同價」。billing=per_second（目錄無秒價表時為 null）；未指定解析度時平台按 default_resolution 扣，開音軌且有 coins_per_second_with_audio 時按帶音價。** **提交前預檢：prompt_char_limit（默認 4000 字元，超限即 400 prompt_too_long）與 duration_slots（離散時長檔）——多鏡合條先數字符、目標時長先對檔位，換模時必連這兩項一起預檢**。要生成影片時先用本工具查模型與單價，再用 workflow_* 工具或 image_generate kind=video 提交。查圖片模型請用 image_quote。",
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
      const statusById = new Map<string, any>()
      for (const s of statusList) if (s?.id) statusById.set(s.id, s)
      const statusKnown = statusById.size > 0
      const models = list
        .map((m: any) => ({
          id: m?.id,
          name: m?.name || m?.id,
          coins_per_second: m?.x_coins_per_second ?? null,
          coins_per_second_with_audio: m?.x_coins_per_second_with_audio ?? null,
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
          // 刀2（2026-09-20）：prompt 字元硬上限——站點 x_capabilities.promptCharLimit 投射
          // （實測 4000：4000→202、4001→400 prompt_too_long）。舊站點未投射時回 null，
          // agent 須知 null≠無限，提交前仍應自檢拼裝長度。
          prompt_char_limit: m.capabilities?.promptCharLimit ?? null,
        }))
        .map((m: any) => {
          const cps = m.coins_per_second as Record<string, number> | null | undefined
          const defRes = m.default_resolution as string | null
          const defaultRate = cps && defRes && typeof cps[defRes] === "number" ? cps[defRes] : null
          // R9-A2（2026-09-30）：計費口徑以平台實扣為準——/v1/videos/generations 以
          // generationCoins(model,{resolution,durationSeconds}) 扣費＝目錄秒價 × 時長，gateway
          // catalogVideoPerSecondCoins 同源。舊 INC-0830 把 seedance-2.0 標 per_task「5s/15s 同價」
          // 是上游成本口徑，與用戶實扣矛盾（15s 報 130、實扣 195），已撤。無秒價表回 null。
          const billing = cps && Object.keys(cps).length ? "per_second" : null
          const status = statusById.get(m.id)
          // 真實結果優先於探測（同 image_quote）：近 24h 有單且 0 交付＝不可薦。
          const jobs = Number(status?.last_24h?.jobs ?? 0)
          const delivered = Number(status?.last_24h?.delivered ?? 0)
          const demoted = status?.availability === "available" && jobs > 0 && delivered === 0
          const availability = demoted ? "unavailable" : (status?.availability ?? "unknown")
          const note = demoted
            ? `探測顯示渠道可達，但近 24h 真實 ${jobs} 單 0 交付——當作不可用，請換 proven_models`
            : (status?.note ?? null)
          return {
            id: m.id,
            name: m.name,
            availability,
            note,
            // 近 24h 真實表現（樣本不足時欄位缺省＝沒數據，不是 0%）。
            last_24h: status?.last_24h ?? null,
            billing,
            coins_per_second: m.coins_per_second,
            coins_per_second_with_audio: m.coins_per_second_with_audio,
            resolutions: m.resolutions,
            durations: m.durations,
            audio: m.audio,
            reference_images: m.reference_images,
            default_resolution: m.default_resolution,
            default_duration: m.default_duration,
            default_coins_per_second: defaultRate,
            prompt_char_limit: m.prompt_char_limit,
            // 刀2（2026-09-20）：時長檔位口徑顯式化——durations 是離散檔清單（如
            // seedance-2.5-720p 為 10–29s 無 30s 檔）；prompt_char_limit 是提交前
            // 必檢欄，超限即 400 prompt_too_long，換模時連上限一起預檢。
            duration_slots: m.durations,
          }
        })
        // 可用優先排序：available 在前，unavailable/unknown 沉底——但保留在列表裡
        // 並帶明確死因，讓 agent 知道模型存在但當下不可薦。
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
      // 降級警示：有 available 但近 24h 零交付＝只有探測、無真實交付證據，不得作承諾依據。
      const zeroDelivery24h = available.length > 0 && proven.length === 0
      const evidence_warning = !statusKnown
        ? "判活源 /v1/model-status 讀不到，availability 一律 unknown——不得作承諾依據，以真實回執為準。"
        : zeroDelivery24h
          ? "近 24h 零真實交付（proven_models 為空）：available 僅代表探測可達，沒有交付證據——不得作為承諾依據；開跑付費生成前須向使用者說明並取得顯式確認。"
          : null
      return ok({
        title: "影片模型報價",
        models,
        available_models: available,
        proven_models: proven,
        unavailable_models: unavailable,
        evidence_warning,
        currency: "coins",
        pricing_note:
          "影片一律按秒扣費（billing=per_second，與平台實扣同源）：總價 = coins_per_second[解析度] × 時長（秒）× 條數；未指定解析度按 default_resolution，開音軌且 coins_per_second_with_audio 非 null 時用帶音價。例：seedance-2.0 720p 13 幣/秒 → 10s=130、15s=195（不是同價）。批量預算用 quote_bundle（同口徑）。billing 為 null＝目錄無秒價，以平台實扣為准並對用戶標「待確認」。**計劃/預算/推薦只准用 available_models 裡的模型（proven_models＝近 24h 真出過片的，優先；為空時見 evidence_warning，不得作承諾依據）——availability=unavailable 的模型（模型選擇器已灰）寫進計劃=向用戶報虛價**。**提交前必檢 prompt_char_limit（默認 4000）：拼裝 prompt 超限必被 400 prompt_too_long 拒收，多鏡合條先數字符；duration_slots 是離散時長檔（如 720p 檔 10–29s 無 30s），目標時長不在檔內即換檔或拆條**。生成影片用 workflow_* 工具或 image_generate kind=video，shot JSON 必填 output.duration_seconds。圖片模型請用 image_quote。",
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查詢失敗" })
    }
  },
})