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

// 条件化模特图生成（2026-08-31 片2）。诚实机制（spec 红线）：
// 主路径 = /images/edits 编辑链（商品图作编辑基准，同 image_edit.ts 计费链），
// metadata.consistency_mechanism 如实记录；生成后 VLM 抽检 1 次形变判定 pass/warn，
// 不宣称绝对零形变。

const CHECK_QUESTION =
  "图1 是商品原图，图2 是 AI 条件化生成的模特/场景图。对比图2 中的商品与图1：形态、色彩、标志是否保持一致？输出 JSON：{\"deformation\":\"pass|warn\",\"notes\":\"简短理由\"}。pass=形态色彩标志基本一致；warn=任何可见形变、色偏、标志丢失或结构改动。"

export default tool({
  description:
    "条件化模特图：product_image_url 填商品图，composition 填模特/场景构图描述。主路径=站点编辑链 /images/edits（商品图作编辑基准，同 image_edit 计费链，非文字重绘）；编辑链不可用时诚实回退=VLM 抽 DNA + generations 文字锚定生图（不宣称像素保真）。metadata.consistency_mechanism 如实记录实际走的路径；生成后 VLM（gemini-2.5-flash-image）自动抽检 1 次形变，vlm_check 给 pass/warn。诚实：不宣称绝对零形变——warn 时建议重生成或降构图复杂度。dry_run=true 只返回编辑请求（prompt/模型/端点）与机制说明，不提交、不扣费。",
  args: {
    product_image_url: tool.schema.string().describe("商品原图 URL（编辑基准）"),
    composition: tool.schema.string().describe("模特/场景构图描述（如：Asian female model holding the product, cafe table, soft window light）"),
    product_dna: tool.schema.string().optional().describe("可选：商品 DNA 摘要（product_lock 的 dna_summary），附加到编辑指令"),
    model: tool.schema.string().optional().describe(`编辑模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.enum(["1k", "2k"]).optional().describe("尺寸等级 1k/2k（编辑链契约），默认 1k"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求构造，不提交生图"),
  },
  async execute(args, context) {
    const productUrl = args.product_image_url.trim()
    const comp = args.composition.trim()
    if (!/^https?:\/\//.test(productUrl)) return fail("invalid_product_url", "product_image_url 必须是 http(s) URL", { title: "输入非法" })
    if (!comp) return fail("missing_composition", "composition 不能为空", { title: "输入非法" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = args.size ?? "1k"
    const dna = args.product_dna ? ` Product must match this DNA exactly: ${args.product_dna.trim()}.` : ""
    const prompt = `Place this exact product into a new scene with zero product deformation: ${comp}. Keep the product's shape, proportions, colors, materials and logo pixel-faithful to the reference; only the scene/model/lighting change.${dna}`
    const mechanismPlan =
      "image_edit 指令式：站点 /v1/images/edits 编辑链，商品原图作编辑基准（同 image_edit.ts 计费链，reserve/commit 在站点端）；优先 mediaId（/v1/uploads），uploads 桥故障时自动回退原 URL 直传，实际模式见执行的 consistency_mechanism。"
    if (args.dry_run) {
      return ok({
        title: "product_conditioned_generation dry_run",
        dry_run: true,
        requests: [{ tag: "conditioned", endpoint: "/v1/images/edits", image_url: productUrl, prompt, model, size }],
        expected_images: 1,
        consistency_mechanism: mechanismPlan,
        note: "dry_run：未提交、未扣费。实际执行后会自动 VLM 抽检 1 次形变（pass/warn）。",
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
      mechanism = `image_edit 指令式：站点 /v1/images/edits 编辑链，商品原图作编辑基准（image_mode=${edit.image_mode}${edit.image_mode === "raw_url" ? "，/v1/uploads 桥故障故原 URL 直传" : ""}；计费同 image_edit，reserve/commit 在站点端，非文字重绘）。`
    } else {
      // 2026-08-31 实测：站点 /v1/uploads（mediaId）上游桥 404、raw URL 透传亦被拒，
      // 编辑链整体暂不可用（image_edit 工具同受影响，失败已自动退款）。诚实回退：
      // VLM 免费抽 DNA → generations 文字锚定生图（站点无参考图生图契约，
      // 机制如实记录，不宣称像素保真）。
      let dnaText = args.product_dna?.trim() || ""
      if (!dnaText) {
        const dna = await vlmAskJson(
          [productUrl],
          "提炼此商品的形态/材质/色彩/标志，输出 JSON：{\"english_summary\":\"一段简短英文精确描述商品形态材质色彩供生图用\"}",
          1500,
        )
        dnaText = dna.ok && typeof dna.data?.english_summary === "string" ? dna.data.english_summary.trim() : ""
      }
      const fallbackPrompt = `commercial photography: ${comp}, hero product with exact product fidelity — ${dnaText || "product consistent with the described reference"}, no text overlay`
      const batch = await runGenBatch(
        [{ tag: "conditioned", prompt: fallbackPrompt, model, size: "1024x1024", n: 1 }],
        context.sessionID,
        context.abort,
        `条件化生成（编辑链回退文字锚定，${model}）`,
      )
      if (!batch.ok) return fail(batch.code, batch.hint, { title: "条件化生成失败（编辑链与回退链皆失败）", ...batch.detail })
      const r0 = batch.results[0]
      if (r0.status !== "succeeded" || !r0.url) return fail("fallback_failed", `回退生图失败：${r0.error || "无 URL"}`, { title: "条件化生成失败" })
      url = r0.url
      costCoins = r0.cost_coins
      taskId = r0.task_id || ""
      mechanism = `回退链：DNA 文字锚定生图 /v1/images/generations（编辑链失败原因 ${edit.code}:${edit.hint}；站点无参考图生图契约，本路径不宣称像素级保真，仅 DNA 文字一致性）。`
    }
    const check = await vlmAskJson([productUrl, url], CHECK_QUESTION, 1500)
    const verdict = check.ok ? String(check.data?.deformation ?? "unknown") : "unavailable"
    return ok(
      {
        title: `条件化模特图完成（VLM 抽检：${verdict}）`,
        url,
        task_id: taskId,
        cost_coins: costCoins,
        prompt,
        seed: null,
        consistency_mechanism: mechanism,
        vlm_check: check.ok ? { verdict, notes: String(check.data?.notes ?? "") } : { verdict: "unavailable", notes: check.reason },
        seed_policy: SEED_NOTE,
        note: "诚实：不宣称绝对零形变。verdict=warn 时建议重生成、简化 composition 或等编辑链（/v1/uploads 桥）修复后重试。",
      },
      { url, consistency_mechanism: mechanism, vlm_check: check.ok ? { verdict, notes: String(check.data?.notes ?? "") } : { verdict: "unavailable" }, cost_coins: costCoins },
    )
  },
})
