import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { cutoutFromUrl, vlmAskJson, permilleBboxToPx } from "../lib/batch5-matting"

// 服裝單品提取（2026-08-31 片5）：服裝圖 → rembg 去背單品資產（透明底）+ VLM 標品类/描述/邊界框。
// 復用 background_remove 同一摳圖核心（cutoutFromUrl），疊加 VLM 讀圖元數據。

const GARMENT_Q =
  "這是含服裝的圖片。請框出最主要的單一件服裝（上衣/褲子/裙子/外套/連身裙等，不含模特臉部/配飾除非用戶指的是配飾），輸出 JSON：" +
  '{"category":"服裝品類（如 連衣裙/西裝外套/T恤/牛仔褲）",' +
  '"description":"該單品的簡短視覺描述（顏色/版型/明顯特徵）",' +
  '"bbox":[x1,y1,x2,y2]}，bbox 為相對寬高的千分比（0-1000，左上為原點，x1<x2, y1<y2）。只輸出 JSON。'

export default tool({
  description:
    "服裝單品提取（rembg u2net 去背 + VLM 標注，零生圖扣費）：image_url 填服裝圖 URL → 復用 background_remove 同一摳圖核心產透明底單品資產 → VLM（gemini-2.5-flash-image）讀原圖給品類/描述/邊界框（千分比 + 換算像素）。輸出公網透明 PNG URL + bbox 元數據 + alpha 統計。誠實：bbox 為 VLM 目測千分比換算，非像素級實例分割框；摳圖精度同 background_remove（u2net 通用分割，髮絲/網紗有限）。VLM 不可達時仍交付去背資產，bbox/category 誠實標 null。",
  args: {
    image_url: tool.schema.string().describe("服裝圖 URL（http(s)）"),
    max_side: tool.schema.number().int().min(256).max(2048).optional().describe("輸入長邊上限，默認 1536"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url?.trim() || ""
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    const r = await cutoutFromUrl(imageUrl, context.abort, "garment", args.max_side ?? 1536)
    if (!r.ok) return fail(r.code || "matting_failed", r.reason || "摳圖失敗", { title: "服裝提取失敗", source_url: imageUrl })

    const v = await vlmAskJson([imageUrl], GARMENT_Q, 800)
    let category: string | null = null
    let description: string | null = null
    let bboxPx: [number, number, number, number] | null = null
    let bboxPermille: number[] | null = null
    if (v.ok) {
      const d = v.data as Record<string, unknown>
      if (typeof d.category === "string" && d.category.trim()) category = d.category.trim()
      if (typeof d.description === "string" && d.description.trim()) description = d.description.trim()
      if (Array.isArray(d.bbox)) bboxPermille = (d.bbox as unknown[]).filter((x) => typeof x === "number") as number[]
      bboxPx = permilleBboxToPx(d.bbox, r.stats?.width || 0, r.stats?.height || 0)
    }
    return ok(
      {
        title: "服裝單品提取完成",
        url: r.url,
        source_url: r.source_url,
        garment: { category, description, bbox_px: bboxPx, bbox_permille: bboxPermille },
        alpha_stats: r.stats,
        size: `${r.stats?.width}x${r.stats?.height}`,
        vlm_status: v.ok ? "ok" : `unavailable: ${v.reason}`,
        elapsed_ms: r.elapsed_ms,
        mechanism: "rembg u2net 去背 + VLM 目測 bbox",
        note: "bbox_px 依去背資產尺寸換算（千分比→像素）；category/description 為 VLM 讀原圖結果。",
      },
      { url: r.url, category, bbox_px: bboxPx },
    )
  },
})
