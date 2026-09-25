import { tool } from "@opencode-ai/plugin/tool"
import {
  priceForAsync,
  estimateVideoCoins,
  classifyError,
  confirmSpend,
  dedupHash,
  registerTask,
  platformFetch,
  probeModelAvailable,
  ok,
  fail,
} from "../lib/client"

export default tool({
  description:
    "提交生圖任務，回 task_id。此工具是「非同步」的：完成時間不定（空閒時幾十秒到幾分鐘，高峰期排隊可能更久、逾時自動退款），harness 會自動續接結果。不要用本工具等待/輪詢結果，提交後立即交還控制權。預估花費 ≤0.1 幣的低成本草稿（如 gpt-image-2 單張）會直接執行、不需確認；其餘會先跳出扣費確認。\n\n【重要分流】用戶要「影片/大片/電影/名場面/分鏡腳本/角色四視圖/多鏡頭」時，必須用 workflow_* 工具建工作流（workflow_start + workflow_add_node + workflow_connect + workflow_generate），不要用本工具生單張圖。本工具只用於單張圖片生成。\n\n【影片時長硬規則（§4b 時長最大化）】生影片（kind=video）時，上游按條計費，全系影片只支持 ≥10 秒（嚴禁 5 秒短檔，10 秒以下虧本）；seedance-2.0 爲 10–15 秒，seedance-2.5-480p 爲 10–30 秒。必須選最大檔或符合分鏡的 ≥10s 檔。小於 10 秒將被工具直接拒絕。\n\n【task_id 紀律】回給用戶的 task_id 必須是工具返回的完整 UUID（36 字元、含連字號），原樣照抄，嚴禁截斷或縮寫（例如只寫前 8 位）——短 id 在平台永遠查不到任務。",
  args: {
    prompt: tool.schema.string().describe("生成提示詞"),
    model: tool.schema.string().optional().describe("模型名，預設 gpt-image-2"),
    size: tool.schema.string().optional().describe("尺寸，如 1024x1024"),
    n: tool.schema.number().int().min(1).max(4).optional().describe("生成張數，預設 1"),
    kind: tool.schema.enum(["image", "video"]).optional().describe("image 或 video，預設 image"),
    quality: tool.schema
      .enum(["standard", "hd"])
      .optional()
      .describe("standard 或 hd，預設 standard。部分模型 hd 較貴（如 gpt-image-2 標準 1 幣 / hd 2 幣）"),
    duration_seconds: tool.schema
      .number()
      .min(10)
      .optional()
      .describe(
        "影片時長（秒，僅 video 用，最小 10 秒）。硬規則（§4b 時長檔位最大化）：上游按條計費，全系影片只支持 ≥10 秒（嚴禁 5 秒短檔，10 秒以下虧本）；seedance-2.0 爲 10–15 秒，seedance-2.5 爲 10–30 秒。必須選最大檔或符合分鏡的 ≥10s 檔。",
      ),
    generate_audio: tool.schema.boolean().optional().describe("是否生成音訊，僅 video 用"),
  },
  async execute(args, context) {
    const model = args.model ?? "gpt-image-2"
    // 模型可用性強制探測（2026-08-15）：不可用不得提交，避免把請求發給壞渠道。
    const probe = await probeModelAvailable(model, context.sessionID, context.abort)
    if (probe.availability === "unavailable") {
      return fail(
        "model_unavailable",
        `模型 ${model} 目前不可用（${probe.note ?? "渠道故障"}）。請改用同類型可用模型，或告知用戶生成服務暫時不可用。`,
      )
    }

    const size = args.size ?? "1024x1024"
    const n = args.n ?? 1
    const kind = args.kind ?? "image"
    const raw_duration = args.duration_seconds
    const generate_audio = args.generate_audio

    // 影片時長硬規則（§4b）：嚴禁 <10 秒短檔
    if (kind === "video") {
      if (typeof raw_duration === "number" && raw_duration < 10) {
        return fail(
          "invalid_duration",
          `時長檔位違規：${raw_duration} 秒過短。平台硬規則（§4b 時長檔位最大化）：上游視頻按條計費，全系影片只支持 ≥10 秒（5 秒/短檔會造成平台虧本且被門禁攔截）。請改用支持的時長檔位（例如 seedance-2.0 爲 10–15 秒，seedance-2.5 爲 10–30 秒），並遵循時長最大化原則。`,
        )
      }
    }
    const duration_seconds = kind === "video" ? (raw_duration ?? 10) : undefined

    // 最近 24h 真實表現提醒（2026-08-27）：可用 ≠ 表現好。樣本 ≥5 且成功率 <50%
    // 時，先勸 agent 換模型而不是把請求發出去（失敗會浪費排隊時間，退款也不補時間）。
    const last24h = probe.last_24h
    if (last24h && last24h.jobs >= 5 && last24h.success_rate < 0.5) {
      return fail(
        "model_low_success_rate",
        `模型 ${model} 探測可用，但最近 24h 真實成功率只有 ${Math.round(last24h.success_rate * 100)}%（${last24h.delivered}/${last24h.jobs} 成功，${last24h.refunded} 筆已退款）。強烈建議改用同類型近期成功率高的模型（可查 /v1/model-status 的 last_24h 對比），或明確告知用戶此模型近期表現差、可能反覆失敗。`,
      )
    }

    // 單價取自平台目錄（權威值），不用本地硬編碼表
    const unit = await priceForAsync(model, context.sessionID, args.quality, context.abort)
    const cost_coins =
      kind === "video"
        ? estimateVideoCoins(duration_seconds, args.quality)
        : Math.round(unit * n * 1e6) / 1e6

    // 扣費閘門：≤0.1 幣的草稿直接放行，其餘需用戶確認
    if (cost_coins > 0.1) {
      const description =
        kind === "video"
          ? `生成 ${duration_seconds ?? 10} 秒视频（${model}），预估花费 ${cost_coins} 币`
          : `生成 ${n} 张图（${model}），预估花费 ${cost_coins} 币`
      const approved = await confirmSpend(
        { sessionID: context.sessionID, amount_coins: cost_coins, description, model },
        context.abort,
      )
      if (!approved) {
        return fail("user_declined", "用戶未確認扣費，已取消。可以改用更便宜的模型或減少張數再試。")
      }
    }

    let poller_ok: boolean | undefined
    let poller_error: string | undefined

    try {
      const endpoint = kind === "video" ? "/videos/generations" : "/images/generations"
      const payload: any =
        kind === "video"
          ? { prompt: args.prompt, model, size, duration_seconds, generate_audio }
          : {
              prompt: args.prompt,
              model,
              size,
              n,
              response_format: "url",
              ...(args.quality ? { quality: args.quality } : {}),
            }

      const resp = await platformFetch(
        endpoint,
        { method: "POST", body: JSON.stringify(payload) },
        context.sessionID,
        context.abort,
      )
      const data = await resp.json().catch(() => ({}))
      const task_id = data?.task_id ?? data?.id ?? null

      if (resp.status === 202 || (resp.ok && task_id)) {
        if (task_id) {
          // 註冊給 poller 自動輪詢；best-effort，失敗不影響主流程。
          // dedup_hash 讓 poller 能認出「同一個請求重送」直接回快取（0 幣），
          // cost_coins 讓 poller 續接時發得出正確金額（平台輪詢回應不含價格）。
          const reg = await registerTask(task_id, context.sessionID, kind, context.abort, {
            dedup_hash: dedupHash({ model, prompt: args.prompt, size, n }),
            model,
            cost_coins,
          })
          poller_ok = reg.ok
          poller_error = reg.error
        }
        return ok(
          {
            task_id: task_id ?? null,
            kind,
            model,
            estimated_cost_coins: cost_coins,
            note: "已提交。完成時間不定：空閒時通常幾十秒到幾分鐘，高峰期可能排隊更久，逾時會自動退款——對用戶報耗時時用這個分檔說法，不要報精確秒數。harness 會自動續接結果。不要輪詢。回報 task_id 給用戶時必須原樣照抄完整 UUID（36 字元含連字號），嚴禁截斷成前 8 位——短 id 在平台查不到任務。",
          },
          { poller_ok, poller_error },
        )
      }

      // 部分實作可能同步直接回圖，兜底處理
      if (resp.ok) {
        const url = data?.data?.[0]?.url || data?.result_url || data?.url
        if (url) {
          return ok({
            url,
            task_id: data?.id ?? null,
            kind,
            model,
            estimated_cost_coins: cost_coins,
          })
        }
      }

      const err = await classifyError(resp, data)
      return fail(err.code, err.hint, { retry_after_ms: err.retry_after_ms })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint)
    }
  },
})
