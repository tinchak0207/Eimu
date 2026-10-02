import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  parseJsonArray,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// 場景包批量（2026-08-31 片2）：商品 DNA 後綴固定 × 場景清單 → 多場景一致圖組。
// 與 scene_pack 的差別只在 DNA 來源（product_lock 的 dna_summary 直接餵進來）。

export default tool({
  description:
    "場景包批量：product_dna 填商品 DNA 摘要（product_lock 返回的 dna_summary 或自給），scenes 填場景清單 JSON 陣列字串（如 [\"大理石桌面\",\"沙灘日落\"]），商品 DNA 後綴固定注入每個場景 prompt，批量生圖輸出多場景一致場景包。每張含 url+prompt+task_id+seed(null)。dry_run=true 只返回請求清單與報價（場景數張），不提交生圖。計費同 image_generate 站點鏈。注意：本工具是文字生圖（DNA 描述錨定），要像素級產品保真請用 product_conditioned_generation 編輯鏈。",
  args: {
    product_dna: tool.schema.string().describe("商品 DNA 摘要文字（product_lock 的 dna_summary 最佳）"),
    scenes: tool.schema.string().describe('場景清單 JSON 陣列字串，如 ["marble table studio shot","beach at sunset"]'),
    style_anchor: tool.schema.string().optional().describe("場景包統一風格錨"),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求清單與報價，不提交生圖"),
  },
  async execute(args, context) {
    const dna = args.product_dna.trim()
    if (!dna) return fail("missing_dna", "product_dna 不能為空", { title: "輸入非法" })
    const parsed = parseJsonArray(args.scenes, "scenes")
    if (!parsed.ok) return fail("invalid_scenes", parsed.hint, { title: "輸入非法" })
    const style = args.style_anchor ? `, ${args.style_anchor}` : ""
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs = parsed.value.map((s, i) => {
      const scene = String(typeof s === "string" ? s : s?.scene ?? s?.description ?? "").trim()
      const tag = String(typeof s === "object" && s?.id ? s.id : `scene${i + 1}`)
      if (!scene) return { tag, prompt: "", model, size, n: 1 }
      return {
        tag,
        prompt: `commercial product photography scene: ${scene}, hero product placed naturally in scene, exact product fidelity — ${dna}, consistent lighting language across the pack${style}`,
        model,
        size,
        n: 1,
      }
    })
    const bad = reqs.filter((r) => !r.prompt).map((r) => r.tag)
    if (bad.length) return fail("missing_scene", `場景 ${bad.join(",")} 描述為空`, { title: "輸入非法" })
    if (args.dry_run) {
      return ok({ title: `scene_pack_batch dry_run：${reqs.length} 個場景`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `場景包：${reqs.length} 張（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生圖失敗", ...batch.detail })
    const pack = batch.results.map((r) => ({
      scene: r.tag,
      prompt: r.prompt,
      task_id: r.task_id,
      status: r.status,
      url: r.url,
      seed: null,
      cost_coins: r.cost_coins,
      ...(r.error ? { error: r.error } : {}),
    }))
    return ok(
      {
        title: `場景包：${pack.filter((p) => p.status === "succeeded").length}/${pack.length} 張`,
        pack,
        dna_used: dna,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
      },
      { pack, total_cost_coins: batch.total_cost_coins },
    )
  },
})
