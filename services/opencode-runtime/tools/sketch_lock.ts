import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, blobPath } from "../lib/img-composite"
import { vlmAskJson } from "../lib/img-orchestrate"

// 黑白线稿锁定（2026-08-31 片3）：构图草稿 → 边缘线稿 + 构图元数据。
// 纯确定性 PIL（灰度→FIND_EDGES→自动阈值反转），零 LLM 依赖；可选 VLM 注解。
// 诚实：这是低成本构图验证（把草稿压成黑白线稿看结构），非 AI 重绘/美化。

export default tool({
  description:
    "黑白线稿锁定（纯确定性 PIL，零生图扣费、默认零 LLM）：image_url 填构图草稿 → 灰度转边缘（FIND_EDGES + 95 百分位自动阈值反转）输出黑线白底线稿公网 URL，并附 PIL 统计的构图元数据（主体重心/留白比例/三分线偏差/边缘能量）。诚实：这是低成本构图验证（压线稿看结构骨架），不是 AI 重绘或美化，也不产出新构图。annotate=true 才额外调 VLM 给一句构图注解（默认关，省呼叫）。",
  args: {
    image_url: tool.schema.string().describe("构图草稿 URL"),
    low: tool.schema.number().int().min(0).max(255).optional().describe("边缘阈值下限，默认 64"),
    high: tool.schema.number().int().min(0).max(255).optional().describe("自动阈值上限参考，默认 160"),
    annotate: tool.schema.boolean().optional().describe("true=额外调 VLM 给一句构图注解（默认 false）"),
  },
  async execute(args, context) {
    const url = args.image_url.trim()
    if (!/^https?:\/\//.test(url)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
    let buf: Buffer
    try {
      buf = await downloadImage(url, context.abort)
    } catch (e: any) {
      return fail("download_failed", `下载草稿失败：${e?.message ?? e}`, { title: "下载失败" })
    }
    const job = await runPIL({
      inputs: { img: buf },
      params: { low: args.low ?? 64, high: args.high ?? 160 },
      outputs: ["sketch"],
      code: `
im=load('img').convert('RGB')
la=imgops.line_art(im, low=int(PARAMS['low']), high=int(PARAMS['high']))
la.save(OUT['sketch'],'PNG')
st=imgops.composition_stats(im)
emit(width=la.width, height=la.height, composition=st)
`,
      timeoutMs: 90_000,
      signal: context.abort,
    })
    if (!job.ok || !job.files?.sketch) return fail("sketch_failed", `线稿生成失败：${job.stderr}`, { title: "线稿失败" })

    let pubUrl: string
    try {
      pubUrl = await uploadBlob(blobPath("sketch"), job.files.sketch, "image/png", context.abort)
    } catch (e: any) {
      return fail("upload_failed", `上传公网失败：${e?.message ?? e}`, { title: "上传失败" })
    }

    let annotation: string | null = null
    if (args.annotate) {
      const v = await vlmAskJson([pubUrl], "这是黑白线稿。用一句中文点出构图骨架（主体位置/视线/留白）与最大问题。输出 JSON：{\"note\":\"...\"}", 400)
      annotation = v.ok ? String((v.data as any)?.note ?? "") : `（VLM 不可达：${v.reason}）`
    }

    return ok(
      {
        title: "黑白线稿锁定完成",
        url: pubUrl,
        size: `${job.result?.width}x${job.result?.height}`,
        composition: (job.result as any)?.composition ?? null,
        annotation,
        mechanism: "deterministic_edge",
        note: "line_art=灰度→FIND_EDGES→自动阈值反转（黑线白底）；composition 为 PIL 像素统计（零 LLM）。低成本构图验证，非重绘。",
      },
      { url: pubUrl },
    )
  },
})
