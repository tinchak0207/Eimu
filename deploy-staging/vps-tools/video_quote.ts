import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, ok, fail } from "../lib/client"

export default tool({
  description:
    "查询影片模型列表与币值成本（报价用，免费不扣费）。与 image_quote 对偶：本工具只回影片模型（mediaType=video）。**报价硬规则：只有 availability=available 的模型才允许写进任何计划/预算/推荐——availability=unavailable 的模型就是模型选择器里灰掉的那些，引用即欺客**。**计费口径（R9-A2，与平台实扣同源）：全部影片模型（含 seedance-2.0 系）都按秒扣费——总价 = coins_per_second[解析度] × 时长（秒）；15s 比 10s 贵 1.5 倍，不存在「5s/15s 同价」。billing=per_second（目录无秒价表时为 null）；未指定解析度时平台按 default_resolution 扣，开音轨且有 coins_per_second_with_audio 时按带音价。** **提交前预检：prompt_char_limit（默认 4000 字元，超限即 400 prompt_too_long）与 duration_slots（离散时长档）——多镜合条先数字符、目标时长先对档位，换模时必连这两项一起预检**。要生成影片时先用本工具查模型与单价，再用 workflow_* 工具或 image_generate kind=video 提交。查图片模型请用 image_quote。",
  args: {
    model: tool.schema.string().optional().describe("若指定则只回这个影片模型的定价"),
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
        // 影片报价工具只列影片模型：非 video 一律剔除（含 args.model 指定图片模型时回空，
        // 让 agent 知道该模型不是影片模型；图片报价请用 image_quote）。
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
          // 刀2（2026-09-20）：prompt 字元硬上限——站点 x_capabilities.promptCharLimit 投射
          // （实测 4000：4000→202、4001→400 prompt_too_long）。旧站点未投射时回 null，
          // agent 须知 null≠无限，提交前仍应自检拼装长度。
          prompt_char_limit: m.capabilities?.promptCharLimit ?? null,
        }))
        .map((m: any) => {
          const cps = m.coins_per_second as Record<string, number> | null | undefined
          const defRes = m.default_resolution as string | null
          const defaultRate = cps && defRes && typeof cps[defRes] === "number" ? cps[defRes] : null
          // R9-A2（2026-09-30）：计费口径以平台实扣为准——/v1/videos/generations 以
          // generationCoins(model,{resolution,durationSeconds}) 扣费＝目录秒价 × 时长，gateway
          // catalogVideoPerSecondCoins 同源。旧 INC-0830 把 seedance-2.0 标 per_task「5s/15s 同价」
          // 是上游成本口径，与用户实扣矛盾（15s 报 130、实扣 195），已撤。无秒价表回 null。
          const billing = cps && Object.keys(cps).length ? "per_second" : null
          const status = statusById.get(m.id)
          // 真实结果优先于探测（同 image_quote）：近 24h 有单且 0 交付＝不可荐。
          const jobs = Number(status?.last_24h?.jobs ?? 0)
          const delivered = Number(status?.last_24h?.delivered ?? 0)
          const demoted = status?.availability === "available" && jobs > 0 && delivered === 0
          const availability = demoted ? "unavailable" : (status?.availability ?? "unknown")
          const note = demoted
            ? `探测显示渠道可达，但近 24h 真实 ${jobs} 单 0 交付——当作不可用，请换 proven_models`
            : (status?.note ?? null)
          return {
            id: m.id,
            name: m.name,
            availability,
            note,
            // 近 24h 真实表现（样本不足时栏位缺省＝没数据，不是 0%）。
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
            // 刀2（2026-09-20）：时长档位口径显式化——durations 是离散档清单（如
            // seedance-2.5-720p 为 10–29s 无 30s 档）；prompt_char_limit 是提交前
            // 必检栏，超限即 400 prompt_too_long，换模时连上限一起预检。
            duration_slots: m.durations,
          }
        })
        // 可用优先排序：available 在前，unavailable/unknown 沉底——但保留在列表里
        // 并带明确死因，让 agent 知道模型存在但当下不可荐。
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
      // 降级警示：有 available 但近 24h 零交付＝只有探测、无真实交付证据，不得作承诺依据。
      const zeroDelivery24h = available.length > 0 && proven.length === 0
      const evidence_warning = !statusKnown
        ? "判活源 /v1/model-status 读不到，availability 一律 unknown——不得作承诺依据，以真实回执为准。"
        : zeroDelivery24h
          ? "近 24h 零真实交付（proven_models 为空）：available 仅代表探测可达，没有交付证据——不得作为承诺依据；开跑付费生成前须向使用者说明并取得显式确认。"
          : null
      return ok({
        title: "影片模型报价",
        models,
        available_models: available,
        proven_models: proven,
        unavailable_models: unavailable,
        evidence_warning,
        currency: "coins",
        pricing_note:
          "影片一律按秒扣费（billing=per_second，与平台实扣同源）：总价 = coins_per_second[解析度] × 时长（秒）× 条数；未指定解析度按 default_resolution，开音轨且 coins_per_second_with_audio 非 null 时用带音价。例：seedance-2.0 720p 13 币/秒 → 10s=130、15s=195（不是同价）。批量预算用 quote_bundle（同口径）。billing 为 null＝目录无秒价，以平台实扣为准并对用户标「待确认」。**计划/预算/推荐只准用 available_models 里的模型（proven_models＝近 24h 真出过片的，优先；为空时见 evidence_warning，不得作承诺依据）——availability=unavailable 的模型（模型选择器已灰）写进计划=向用户报虚价**。**提交前必检 prompt_char_limit（默认 4000）：拼装 prompt 超限必被 400 prompt_too_long 拒收，多镜合条先数字符；duration_slots 是离散时长档（如 720p 档 10–29s 无 30s），目标时长不在档内即换档或拆条**。生成影片用 workflow_* 工具或 image_generate kind=video，shot JSON 必填 output.duration_seconds。图片模型请用 image_quote。",
      })
    } catch (e: any) {
      const err = await classifyError(null, e)
      return fail(err.code, err.hint, { title: "查询失败" })
    }
  },
})