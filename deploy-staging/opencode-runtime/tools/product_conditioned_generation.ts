import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  planRequests,
  runEdit,
  runGenBatch,
  vlmAskJson,
} from "../lib/img-orchestrate"

// 條件化模特圖生成（2026-08-31 片2）。誠實機制（spec 紅線）：
// 主路徑 = /images/edits 編輯鏈（商品圖作編輯基準，同 image_edit.ts 計費鏈），
// metadata.consistency_mechanism 如實記錄；生成後 VLM 抽檢 1 次形變判定 pass/warn，
// 不宣稱絕對零形變。

const CHECK_QUESTION =
  "圖1 是商品原圖，圖2 是 AI 條件化生成的模特/場景圖。對比圖2 中的商品與圖1：形態、色彩、標誌是否保持一致？輸出 JSON：{\"deformation\":\"pass|warn\",\"notes\":\"簡短理由\"}。pass=形態色彩標誌基本一致；warn=任何可見形變、色偏、標誌丟失或結構改動。"

export default tool({
  description:
    "條件化模特圖：product_image_url 填商品圖，composition 填模特/場景構圖描述。主路徑=站點編輯鏈 /images/edits（商品圖作編輯基準，同 image_edit 計費鏈，非文字重繪）；編輯鏈不可用時誠實回退=VLM 抽 DNA + generations 文字錨定生圖（不宣稱像素保真）。metadata.consistency_mechanism 如實記錄實際走的路徑；生成後 VLM（gemini-2.5-flash-image）自動抽檢 1 次形變，vlm_check 給 pass/warn。誠實：不宣稱絕對零形變——warn 時建議重生成或降構圖複雜度。dry_run=true 只返回編輯請求（prompt/模型/端點）與機制說明，不提交、不扣費。",
  args: {
    product_image_url: tool.schema.string().describe("商品原圖 URL（編輯基準）"),
    composition: tool.schema.string().describe("模特/場景構圖描述（如：Asian female model holding the product, cafe table, soft window light）"),
    product_dna: tool.schema.string().optional().describe("可選：商品 DNA 摘要（product_lock 的 dna_summary），附加到編輯指令"),
    model: tool.schema.string().optional().describe(`編輯模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等級 1k/2k（編輯鏈契約），默認 1k"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求構造，不提交生圖"),
  },
  async execute(args, context) {
    const productUrl = args.product_image_url.trim()
    const comp = args.composition.trim()
    if (!/^https?:\/\//.test(productUrl)) return fail("invalid_product_url", "product_image_url 必須是 http(s) URL", { title: "輸入非法" })
    if (!comp) return fail("missing_composition", "composition 不能為空", { title: "輸入非法" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = args.size ?? "1k"
    const dna = args.product_dna ? ` Product must match this DNA exactly: ${args.product_dna.trim()}.` : ""
    const prompt = `Place this exact product into a new scene with zero product deformation: ${comp}. Keep the product's shape, proportions, colors, materials and logo pixel-faithful to the reference; only the scene/model/lighting change.${dna}`
    const mechanismPlan =
      "image_edit 指令式：站點 /v1/images/edits 編輯鏈，商品原圖作編輯基準（同 image_edit.ts 計費鏈，reserve/commit 在站點端）；優先 mediaId（/v1/uploads），uploads 橋故障時自動回退原 URL 直傳，實際模式見執行的 consistency_mechanism。"
    if (args.dry_run) {
      return ok({
        title: "product_conditioned_generation dry_run",
        dry_run: true,
        requests: [{ tag: "conditioned", endpoint: "/v1/images/edits", image_url: productUrl, prompt, model, size }],
        expected_images: 1,
        consistency_mechanism: mechanismPlan,
        note: "dry_run：未提交、未扣費。實際執行後會自動 VLM 抽檢 1 次形變（pass/warn）。",
      })
    }
    const edit = await runEdit(productUrl, prompt, model, size, context.sessionID, context.abort)
    let url: string
    let costCoins: number | null
    let taskId: string
    let mechanism: string
    if (edit.ok) {
      url = edit.url
      costCoins = edit.cost_coins
      taskId = edit.task_id
      mechanism = `image_edit 指令式：站點 /v1/images/edits 編輯鏈，商品原圖作編輯基準（image_mode=${edit.image_mode}${edit.image_mode === "raw_url" ? "，/v1/uploads 橋故障故原 URL 直傳" : ""}；計費同 image_edit，reserve/commit 在站點端，非文字重繪）。`
    } else {
      // 2026-08-31 實測：站點 /v1/uploads（mediaId）上游橋 404、raw URL 透傳亦被拒，
      // 編輯鏈整體暫不可用（image_edit 工具同受影響，失敗已自動退款）。誠實回退：
      // VLM 免費抽 DNA → generations 文字錨定生圖（站點無參考圖生圖契約，
      // 機制如實記錄，不宣稱像素保真）。
      let dnaText = args.product_dna?.trim() || ""
      if (!dnaText) {
        const dna = await vlmAskJson(
          [productUrl],
          "提煉此商品的形態/材質/色彩/標誌，輸出 JSON：{\"english_summary\":\"一段簡短英文精確描述商品形態材質色彩供生圖用\"}",
          1500,
        )
        dnaText = dna.ok && typeof dna.data?.english_summary === "string" ? dna.data.english_summary.trim() : ""
      }
      const fallbackPrompt = `commercial photography: ${comp}, hero product with exact product fidelity — ${dnaText || "product consistent with the described reference"}, no text overlay`
      const batch = await runGenBatch(
        [{ tag: "conditioned", prompt: fallbackPrompt, model, size: "1024x1024", n: 1 }],
        context.sessionID,
        context.abort,
        `條件化生成（編輯鏈回退文字錨定，${model}）`,
      )
      if (!batch.ok) return fail(batch.code, batch.hint, { title: "條件化生成失敗（編輯鏈與回退鏈皆失敗）", ...batch.detail })
      const r0 = batch.results[0]
      if (r0.status !== "succeeded" || !r0.url) return fail("fallback_failed", `回退生圖失敗：${r0.error || "無 URL"}`, { title: "條件化生成失敗" })
      url = r0.url
      costCoins = r0.cost_coins
      taskId = r0.task_id || ""
      mechanism = `回退鏈：DNA 文字錨定生圖 /v1/images/generations（編輯鏈失敗原因 ${edit.code}:${edit.hint}；站點無參考圖生圖契約，本路徑不宣稱像素級保真，僅 DNA 文字一致性）。`
    }
    const check = await vlmAskJson([productUrl, url], CHECK_QUESTION, 1500)
    const verdict = check.ok ? String(check.data?.deformation ?? "unknown") : "unavailable"
    return ok(
      {
        title: `條件化模特圖完成（VLM 抽檢：${verdict}）`,
        url,
        task_id: taskId,
        cost_coins: costCoins,
        prompt,
        seed: null,
        consistency_mechanism: mechanism,
        vlm_check: check.ok ? { verdict, notes: String(check.data?.notes ?? "") } : { verdict: "unavailable", notes: check.reason },
        seed_policy: SEED_NOTE,
        note: "誠實：不宣稱絕對零形變。verdict=warn 時建議重生成、簡化 composition 或等編輯鏈（/v1/uploads 橋）修復後重試。",
      },
      { url, consistency_mechanism: mechanism, vlm_check: check.ok ? { verdict, notes: String(check.data?.notes ?? "") } : { verdict: "unavailable" }, cost_coins: costCoins },
    )
  },
})
