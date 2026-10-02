import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { downloadImage, uploadBlob, runPIL, blobPath } from "../lib/img-composite"
import { vlmAskJson } from "../lib/img-orchestrate"

// 黑白線稿鎖定（2026-08-31 片3）：構圖草稿 → 邊緣線稿 + 構圖元數據。
// 純確定性 PIL（灰度→FIND_EDGES→自動閾值反轉），零 LLM 依賴；可選 VLM 註解。
// 誠實：這是低成本構圖驗證（把草稿壓成黑白線稿看結構），非 AI 重繪/美化。

export default tool({
  description:
    "黑白線稿鎖定（純確定性 PIL，零生圖扣費、默認零 LLM）：image_url 填構圖草稿 → 灰度轉邊緣（FIND_EDGES + 95 百分位自動閾值反轉）輸出黑線白底線稿公網 URL，並附 PIL 統計的構圖元數據（主體重心/留白比例/三分線偏差/邊緣能量）。誠實：這是低成本構圖驗證（壓線稿看結構骨架），不是 AI 重繪或美化，也不產出新構圖。annotate=true 才額外調 VLM 給一句構圖註解（默認關，省呼叫）。",
  args: {
    image_url: tool.schema.string().describe("構圖草稿 URL"),
    low: tool.schema.number().int().min(0).max(255).optional().describe("邊緣閾值下限，默認 64"),
    high: tool.schema.number().int().min(0).max(255).optional().describe("自動閾值上限參考，默認 160"),
    annotate: tool.schema.boolean().optional().describe("true=額外調 VLM 給一句構圖註解（默認 false）"),
  },
  async execute(args, context) {
    const url = args.image_url.trim()
    if (!/^https?:\/\//.test(url)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    let buf: Buffer
    try {
      buf = await downloadImage(url, context.abort)
    } catch (e: any) {
      return fail("download_failed", `下載草稿失敗：${e?.message ?? e}`, { title: "下載失敗" })
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
    if (!job.ok || !job.files?.sketch) return fail("sketch_failed", `線稿生成失敗：${job.stderr}`, { title: "線稿失敗" })

    let pubUrl: string
    try {
      pubUrl = await uploadBlob(blobPath("sketch"), job.files.sketch, "image/png", context.abort)
    } catch (e: any) {
      return fail("upload_failed", `上傳公網失敗：${e?.message ?? e}`, { title: "上傳失敗" })
    }

    let annotation: string | null = null
    if (args.annotate) {
      const v = await vlmAskJson([pubUrl], "這是黑白線稿。用一句中文點出構圖骨架（主體位置/視線/留白）與最大問題。輸出 JSON：{\"note\":\"...\"}", 400)
      annotation = v.ok ? String((v.data as any)?.note ?? "") : `（VLM 不可達：${v.reason}）`
    }

    return ok(
      {
        title: "黑白線稿鎖定完成",
        url: pubUrl,
        size: `${job.result?.width}x${job.result?.height}`,
        composition: (job.result as any)?.composition ?? null,
        annotation,
        mechanism: "deterministic_edge",
        note: "line_art=灰度→FIND_EDGES→自動閾值反轉（黑線白底）；composition 為 PIL 像素統計（零 LLM）。低成本構圖驗證，非重繪。",
      },
      { url: pubUrl },
    )
  },
})
