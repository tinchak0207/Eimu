import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { cutoutFromUrl } from "../lib/batch5-matting"

// 摳圖去背（2026-08-31 片5）：圖片 URL → rembg（u2net/onnxruntime CPU）本地推理 →
// 透明底 RGBA PNG → 公網 blob 落檔 + alpha 實測統計。零生圖扣費、零 VLM。

export default tool({
  description:
    "摳圖去背（rembg u2net，本地 onnxruntime CPU 推理，零生圖扣費、零 VLM）：image_url 填圖片 URL → 下載 → rembg 分割去背 → 透明底 RGBA PNG → 落公網檔回 URL。輸出含 alpha 實測統計（透明/不透明/半透明像素占比、是否含真實 alpha 通道）。誠實：u2net 為通用顯著性分割，髮絲/網紗/複雜邊緣精度有限；要更高精度請用 BiRefNet 級上游（本工具未接）。輸入先等比縮到長邊 ≤1536 以約束內存。下載/推理/上傳任一失敗回 ok:false 不編造。",
  args: {
    image_url: tool.schema.string().describe("待摳圖的圖片 URL（http(s)）"),
    max_side: tool.schema.number().int().min(256).max(2048).optional().describe("輸入長邊上限像素，默認 1536（越大越耗內存）"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url?.trim() || ""
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    const r = await cutoutFromUrl(imageUrl, context.abort, "bgrem", args.max_side ?? 1536)
    if (!r.ok) return fail(r.code || "matting_failed", r.reason || "摳圖失敗", { title: "摳圖失敗", source_url: imageUrl })
    return ok(
      {
        title: "摳圖完成（透明底 PNG）",
        url: r.url,
        source_url: r.source_url,
        alpha_stats: r.stats,
        size: `${r.stats?.width}x${r.stats?.height}`,
        elapsed_ms: r.elapsed_ms,
        mechanism: "rembg u2net (onnxruntime CPU)",
        note: "alpha_stats.has_true_alpha=true 表示輸出確為 RGBA 且 alpha 同時含 0（全透）與 255（不透）；transparent_pct 為背景去除比例。",
      },
      { url: r.url, has_true_alpha: r.stats?.has_true_alpha ?? false },
    )
  },
})
