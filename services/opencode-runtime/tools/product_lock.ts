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

// 商品 DNA 锁定（2026-08-31 片2）：VLM 读商品图 → 结构化 DNA（形态/材质/色彩 HEX/标志位置）
// → 生 1 张白底基准图作色彩锚。诚实：基准图是文字重绘的色彩/形态参考锚，非像素级复制；
// 要产品零形变的条件化出图请用 product_conditioned_generation（编辑链）。

const VLM_QUESTION =
  "这是商品图。提炼商品 DNA 供 AI 生图复用，输出 JSON：{\"form\":\"形态轮廓描述\",\"material\":\"材质\",\"colors\":[\"主色 HEX\",\"辅色 HEX\",...],\"logo_position\":\"标志/图案位置，无则 null\",\"distinguishing_features\":\"辨识特征（倒角/缝线/按钮等）\",\"english_summary\":\"一段简短英文，精确描述商品形态材质色彩供生图 prompt 用\"}"

export default tool({
  description:
    "商品 DNA 锁定：image_url 填商品图 URL。VLM（gemini-2.5-flash-image）读图输出结构化 DNA（形态/材质/色彩 HEX/标志位置/辨识特征），再生 1 张白底基准图作色彩锚，全部进 metadata 供 scene_pack_batch / product_conditioned_generation 等后续引用。诚实：白底基准图是 DNA 文字重绘的参考锚（非像素级复制），需产品零形变请走 product_conditioned_generation 编辑链；平台不支持 seed，seed 标 null。dry_run=true 仍执行 VLM（内部通道零扣费）给完整 prompt，但不提交生图。",
  args: {
    image_url: tool.schema.string().describe("商品图 URL"),
    model: tool.schema.string().optional().describe(`基准图生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只做 VLM 抽取并返回请求清单，不提交生图"),
  },
  async execute(args, context) {
    const imageUrl = args.image_url.trim()
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
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
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `商品 DNA 白底基准图（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生图失败", ...batch.detail })
    const r0 = batch.results[0]
    return ok(
      {
        title: "商品 DNA 锁定完成",
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
        note: "product_dna + dna_summary 即商品一致性锚点，后续场景包/条件化生成直接引用；baseline_url 为色彩参考锚（文字重绘，非像素复制）。",
      },
      { product_dna: dna, dna_summary: summary, baseline_url: r0.url, seed: null },
    )
  },
})
