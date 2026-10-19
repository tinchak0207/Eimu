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

// 场景包批量（2026-08-31 片2）：商品 DNA 后缀固定 × 场景清单 → 多场景一致图组。
// 与 scene_pack 的差别只在 DNA 来源（product_lock 的 dna_summary 直接喂进来）。

export default tool({
  description:
    "场景包批量：product_dna 填商品 DNA 摘要（product_lock 返回的 dna_summary 或自给），scenes 填场景清单 JSON 阵列字串（如 [\"大理石桌面\",\"沙滩日落\"]），商品 DNA 后缀固定注入每个场景 prompt，批量生图输出多场景一致场景包。每张含 url+prompt+task_id+seed(null)。dry_run=true 只返回请求清单与报价（场景数张），不提交生图。计费同 image_generate 站点链。注意：本工具是文字生图（DNA 描述锚定），要像素级产品保真请用 product_conditioned_generation 编辑链。",
  args: {
    product_dna: tool.schema.string().describe("商品 DNA 摘要文字（product_lock 的 dna_summary 最佳）"),
    scenes: tool.schema.string().describe('场景清单 JSON 阵列字串，如 ["marble table studio shot","beach at sunset"]'),
    style_anchor: tool.schema.string().optional().describe("场景包统一风格锚"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求清单与报价，不提交生图"),
  },
  async execute(args, context) {
    const dna = args.product_dna.trim()
    if (!dna) return fail("missing_dna", "product_dna 不能为空", { title: "输入非法" })
    const parsed = parseJsonArray(args.scenes, "scenes")
    if (!parsed.ok) return fail("invalid_scenes", parsed.hint, { title: "输入非法" })
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
    if (bad.length) return fail("missing_scene", `场景 ${bad.join(",")} 描述为空`, { title: "输入非法" })
    if (args.dry_run) {
      return ok({ title: `scene_pack_batch dry_run：${reqs.length} 个场景`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `场景包：${reqs.length} 张（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生图失败", ...batch.detail })
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
        title: `场景包：${pack.filter((p) => p.status === "succeeded").length}/${pack.length} 张`,
        pack,
        dna_used: dna,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
      },
      { pack, total_cost_coins: batch.total_cost_coins },
    )
  },
})
