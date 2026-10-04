import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { cutoutFromUrl } from "../lib/batch5-matting"

// 抠图去背（2026-08-31 片5）：图片 URL → rembg（u2net/onnxruntime CPU）本地推理 →
// 透明底 RGBA PNG → 公网 blob 落档 + alpha 实测统计。零生图扣费、零 VLM。

export default tool({
  description:
    "抠图去背（rembg u2net，本地 onnxruntime CPU 推理，零生图扣费、零 VLM）：image_url 填图片 URL → 下载 → rembg 分割去背 → 透明底 RGBA PNG → 落公网档回 URL。输出含 alpha 实测统计（透明/不透明/半透明像素占比、是否含真实 alpha 通道）。诚实：u2net 为通用显著性分割，发丝/网纱/复杂边缘精度有限；要更高精度请用 BiRefNet 级上游（本工具未接）。输入先等比缩到长边 ≤1536 以约束内存。下载/推理/上传任一失败回 ok:false 不编造。",
  args: {
    image_url: tool.schema.string().describe("待抠图的图片 URL（http(s)）"),
    max_side: tool.schema.number().int().min(256).max(2048).optional().describe("输入长边上限像素，默认 1536（越大越耗内存）"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url?.trim() || ""
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
    const r = await cutoutFromUrl(imageUrl, context.abort, "bgrem", args.max_side ?? 1536)
    if (!r.ok) return fail(r.code || "matting_failed", r.reason || "抠图失败", { title: "抠图失败", source_url: imageUrl })
    return ok(
      {
        title: "抠图完成（透明底 PNG）",
        url: r.url,
        source_url: r.source_url,
        alpha_stats: r.stats,
        size: `${r.stats?.width}x${r.stats?.height}`,
        elapsed_ms: r.elapsed_ms,
        mechanism: "rembg u2net (onnxruntime CPU)",
        note: "alpha_stats.has_true_alpha=true 表示输出确为 RGBA 且 alpha 同时含 0（全透）与 255（不透）；transparent_pct 为背景去除比例。",
      },
      { url: r.url, has_true_alpha: r.stats?.has_true_alpha ?? false },
    )
  },
})
