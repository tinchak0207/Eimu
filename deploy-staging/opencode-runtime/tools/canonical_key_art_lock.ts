import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// KV 主視覺鎖定（2026-08-31 片2）：風格錨+主體 → hero（英雄構圖）+ cta（負空間版）兩版，
// 鎖定卡 metadata（url+prompt+seed:null）供全案複用。

export default tool({
  description:
    "主視覺 KV 鎖定：subject 填主體描述（或產品 DNA + 模特圖描述），style_anchor 填風格錨，生成兩版鎖定卡——hero（英雄構圖：主體居中、戲劇光效）與 cta（標題/CTA 負空間版：上部留白、構圖讓位文案）。兩版 url+prompt+task_id+seed 進 metadata 作全案視覺基準。平台不支持 seed，seed 誠實標 null。dry_run=true 只返回兩版請求清單與報價，不提交生圖。計費同 image_generate 站點鏈（>0.1 幣先確認）。",
  args: {
    subject: tool.schema.string().describe("主體描述（人物/產品/場景，英文短語生圖效果最佳）"),
    style_anchor: tool.schema.string().optional().describe("風格錨（如 cinematic teal-orange grade, 35mm film grain）"),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求清單與報價，不提交生圖"),
  },
  async execute(args, context) {
    const subject = args.subject.trim()
    if (!subject) return fail("missing_subject", "subject 不能為空", { title: "輸入非法" })
    const style = args.style_anchor ? `, ${args.style_anchor}` : ""
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs = [
      {
        tag: "hero",
        prompt: `hero key art, ${subject}, centered heroic composition, dramatic rim lighting, ultra detailed, campaign poster quality${style}`,
        model,
        size,
        n: 1,
      },
      {
        tag: "cta",
        prompt: `key art layout with large clean negative space in the upper third reserved for headline and CTA text, ${subject}, subject placed lower third, minimal background clutter, commercial ad composition${style}`,
        model,
        size,
        n: 1,
      },
    ]
    if (args.dry_run) {
      return ok({ title: "canonical_key_art_lock dry_run：hero + cta 兩版", ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `KV 主視覺鎖定：hero+cta 兩版（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生圖失敗", ...batch.detail })
    const cards = batch.results.map((r) => ({
      variant: r.tag,
      prompt: r.prompt,
      model: r.model,
      size: r.size,
      task_id: r.task_id,
      status: r.status,
      url: r.url,
      seed: null,
      cost_coins: r.cost_coins,
      ...(r.error ? { error: r.error } : {}),
    }))
    return ok(
      {
        title: `KV 鎖定卡：${cards.filter((c) => c.status === "succeeded").length}/2 成功`,
        cards,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "hero=英雄構圖版主視覺；cta=帶負空間的文案排版版。後續延展以本卡 prompt+url 為風格基準。",
      },
      { cards, total_cost_coins: batch.total_cost_coins },
    )
  },
})
