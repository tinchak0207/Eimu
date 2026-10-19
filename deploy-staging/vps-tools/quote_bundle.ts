import { tool } from "@opencode-ai/plugin/tool"
import { loadCatalog, estimateVideoCoins, platformFetch, ok, fail } from "../lib/client"

// 批量预算单：多笔生成任务一次性估价（明细 + 总价）＋钱包对帐。
// 图片单价：loadCatalog（GET /v1/models 的 x_coins_per_image，10 分钟快取），与 image_generate 同源。
// 影片单价（R9-A 2026-09-30）：GET /v1/models 的 x_coins_per_second[解析度] × 时长，与 gateway
// catalogVideoPerSecondCoins（扣费同源）同口径；目录查不到才退回 estimateVideoCoins 并标
// price_source:"estimate_unverified"。旧版影片一律 720P 5 币/秒，seedance-2.0 15s 报 75 实为 195。
// 余额：GET /v1/quota（与 gateway fetchBalance 同源），回应带 balance/shortfall/affordable。

type VideoEntry = { cps: Record<string, number>; defaultResolution: string | null; defaultDuration: number | null }

async function loadVideoCatalog(sessionID: string, signal?: AbortSignal): Promise<Record<string, VideoEntry> | null> {
  try {
    const res = await platformFetch("/models", { method: "GET" }, sessionID, signal)
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<Record<string, any>> }
    const out: Record<string, VideoEntry> = {}
    for (const m of body.data ?? []) {
      if (typeof m?.id !== "string") continue
      const raw = m.x_coins_per_second
      if (!raw || typeof raw !== "object") continue
      const cps: Record<string, number> = {}
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number") cps[k.toLowerCase()] = v
      if (!Object.keys(cps).length) continue
      const cap = m.x_capabilities ?? {}
      out[m.id] = {
        cps,
        defaultResolution: typeof cap.defaultResolution === "string" ? cap.defaultResolution.toLowerCase() : null,
        defaultDuration: typeof cap.defaultDuration === "number" ? cap.defaultDuration : null,
      }
    }
    return out
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
    "钱包预检＋批量预算单工具（免费不扣费）。不带 items 呼叫＝只查当前余额（开局预检用）。输入多笔 [{model, count, kind, duration_seconds, resolution, quality}]，输出每笔明细（单价 × 数量 = 小计）、总币数、当前余额 balance_coins、差额 shortfall_coins 与 affordable 布林。图片单价取自平台目录；影片单价=目录 x_coins_per_second[解析度]×时长（与实扣同源），目录查不到才标 price_source:\"estimate_unverified\"，图片查不到标 \"unknown\"，禁止拍脑袋。可选 max_unit_coins / max_coins_per_second 单价上限，超限项标 over_cap:true。批量开工前必须先用本工具出预算单给用户过目；affordable:false 时第一句就讲余额与差额。",
  args: {
    items: tool.schema
      .array(
        tool.schema.object({
          model: tool.schema.string().describe("模型 id，如 gpt-image-2、seedance-2.0"),
          count: tool.schema.number().int().min(1).max(200).describe("该项生成数量（张数或镜数）"),
          kind: tool.schema.enum(["image", "video"]).optional().describe("image 或 video，预设 image"),
          duration_seconds: tool.schema.number().optional().describe("每支影片时长（秒），仅 video 用，预设取模型默认时长"),
          resolution: tool.schema.string().optional().describe("影片解析度，如 480p/720p/1080p，仅 video 用，预设取模型默认解析度（quality=hd 时 1080p）"),
          quality: tool.schema.enum(["standard", "hd"]).optional().describe("standard 或 hd，预设 standard"),
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
      const [prices, videoCat, balance] = await Promise.all([
        items.some((i) => (i.kind ?? "image") === "image") ? loadCatalog(context.sessionID, context.abort) : Promise.resolve(null),
        hasVideo ? loadVideoCatalog(context.sessionID, context.abort) : Promise.resolve(null),
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
          const secs = item.duration_seconds || v?.defaultDuration || 10
          const res = (item.resolution ?? (item.quality === "hd" ? "1080p" : v?.defaultResolution ?? "720p")).toLowerCase()
          const cps = v?.cps[res]
          extra.duration_seconds = secs
          extra.resolution = res
          if (typeof cps === "number") {
            unit = r6(cps * secs)
            extra.coins_per_second = cps
            priceSource = "catalog_per_second"
          } else {
            unit = estimateVideoCoins(secs, item.quality)
            priceSource = "estimate_unverified"
            extra.note = v
              ? `目录无此解析度 ${res} 的秒价（可用：${Object.keys(v.cps).join("/")}），此价为粗估，实扣可能更高`
              : "目录查无此影片模型秒价，此价为粗估，实扣可能更高；对用户标「待确认」"
          }
          if (typeof args.max_coins_per_second === "number" && typeof cps === "number" && cps > args.max_coins_per_second) {
            extra.over_cap = true
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
      const shortfall = balance === null ? null : r6(Math.max(0, total - balance))
      const affordable = balance === null ? null : balance > 0 && balance >= total
      const walletNote =
        balance === null
          ? "余额查询失败（未知），不可假设充足。"
          : balance <= 0
            ? `余额 ${balance} 币（≤0，不可消费），任何付费生成都会失败；第一句就告诉用户余额与差额 ${shortfall} 币。`
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
                ? "全部项目均已按平台目录定价（影片=秒价×时长）。本预算单为事前告知，不取代逐笔扣费确认（confirm）。"
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
