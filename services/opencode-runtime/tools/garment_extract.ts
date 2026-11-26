import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { cutoutFromUrl, vlmAskJson, permilleBboxToPx } from "../lib/batch5-matting"

// 服装单品提取（2026-08-31 片5）：服装图 → rembg 去背单品资产（透明底）+ VLM 标品类/描述/边界框。
// 复用 background_remove 同一抠图核心（cutoutFromUrl），叠加 VLM 读图元数据。

const GARMENT_Q =
  "这是含服装的图片。请框出最主要的单一件服装（上衣/裤子/裙子/外套/连身裙等，不含模特脸部/配饰除非用户指的是配饰），输出 JSON：" +
  '{"category":"服装品类（如 连衣裙/西装外套/T恤/牛仔裤）",' +
  '"description":"该单品的简短视觉描述（颜色/版型/明显特征）",' +
  '"bbox":[x1,y1,x2,y2]}，bbox 为相对宽高的千分比（0-1000，左上为原点，x1<x2, y1<y2）。只输出 JSON。'

export default tool({
  description:
    "服装单品提取（rembg u2net 去背 + VLM 标注，零生图扣费）：image_url 填服装图 URL → 复用 background_remove 同一抠图核心产透明底单品资产 → VLM（gemini-2.5-flash-image）读原图给品类/描述/边界框（千分比 + 换算像素）。输出公网透明 PNG URL + bbox 元数据 + alpha 统计。诚实：bbox 为 VLM 目测千分比换算，非像素级实例分割框；抠图精度同 background_remove（u2net 通用分割，发丝/网纱有限）。VLM 不可达时仍交付去背资产，bbox/category 诚实标 null。",
  args: {
    image_url: tool.schema.string().describe("服装图 URL（http(s)）"),
    max_side: tool.schema.number().int().min(256).max(2048).optional().describe("输入长边上限，默认 1536"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url?.trim() || ""
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
    const r = await cutoutFromUrl(imageUrl, context.abort, "garment", args.max_side ?? 1536)
    if (!r.ok) return fail(r.code || "matting_failed", r.reason || "抠图失败", { title: "服装提取失败", source_url: imageUrl })

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
        title: "服装单品提取完成",
        url: r.url,
        source_url: r.source_url,
        garment: { category, description, bbox_px: bboxPx, bbox_permille: bboxPermille },
        alpha_stats: r.stats,
        size: `${r.stats?.width}x${r.stats?.height}`,
        vlm_status: v.ok ? "ok" : `unavailable: ${v.reason}`,
        elapsed_ms: r.elapsed_ms,
        mechanism: "rembg u2net 去背 + VLM 目测 bbox",
        note: "bbox_px 依去背资产尺寸换算（千分比→像素）；category/description 为 VLM 读原图结果。",
      },
      { url: r.url, category, bbox_px: bboxPx },
    )
  },
})
