import { tool } from "@opencode-ai/plugin/tool"
import { loadCatalog, platformFetch, ok, fail } from "../lib/client"

// 批量预算单：多笔生成任务一次性估价（明细 + 总价）＋钱包对帐。
// 图片单价：loadCatalog（GET /v1/models 的 x_coins_per_image，10 分钟快取），与 image_generate 同源。
// 影片报价读x_billing完整档位金额；未知回null，固定价不按秒放大，不使用粗估fallback。
// 余额：GET /v1/quota（与 gateway fetchBalance 同源），回应带 balance/shortfall/affordable。

type VideoEntry = { cps: Record<string, number>; billing: Record<string, any>; defaultResolution: string | null; defaultDuration: number | null; defaultAudio: boolean; audio: boolean }

async function loadVideoCatalog(sessionID: string, signal?: AbortSignal): Promise<Record<string, VideoEntry> | null> {
  try {
    const res = await platformFetch("/models", { method: "GET" }, sessionID, signal)
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<Record<string, any>> }
    const out: Record<string, VideoEntry> = {}
    for (const m of body.data ?? []) {
      if (typeof m?.id !== "string") continue
      const raw = m.x_coins_per_second
      if (!m.x_billing || typeof m.x_billing !== "object") continue
      const cps: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === "number") cps[k.toLowerCase()] = v
      const cap = m.x_capabilities ?? {}
      out[m.id] = {
        cps,
        billing: m.x_billing,
        defaultAudio: cap.defaultAudio === true,
        audio: cap.audio === true,
        defaultResolution: typeof cap.defaultResolution === "string" ? cap.defaultResolution.toLowerCase() : null,
        defaultDuration: typeof cap.defaultDuration === "number" ? cap.defaultDuration : null,
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 音乐单价（2026-10-10「音乐 1 币/次」）：取自平台目录 GET /v1/models 的 x_coins_per_music，
 * 与平台实扣端点 POST /v1/music/charges 同源（服务端定价），客户端不猜价。
 * 形状未定稿（平台侧另一路在建）：可能是顶层栏位，也可能是某个 model 项上的栏位，
 * 故两处都扫、取第一个数值；都查不到回 null（呼叫端标 price_source:"unknown"）。
 * 绝不硬编码 1 币——写死会与平台定价漂移（同 TTS「宣称 vs 权威」的教训）。
 */
async function loadMusicPerSong(sessionID: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await platformFetch("/models", { method: "GET" }, sessionID, signal)
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, any>
    const pick = (v: unknown): number | null => {
      if (typeof v === "number") return v
      if (v && typeof v === "object") {
        for (const n of Object.values(v as Record<string, unknown>)) if (typeof n === "number") return n
      }
      return null
    }
    const top = pick(body?.x_coins_per_music)
    if (top !== null) return top
    for (const m of (body?.data ?? []) as Array<Record<string, any>>) {
      const v = pick(m?.x_coins_per_music)
      if (v !== null) return v
    }
    return null
  } catch {
    return null
  }
}

async function loadBalance(sessionID: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await platformFetch("/quota", { method: "GET" }, sessionID, signal)
    if (!res.ok) return null
    const b = (await res.json()) as Record<string, any>
    for (const k of ["balance_coins", "balance", "coins", "credit"]) {
      if (typeof b?.[k] === "number") return b[k]
      if (typeof b?.data?.[k] === "number") return b.data[k]
    }
    return null
  } catch {
    return null
  }
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6

export default tool({
  description:
    "免费查钱包与批量预算。items给model/count/kind及视频完整时长/分辨率/音轨；图片和音乐读目录单价，视频读x_billing完整档位金额（按秒或固定次价均由站点计费函数导出）。未知价格的total/affordable为null，不编估价或把未知当零。当前视频API仅支持模型默认分辨率，显式非默认报价未知。只查余额需balance_only:true。预算是事前告知，扣费按本轮真实授权。",
  args: {
    items: tool.schema
      .array(
        tool.schema.object({
          model: tool.schema.string().describe("模型 id，如 gpt-image-2、seedance-2.0"),
          count: tool.schema.number().int().min(1).max(200).describe("该项生成数量（张数／镜数／首数）"),
          kind: tool.schema.enum(["image", "video", "music"]).optional().describe("image 或 video 或 music，预设 image（music＝音乐生成，1 币/次）"),
          duration_seconds: tool.schema.number().optional().describe("每支影片时长（秒），仅 video 用，预设取模型默认时长"),
          resolution: tool.schema.string().optional().describe("影片解析度，如 480p/720p/1080p，仅 video 用，预设取模型默认解析度（quality=hd 时 1080p）"),
          quality: tool.schema.enum(["standard", "hd"]).optional().describe("图片品质；视频hd映射1080p，当前提交API仅接受模型默认分辨率"),
          generate_audio: tool.schema.boolean().optional().describe("视频是否带音轨；未指定时取模型当前defaultAudio"),
          label: tool.schema.string().optional().describe("明细显示名（如「S03-镜1 定场镜头」）"),
        }),
      )
      .max(50)
      .optional()
      .describe("预算单明细项列表；省略＝只查余额"),
    balance_only: tool.schema.boolean().optional().describe("true＝明确只查余额（不报价）。不带 items 又不带 balance_only 会被拒（防止空参数被误读成「合计 0 币」）"),
    max_unit_coins: tool.schema.number().optional().describe("可选：单价上限（每张图/每支影片的币数），超限项标 over_cap:true"),
    max_coins_per_second: tool.schema.number().optional().describe("可选：影片秒价上限（币/秒），超限项标 over_cap:true"),
  },
  async execute(args, context) {
    try {
      const items = args.items ?? []
      // 2026-10-02：空参数守门——e2e 评测首个 quote_bundle 空参数回「合计 0 币」，模型把它当报价。
      // 查余额须显式 balance_only:true；否则拒绝并提示，不给任何可误读成报价的数字。
      if (items.length === 0 && args.balance_only !== true) {
        return fail(
          "quote_bundle_empty_items",
          "quote_bundle 未带 items：这不是有效报价请求（不会回「合计 0 币」）。要报价请传 items=[{model,count,kind,duration_seconds,resolution}]；只想查余额请传 balance_only:true。",
          { title: "预算单参数缺失" },
        )
      }
      const hasVideo = items.some((i) => i.kind === "video")
      const hasMusic = items.some((i) => i.kind === "music")
      const [prices, videoCat, musicPerSong, balance] = await Promise.all([
        items.some((i) => (i.kind ?? "image") === "image") ? loadCatalog(context.sessionID, context.abort) : Promise.resolve(null),
        hasVideo ? loadVideoCatalog(context.sessionID, context.abort) : Promise.resolve(null),
        hasMusic ? loadMusicPerSong(context.sessionID, context.abort) : Promise.resolve(null),
        loadBalance(context.sessionID, context.abort),
      ])
      const lines: Array<Record<string, unknown>> = []
      let total = 0
      let hasUnknown = false

      for (const item of items) {
        const kind = item.kind ?? "image"
        let unit: number | null = null
        let priceSource = "catalog"
        const extra: Record<string, unknown> = {}

        if (kind === "video") {
          const v = videoCat?.[item.model]
          const secs = item.duration_seconds ?? v?.defaultDuration
          const res = (item.resolution ?? (item.quality === "hd" ? "1080p" : v?.defaultResolution))?.toLowerCase()
          const withAudio = item.generate_audio ?? v?.defaultAudio ?? false
          extra.duration_seconds = secs ?? null
          extra.resolution = res ?? null
          extra.generate_audio = withAudio
          const billing = v?.billing
          const table = withAudio ? billing?.prices_with_audio ?? billing?.prices : billing?.prices
          const amount = res && typeof secs === "number" ? table?.[res]?.[String(secs)] : undefined
          // 当前视频API不接受显式非默认档位；报价不承诺会被静默忽略的规格。
          if (res && res === v?.defaultResolution && (!withAudio || v?.audio === true) && billing?.currency === "coins" && (billing.unit === "per_second" || billing.unit === "per_video") && typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
            unit = amount
            extra.billing_unit = billing.unit
            priceSource = "catalog_exact_parameters"
          } else {
            extra.note = "目录未提供该完整提交档位币价，或请求分辨率不受当前提交API支持；未核定预算，不编估值。"
          }
          const cps = billing?.unit === "per_second" && res ? v?.cps[res] : undefined
          if (typeof args.max_coins_per_second === "number" && typeof cps === "number" && cps > args.max_coins_per_second) extra.over_cap = true
        } else if (kind === "music") {
          // 音乐：目录次价（1 币/次统一，不分 model）。查不到 → unit 维持 null → 标 unknown。
          if (typeof musicPerSong === "number") {
            unit = musicPerSong
            extra.coins_per_song = musicPerSong
            priceSource = "catalog_per_song"
          }
        } else if (prices && prices[item.model]) {
          const e = prices[item.model]
          const wantHd = item.quality === "hd"
          const v = wantHd ? e.hd ?? e.standard : e.standard ?? e.hd
          if (typeof v === "number") unit = v
        }

        if (unit === null) {
          hasUnknown = true
          lines.push({
            label: item.label ?? item.model,
            model: item.model,
            kind,
            count: item.count,
            unit_coins: null,
            subtotal_coins: null,
            price_source: "unknown",
            note: "目录查无此模型单价，此项价格待确认（预算单不含此项）",
          })
          continue
        }

        if (typeof args.max_unit_coins === "number" && unit > args.max_unit_coins) extra.over_cap = true
        const subtotal = r6(unit * item.count)
        total = r6(total + subtotal)
        lines.push({
          label: item.label ?? item.model,
          model: item.model,
          kind,
          count: item.count,
          unit_coins: unit,
          subtotal_coins: subtotal,
          price_source: priceSource,
          ...extra,
        })
      }

      const unverified = lines.filter((l) => l.price_source === "estimate_unverified").length
      const overCap = lines.filter((l) => l.over_cap === true).map((l) => l.label)
      const shortfall = balance === null || hasUnknown ? null : r6(Math.max(0, total - balance))
      const affordable = balance === null || hasUnknown ? null : balance > 0 && balance >= total
      const walletNote =
        balance === null
          ? "余额查询失败（未知），不可假设充足。"
          : balance <= 0
            ? `余额 ${balance} 币（≤0，不可消费），任何付费生成都会失败；第一句就告诉用户余额与差额 ${shortfall} 币。`
            : hasUnknown
              ? "预算含未知档位价格，不能判定余额足够。"
              : affordable
              ? `余额 ${balance} 币，足够支付合计 ${total} 币。`
              : `余额 ${balance} 币不足以支付合计 ${total} 币，差额 ${shortfall} 币；第一句就讲余额与差额。`

      return ok({
        title: items.length ? "预算单" : "钱包余额",
        mode: items.length ? "quote" : "balance_only",
        currency: "coins",
        balance_coins: balance,
        spendable: balance === null ? null : balance > 0,
        items: lines,
        total_coins: items.length === 0 || hasUnknown ? null : total, // 余额查询无「合计」，回 null 而非 0
        confirmed_subtotal_coins: total,
        shortfall_coins: shortfall,
        affordable,
        unknown_price_count: lines.filter((l) => l.price_source === "unknown").length,
        unverified_price_count: unverified,
        over_cap_items: overCap,
        note: [
          walletNote,
          hasUnknown
            ? "部分项目单价待确认（见 unknown 项），总价仅统计已定价项。对用户如实标示待确认项，禁止编造单价。"
            : unverified
              ? "含 estimate_unverified 粗估项（目录查无秒价），对用户标「待确认」。"
              : items.length
                ? "全部项目均已按平台目录定价（影片按完整提交档位金额，固定次价不乘时长；音乐按目录次价）。本预算单为事前告知，不取代逐笔扣费确认（confirm）。"
                : "本次仅查余额，未报价；total_coins=null 表示不适用（不是 0 币）。",
          overCap.length ? `超出单价上限：${overCap.join("、")}。` : "",
        ]
          .filter(Boolean)
          .join(" "),
      })
    } catch (e: any) {
      return fail("quote_bundle_failed", `预算单计算失败：${e?.message ?? e}`, { title: "预算单失败" })
    }
  },
})
