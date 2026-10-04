import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

// 展陈多规格交付清单（2026-08-31 片1 实装）：主视觉 + 规格 → 尺寸/DPI/出血/格式要求
// + 现有资产匹配缺口报告。纯代码：内置展陈规格表（印刷 cm×DPI 换算像素），
// 给到主视觉像素尺寸时逐规格判 ready/needs_upscale/needs_reflow/unknown。

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
  { id: "roll_up", name: "易拉宝", size_cm: [80, 200], px: null, dpi: 150, bleed_cm: 0.4, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "大幅面 150dpi 即够；底部 5cm 避开支架夹缝" },
  { id: "x_stand", name: "X 展架", size_cm: [60, 160], px: null, dpi: 150, bleed_cm: 0.4, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "四角固定点留安全边 3cm" },
  { id: "poster_a2", name: "海报 A2", size_cm: [42, 59.4], px: null, dpi: 300, bleed_cm: 0.3, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "300dpi 近距离观看" },
  { id: "poster_a1", name: "海报 A1", size_cm: [59.4, 84.1], px: null, dpi: 300, bleed_cm: 0.3, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "" },
  { id: "poster_a0", name: "海报 A0", size_cm: [84.1, 118.9], px: null, dpi: 300, bleed_cm: 0.3, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "" },
  { id: "backdrop", name: "背景板（step&repeat）", size_cm: [300, 400], px: null, dpi: 100, bleed_cm: 0, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "3m×4m 展会背景，100dpi 远观即可；logo 重复单元需无缝" },
  { id: "banner", name: "横幅", size_cm: [300, 90], px: null, dpi: 150, bleed_cm: 0, orientation: "landscape", format: "TIFF/JPG（喷绘）", note: "长度按现场调整；文字离地 ≥1m" },
  { id: "hanging_flag", name: "吊旗", size_cm: [60, 90], px: null, dpi: 150, bleed_cm: 0.4, orientation: "portrait", format: "PDF/TIFF（印刷）", note: "双面需镜像版" },
  { id: "table_card", name: "桌牌", size_cm: [21, 28], px: null, dpi: 300, bleed_cm: 0.2, orientation: "landscape", format: "PDF（印刷）", note: "A4 横向对折 tent card" },
  { id: "screen_169", name: "屏显 16:9", size_cm: null, px: [1920, 1080], dpi: 72, bleed_cm: 0, orientation: "landscape", format: "JPG/PNG/MP4（屏显）", note: "无出血；关键信息避开边框 5%" },
  { id: "screen_vertical", name: "竖屏 9:16", size_cm: null, px: [1080, 1920], dpi: 72, bleed_cm: 0, orientation: "portrait", format: "JPG/PNG/MP4（屏显）", note: "电梯屏/竖屏机" },
  { id: "social_square", name: "社媒方图", size_cm: null, px: [1080, 1080], dpi: 72, bleed_cm: 0, orientation: "square", format: "JPG/PNG（屏显）", note: "线上分发配套" },
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
    "展陈多规格交付清单（纯代码，零扣费）。key_visual 填主视觉 URL；width_px/height_px 给现有主视觉像素尺寸（可选，给了才能做缺口匹配）；formats 可选 JSON 阵列字串指定要哪些规格（默认全表：易拉宝/X展架/海报A2-A0/背景板/横幅/吊旗/桌牌/屏显16:9/竖屏/社媒方图）。输出每规格：尺寸 cm、出血、DPI、含出血所需像素、格式要求、方向；并逐规格对照现有资产给 status：ready/needs_upscale/needs_reflow/unknown_source_dims（缺口诚实报告，不代生成）。",
  args: {
    key_visual: tool.schema.string().describe("展陈主视觉 URL 或资产标识"),
    width_px: tool.schema.number().int().positive().optional().describe("现有主视觉宽（像素），给出后做缺口匹配"),
    height_px: tool.schema.number().int().positive().optional().describe("现有主视觉高（像素）"),
    formats: tool.schema.string().optional().describe('可选：规格 id JSON 阵列字串，如 ["roll_up","screen_169"]'),
  },
  async execute(args) {
    const kv = String(args.key_visual ?? "").trim()
    if (!kv) return fail("missing_key_visual", "key_visual 为空：需给主视觉 URL 或资产标识", { title: "输入缺失" })

    let selected = SPECS
    if (args.formats) {
      let ids: unknown
      try {
        ids = JSON.parse(args.formats)
      } catch {
        return fail("invalid_formats", "formats 必须是规格 id 的 JSON 阵列字串", { title: "输入非法" })
      }
      if (!Array.isArray(ids) || !ids.length) return fail("invalid_formats", "formats 为空阵列", { title: "输入非法" })
      const idSet = new Set(ids.map(String))
      selected = SPECS.filter((s) => idSet.has(s.id))
      const unknown = [...idSet].filter((id) => !SPECS.some((s) => s.id === id))
      if (!selected.length) {
        return fail("unknown_formats", `指定的规格 id 全部不存在：${unknown.join(", ")}；可选：${SPECS.map((s) => s.id).join("/")}`, { title: "规格不存在" })
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
        if (!sizeOk) gap = `像素不足：现有 ${w}×${h} < 需求 ${rw}×${rh}（约需放大 ${Math.ceil((Math.max(rw / w, rh / h) || 1) * 100) / 100}×）`
        else if (!ratioOk) gap = `画幅不合：现有 ${ratioOf(w, h)} vs 需求 ${ratioOf(rw, rh)}，需重排/裁切（多_aspect_reflow 或重新出图）`
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
      title: `展陈交付：${entries.length} 规格（ready ${summary.ready}）`,
      key_visual: kv,
      source_dims: hasDims ? { width_px: args.width_px, height_px: args.height_px } : null,
      manifest: entries,
      summary,
      note: "像素需求=（尺寸+双边出血）/2.54×DPI；大幅面按行业惯例降 DPI（易拉宝/背景板 100-150）。本工具只出清单与缺口，不代生成/不代放大。",
    })
  },
})
