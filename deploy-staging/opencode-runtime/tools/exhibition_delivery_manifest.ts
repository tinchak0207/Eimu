import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

// 展陳多規格交付清單（2026-08-31 片1 實裝）：主視覺 + 規格 → 尺寸/DPI/出血/格式要求
// + 現有資產匹配缺口報告。純代碼：內置展陳規格表（印刷 cm×DPI 換算像素），
// 給到主視覺像素尺寸時逐規格判 ready/needs_upscale/needs_reflow/unknown。

interface Spec {
  id: string
  name: string
  size_cm: [number, number] | null
  px: [number, number] | null
  dpi: number
  bleed_cm: number
  orientation: "portrait" | "landscape" | "square" | "any"
  format: string
  note: string
}

const SPECS: Spec[] = [
  { id: "roll_up", name: "易拉寶", size_cm: [80, 200], px: null, dpi: 150, bleed_cm: 0.4, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "大幅面 150dpi 即夠；底部 5cm 避開支架夾縫" },
  { id: "x_stand", name: "X 展架", size_cm: [60, 160], px: null, dpi: 150, bleed_cm: 0.4, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "四角固定點留安全邊 3cm" },
  { id: "poster_a2", name: "海報 A2", size_cm: [42, 59.4], px: null, dpi: 300, bleed_cm: 0.3, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "300dpi 近距離觀看" },
  { id: "poster_a1", name: "海報 A1", size_cm: [59.4, 84.1], px: null, dpi: 300, bleed_cm: 0.3, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "" },
  { id: "poster_a0", name: "海報 A0", size_cm: [84.1, 118.9], px: null, dpi: 300, bleed_cm: 0.3, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "" },
  { id: "backdrop", name: "背景板（step&repeat）", size_cm: [300, 400], px: null, dpi: 100, bleed_cm: 0, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "3m×4m 展會背景，100dpi 遠觀即可；logo 重複單元需無縫" },
  { id: "banner", name: "橫幅", size_cm: [300, 90], px: null, dpi: 150, bleed_cm: 0, orientation: "landscape", format: "TIFF/JPG（噴繪）", note: "長度按現場調整；文字離地 ≥1m" },
  { id: "hanging_flag", name: "吊旗", size_cm: [60, 90], px: null, dpi: 150, bleed_cm: 0.4, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "雙面需鏡像版" },
  { id: "table_card", name: "桌牌", size_cm: [21, 28], px: null, dpi: 300, bleed_cm: 0.2, orientation: "landscape", format: "PDF（印刷）", note: "A4 橫向對摺 tent card" },
  { id: "screen_169", name: "屏顯 16:9", size_cm: null, px: [1920, 1080], dpi: 72, bleed_cm: 0, orientation: "landscape", format: "JPG/PNG/MP4（屏顯）", note: "無出血；關鍵信息避開邊框 5%" },
  { id: "screen_vertical", name: "豎屏 9:16", size_cm: null, px: [1080, 1920], dpi: 72, bleed_cm: 0, orientation: "portrait", format: "JPG/PNG/MP4（屏顯）", note: "電梯屏/豎屏機" },
  { id: "social_square", name: "社媒方圖", size_cm: null, px: [1080, 1080], dpi: 72, bleed_cm: 0, orientation: "square", format: "JPG/PNG（屏顯）", note: "線上分發配套" },
]

function requiredPixels(s: Spec): [number, number] {
  if (s.px) return s.px
  const [w, h] = s.size_cm as [number, number]
  const bw = w + 2 * s.bleed_cm
  const bh = h + 2 * s.bleed_cm
  return [Math.round((bw / 2.54) * s.dpi), Math.round((bh / 2.54) * s.dpi)]
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}
function ratioOf(w: number, h: number): string {
  const g = gcd(w, h) || 1
  const rw = w / g
  const rh = h / g
  if (rw / rh > 25 || rh / rw > 25) return `${(rw / rh).toFixed(2)} : 1`
  return `${rw} : ${rh}`
}

