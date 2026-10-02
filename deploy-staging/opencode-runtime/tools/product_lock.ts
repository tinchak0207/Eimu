import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  planRequests,
  runGenBatch,
  vlmAskJson,
} from "../lib/img-orchestrate"

// 商品 DNA 鎖定（2026-08-31 片2）：VLM 讀商品圖 → 結構化 DNA（形態/材質/色彩 HEX/標誌位置）
// → 生 1 張白底基準圖作色彩錨。誠實：基準圖是文字重繪的色彩/形態參考錨，非像素級複製；
// 要產品零形變的條件化出圖請用 product_conditioned_generation（編輯鏈）。

const VLM_QUESTION =
  "這是商品圖。提煉商品 DNA 供 AI 生圖複用，輸出 JSON：{\"form\":\"形態輪廓描述\",\"material\":\"材質\",\"colors\":[\"主色 HEX\",\"輔色 HEX\",...],\"logo_position\":\"標誌/圖案位置，無則 null\",\"distinguishing_features\":\"辨識特徵（倒角/縫線/按鈕等）\",\"english_summary\":\"一段簡短英文，精確描述商品形態材質色彩供生圖 prompt 用\"}"

export default tool({
  description:
    "商品 DNA 鎖定：image_url 填商品圖 URL。VLM（gemini-2.5-flash-image）讀圖輸出結構化 DNA（形態/材質/色彩 HEX/標誌位置/辨識特徵），再生 1 張白底基準圖作色彩錨，全部進 metadata 供 scene_pack_batch / product_conditioned_generation 等後續引用。誠實：白底基準圖是 DNA 文字重繪的參考錨（非像素級複製），需產品零形變請走 product_conditioned_generation 編輯鏈；平台不支持 seed，seed 標 null。dry_run=true 仍執行 VLM（內部通道零扣費）給完整 prompt，但不提交生圖。",
  args: {
    image_url: tool.schema.string().describe("商品圖 URL"),
    model: tool.schema.string().optional().describe(`基準圖生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只做 VLM 抽取並返回請求清單，不提交生圖"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url.trim()
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    const vlm = await vlmAskJson([imageUrl], VLM_QUESTION, 2000)
    const dna = vlm.ok ? vlm.data : null
    const summary =
      dna && typeof dna.english_summary === "string" && dna.english_summary.trim()
        ? dna.english_summary.trim()
        : "maintain exact product form, material and colors as described in DNA"
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const prompt = `professional product photography, single product on pure white seamless background, soft even studio lighting, centered, no props, no text, exact product fidelity — ${summary}`
    const reqs = [{ tag: "baseline", prompt, model, size, n: 1 }]
    if (args.dry_run) {
      return ok({
        title: "product_lock dry_run",
        product_dna: dna,
        vlm_status: vlm.ok ? "ok" : `unavailable: ${vlm.reason}`,
        ...(await planRequests(reqs, context.sessionID, context.abort)),
      })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `商品 DNA 白底基準圖（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生圖失敗", ...batch.detail })
    const r0 = batch.results[0]
    return ok(
      {
        title: "商品 DNA 鎖定完成",
        product_dna: dna,
        vlm_status: vlm.ok ? "ok" : `unavailable: ${vlm.reason}`,
        dna_summary: summary,
        baseline_prompt: r0.prompt,
        baseline_url: r0.url,
        task_id: r0.task_id,
        status: r0.status,
        seed: null,
        cost_coins: r0.cost_coins,
        ...(r0.error ? { error: r0.error } : {}),
        seed_policy: SEED_NOTE,
        note: "product_dna + dna_summary 即商品一致性錨點，後續場景包/條件化生成直接引用；baseline_url 為色彩參考錨（文字重繪，非像素複製）。",
      },
      { product_dna: dna, dna_summary: summary, baseline_url: r0.url, seed: null },
    )
  },
})
