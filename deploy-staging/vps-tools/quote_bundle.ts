import { tool } from "@opencode-ai/plugin/tool"
import { loadCatalog, estimateVideoCoins, platformFetch, ok, fail } from "../lib/client"

// 批量預算單：多筆生成任務一次性估價（明細 + 總價）＋錢包對帳。
// 圖片單價：loadCatalog（GET /v1/models 的 x_coins_per_image，10 分鐘快取），與 image_generate 同源。
// 影片單價（R9-A 2026-09-30）：GET /v1/models 的 x_coins_per_second[解析度] × 時長，與 gateway
// catalogVideoPerSecondCoins（扣費同源）同口徑；目錄查不到才退回 estimateVideoCoins 並標
// price_source:"estimate_unverified"。舊版影片一律 720P 5 幣/秒，seedance-2.0 15s 報 75 實為 195。
// 餘額：GET /v1/quota（與 gateway fetchBalance 同源），回應帶 balance/shortfall/affordable。

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
    "錢包預檢＋批量預算單工具（免費不扣費）。不帶 items 呼叫＝只查當前餘額（開局預檢用）。輸入多筆 [{model, count, kind, duration_seconds, resolution, quality}]，輸出每筆明細（單價 × 數量 = 小計）、總幣數、當前餘額 balance_coins、差額 shortfall_coins 與 affordable 布林。圖片單價取自平台目錄；影片單價=目錄 x_coins_per_second[解析度]×時長（與實扣同源），目錄查不到才標 price_source:\"estimate_unverified\"，圖片查不到標 \"unknown\"，禁止拍腦袋。可選 max_unit_coins / max_coins_per_second 單價上限，超限項標 over_cap:true。批量開工前必須先用本工具出預算單給用戶過目；affordable:false 時第一句就講餘額與差額。",
  args: {
    items: tool.schema
      .array(
        tool.schema.object({
          model: tool.schema.string().describe("模型 id，如 gpt-image-2、seedance-2.0"),
          count: tool.schema.number().int().min(1).max(200).describe("該項生成數量（張數或鏡數）"),
          kind: tool.schema.enum(["image", "video"]).optional().describe("image 或 video，預設 image"),
          duration_seconds: tool.schema.number().optional().describe("每支影片時長（秒），僅 video 用，預設取模型默認時長"),
          resolution: tool.schema.string().optional().describe("影片解析度，如 480p/720p/1080p，僅 video 用，預設取模型默認解析度（quality=hd 時 1080p）"),
          quality: tool.schema.enum(["standard", "hd"]).optional().describe("standard 或 hd，預設 standard"),
          label: tool.schema.string().optional().describe("明細顯示名（如「S03-鏡1 定場鏡頭」）"),
        }),
      )
      .max(50)
      .optional()
      .describe("預算單明細項列表；省略＝只查餘額"),
    balance_only: tool.schema.boolean().optional().describe("true＝明確只查餘額（不報價）。不帶 items 又不帶 balance_only 會被拒（防止空參數被誤讀成「合計 0 幣」）"),
    max_unit_coins: tool.schema.number().optional().describe("可選：單價上限（每張圖/每支影片的幣數），超限項標 over_cap:true"),
    max_coins_per_second: tool.schema.number().optional().describe("可選：影片秒價上限（幣/秒），超限項標 over_cap:true"),
  },
  async execute(args, context) {
    try {
      const items = args.items ?? []
      // 2026-10-02：空參數守門——e2e 評測首個 quote_bundle 空參數回「合計 0 幣」，模型把它當報價。
      // 查餘額須顯式 balance_only:true；否則拒絕並提示，不給任何可誤讀成報價的數字。
      if (items.length === 0 && args.balance_only !== true) {
        return fail(
          "quote_bundle_empty_items",
          "quote_bundle 未帶 items：這不是有效報價請求（不會回「合計 0 幣」）。要報價請傳 items=[{model,count,kind,duration_seconds,resolution}]；只想查餘額請傳 balance_only:true。",
          { title: "預算單參數缺失" },
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
              ? `目錄無此解析度 ${res} 的秒價（可用：${Object.keys(v.cps).join("/")}），此價為粗估，實扣可能更高`
              : "目錄查無此影片模型秒價，此價為粗估，實扣可能更高；對用戶標「待確認」"
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
            note: "目錄查無此模型單價，此項價格待確認（預算單不含此項）",
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
          ? "餘額查詢失敗（未知），不可假設充足。"
          : balance <= 0
            ? `餘額 ${balance} 幣（≤0，不可消費），任何付費生成都會失敗；第一句就告訴用戶餘額與差額 ${shortfall} 幣。`
            : affordable
              ? `餘額 ${balance} 幣，足夠支付合計 ${total} 幣。`
              : `餘額 ${balance} 幣不足以支付合計 ${total} 幣，差額 ${shortfall} 幣；第一句就講餘額與差額。`

      return ok({
        title: items.length ? "預算單" : "錢包餘額",
        mode: items.length ? "quote" : "balance_only",
        currency: "coins",
        balance_coins: balance,
        spendable: balance === null ? null : balance > 0,
        items: lines,
        total_coins: items.length === 0 || hasUnknown ? null : total, // 餘額查詢無「合計」，回 null 而非 0
        confirmed_subtotal_coins: total,
        shortfall_coins: shortfall,
        affordable,
        unknown_price_count: lines.filter((l) => l.price_source === "unknown").length,
        unverified_price_count: unverified,
        over_cap_items: overCap,
        note: [
          walletNote,
          hasUnknown
            ? "部分項目單價待確認（見 unknown 項），總價僅統計已定價項。對用戶如實標示待確認項，禁止編造單價。"
            : unverified
              ? "含 estimate_unverified 粗估項（目錄查無秒價），對用戶標「待確認」。"
              : items.length
                ? "全部項目均已按平台目錄定價（影片=秒價×時長）。本預算單為事前告知，不取代逐筆扣費確認（confirm）。"
                : "本次僅查餘額，未報價；total_coins=null 表示不適用（不是 0 幣）。",
          overCap.length ? `超出單價上限：${overCap.join("、")}。` : "",
        ]
          .filter(Boolean)
          .join(" "),
      })
    } catch (e: any) {
      return fail("quote_bundle_failed", `預算單計算失敗：${e?.message ?? e}`, { title: "預算單失敗" })
    }
  },
})