export default tool({
  description:
    "展陳多規格交付清單（純代碼，零扣費）。key_visual 填主視覺 URL；width_px/height_px 給現有主視覺像素尺寸（可選，給了才能做缺口匹配）；formats 可選 JSON 陣列字串指定要哪些規格（默認全表：易拉寶/X展架/海報A2-A0/背景板/橫幅/吊旗/桌牌/屏顯16:9/豎屏/社媒方圖）。輸出每規格：尺寸 cm、出血、DPI、含出血所需像素、格式要求、方向；並逐規格對照現有資產給 status：ready/needs_upscale/needs_reflow/unknown_source_dims（缺口誠實報告，不代生成）。",
  args: {
    key_visual: tool.schema.string().describe("展陳主視覺 URL 或資產標識"),
    width_px: tool.schema.number().int().positive().optional().describe("現有主視覺寬（像素），給出後做缺口匹配"),
    height_px: tool.schema.number().int().positive().optional().describe("現有主視覺高（像素）"),
    formats: tool.schema.string().optional().describe('可選：規格 id JSON 陣列字串，如 ["roll_up","screen_169"]'),
  },
  async execute(args) {
    const kv = String(args.key_visual ?? "").trim()
    if (!kv) return fail("missing_key_visual", "key_visual 為空：需給主視覺 URL 或資產標識", { title: "輸入缺失" })

    let selected = SPECS
    if (args.formats) {
      let ids: unknown
      try {
        ids = JSON.parse(args.formats)
      } catch {
        return fail("invalid_formats", "formats 必須是規格 id 的 JSON 陣列字串", { title: "輸入非法" })
      }
      if (!Array.isArray(ids) || !ids.length) return fail("invalid_formats", "formats 為空陣列", { title: "輸入非法" })
      const idSet = new Set(ids.map(String))
      selected = SPECS.filter((s) => idSet.has(s.id))
      const unknown = [...idSet].filter((id) => !SPECS.some((s) => s.id === id))
      if (!selected.length) {
        return fail("unknown_formats", `指定的規格 id 全部不存在：${unknown.join(", ")}；可選：${SPECS.map((s) => s.id).join("/")}`, { title: "規格不存在" })
      }
      if (unknown.length) args.formats = `${args.formats}（忽略不存在的 id：${unknown.join(", ")}）`
    }

    const hasDims = typeof args.width_px === "number" && typeof args.height_px === "number" && args.width_px > 0 && args.height_px > 0
    const entries = selected.map((s) => {
      const [rw, rh] = requiredPixels(s)
      let status: "ready" | "needs_upscale" | "needs_reflow" | "unknown_source_dims" = "unknown_source_dims"
      let gap: string | null = null
      if (hasDims) {
        const w = args.width_px as number
        const h = args.height_px as number
        const srcRatio = w / h
        const dstRatio = rw / rh
        const ratioOk = Math.abs(srcRatio - dstRatio) / dstRatio < 0.02
        const sizeOk = w >= rw && h >= rh
        if (ratioOk && sizeOk) status = "ready"
        else if (ratioOk) status = "needs_upscale"
        else status = "needs_reflow"
        if (!sizeOk) gap = `像素不足：現有 ${w}×${h} < 需求 ${rw}×${rh}（約需放大 ${Math.ceil((Math.max(rw / w, rh / h) || 1) * 100) / 100}×）`
        else if (!ratioOk) gap = `畫幅不合：現有 ${ratioOf(w, h)} vs 需求 ${ratioOf(rw, rh)}，需重排/裁切（多_aspect_reflow 或重新出圖）`
      }
      return {
        spec_id: s.id,
        name: s.name,
        size_cm: s.size_cm,
        bleed_cm: s.bleed_cm,
        dpi: s.dpi,
        required_px_with_bleed: [rw, rh],
        required_ratio: ratioOf(rw, rh),
        orientation: s.orientation,
        format_requirement: s.format,
        note: s.note,
        status,
        gap,
      }
    })

    const summary = {
      total: entries.length,
      ready: entries.filter((e) => e.status === "ready").length,
      needs_upscale: entries.filter((e) => e.status === "needs_upscale").length,
      needs_reflow: entries.filter((e) => e.status === "needs_reflow").length,
      unknown_source_dims: entries.filter((e) => e.status === "unknown_source_dims").length,
    }

    return ok({
      title: `展陳交付：${entries.length} 規格（ready ${summary.ready}）`,
      key_visual: kv,
      source_dims: hasDims ? { width_px: args.width_px, height_px: args.height_px } : null,
      manifest: entries,
      summary,
      note: "像素需求=（尺寸+雙邊出血）/2.54×DPI；大幅面按行業慣例降 DPI（易拉寶/背景板 100-150）。本工具只出清單與缺口，不代生成/不代放大。",
    })
  },
})
