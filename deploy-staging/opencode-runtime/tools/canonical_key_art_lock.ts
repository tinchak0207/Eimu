import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// KV 主视觉锁定（2026-08-31 片2）：风格锚+主体 → hero（英雄构图）+ cta（负空间版）两版，
// 锁定卡 metadata（url+prompt+seed:null）供全案复用。

export default tool({
  description:
    "主视觉 KV 锁定：subject 填主体描述（或产品 DNA + 模特图描述），style_anchor 填风格锚，生成两版锁定卡——hero（英雄构图：主体居中、戏剧光效）与 cta（标题/CTA 负空间版：上部留白、构图让位文案）。两版 url+prompt+task_id+seed 进 metadata 作全案视觉基准。平台不支持 seed，seed 诚实标 null。dry_run=true 只返回两版请求清单与报价，不提交生图。计费同 image_generate 站点链（>0.1 币先确认）。",
  args: {
    subject: tool.schema.string().describe("主体描述（人物/产品/场景，英文短语生图效果最佳）"),
    style_anchor: tool.schema.string().optional().describe("风格锚（如 cinematic teal-orange grade, 35mm film grain）"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求清单与报价，不提交生图"),
  },
  async execute(args, context) {
    const subject = args.subject.trim()
    if (!subject) return fail("missing_subject", "subject 不能为空", { title: "输入非法" })
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
      return ok({ title: "canonical_key_art_lock dry_run：hero + cta 两版", ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `KV 主视觉锁定：hero+cta 两版（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "生图失败", ...batch.detail })
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
        title: `KV 锁定卡：${cards.filter((c) => c.status === "succeeded").length}/2 成功`,
        cards,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "hero=英雄构图版主视觉；cta=带负空间的文案排版版。后续延展以本卡 prompt+url 为风格基准。",
      },
      { cards, total_cost_coins: batch.total_cost_coins },
    )
  },
})
