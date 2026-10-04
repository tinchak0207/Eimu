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

// 关键帧渲染（2026-08-31 片2）：分镜清单 × 角色 DNA → 逐镜首帧/尾帧双图。
// 每镜构造 first/last frame prompt（注入 DNA 后缀），批量生图，按镜编号返回。

export default tool({
  description:
    "逐镜关键帧：shots 填分镜 JSON 阵列字串 [{id, action}]（action=镜头内动作/画面描述），character_dna 填角色锁定卡返回的 DNA 后缀（可选，注入每个 prompt 保一致性），每镜输出首帧+尾帧双图（first/last frame，供视频首尾帧模型直接喂；最小粒度 2 张/镜——单镜头需求也按首尾两张计费）。结果按镜编号返回，每帧含 url+prompt+task_id+seed(null)。dry_run=true 只返回全部请求清单与报价（镜数×2 张），不提交生图。计费同 image_generate 站点链。",
  args: {
    shots: tool.schema
      .string()
      .describe('分镜清单 JSON 阵列字串，如 [{"id":"S01","action":"女主推门进入昏暗房间"}]'),
    character_dna: tool.schema.string().optional().describe("角色 DNA 后缀（character_dna_turnaround/cast_asset_lock 返回的 dna_suffix 或外观描述）"),
    style_anchor: tool.schema.string().optional().describe("全片风格锚（附加到每个 prompt）"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求清单与报价，不提交生图"),
  },
  async execute(args, context) {
    const parsed = parseJsonArray(args.shots, "shots")
    if (!parsed.ok) return fail("invalid_shots", parsed.hint, { title: "输入非法" })
    const dna = args.character_dna ? `, consistent character — ${args.character_dna}` : ""
    const style = args.style_anchor ? `, ${args.style_anchor}` : ""
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs: { tag: string; prompt: string; model: string; size: string; n: number }[] = []
    for (const s of parsed.value) {
      const id = String(s?.id ?? `S${reqs.length / 2 + 1}`).trim()
      const action = String(s?.action ?? s?.description ?? "").trim()
      if (!action) return fail("missing_action", `镜 ${id} 缺 action 描述`, { title: "输入非法" })
      reqs.push({ tag: `${id}-first`, prompt: `film keyframe, first frame of shot ${id}: ${action}, cinematic composition${dna}${style}`, model, size, n: 1 })
      reqs.push({ tag: `${id}-last`, prompt: `film keyframe, last frame of shot ${id}: ${action}, end state of the action, same scene and camera continuity${dna}${style}`, model, size, n: 1 })
    }
    if (args.dry_run) {
      return ok({ title: `keyframe_render dry_run：${parsed.value.length} 镜 × 首尾帧 = ${reqs.length} 张`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `关键帧渲染：${reqs.length} 张首尾帧（${model}）`, { tool: "keyframe_render", label: "渲染关键帧" })
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生图失败", ...batch.detail })
    const byShot: Record<string, Record<string, unknown>> = {}
    for (const r of batch.results) {
      const [shot, frame] = r.tag.split(/-(first|last)$/)
      byShot[shot] = byShot[shot] || {}
      byShot[shot][frame!] = { prompt: r.prompt, task_id: r.task_id, status: r.status, url: r.url, seed: null, cost_coins: r.cost_coins, ...(r.error ? { error: r.error } : {}) }
    }
    const keyframes = Object.entries(byShot).map(([shot, frames]) => ({ shot, ...frames }))
    return ok(
      {
        title: `关键帧：${keyframes.length} 镜完成`,
        keyframes,
        total_cost_coins: batch.total_cost_coins,
        quoted_cost_coins: batch.quoted_cost_coins,
        cost_known: batch.cost_known,
        unpriced_items: batch.unpriced_items,
        cost_suspect: batch.cost_suspect,
        ...(batch.cost_suspect ? { cost_suspect_items: batch.cost_suspect_items } : {}),
        seed_policy: SEED_NOTE,
      },
      {
        keyframes,
        total_cost_coins: batch.total_cost_coins,
        quoted_cost_coins: batch.quoted_cost_coins,
        cost_known: batch.cost_known,
        unpriced_items: batch.unpriced_items,
        cost_suspect: batch.cost_suspect,
      },
    )
  },
})
