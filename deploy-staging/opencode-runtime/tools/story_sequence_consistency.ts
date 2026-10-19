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

// 名场面序列一致性（2026-08-31 片2）：场面清单 × 同一角色 DNA 后缀 → 序列图组。
// 诚实机制：一致性=共用 DNA 后缀 + 统一 model/size；平台不支持 seed 锁定，seed 标 null。

export default tool({
  description:
    "序列一致性图组：scenes 填场面清单 JSON 阵列字串 [{id, description}]，character_dna 填角色锁定卡（cast_asset_lock/character_dna_turnaround）的 DNA 后缀，逐镜注入同一 DNA 后缀 + 统一 model/size 批量生图，输出跨图一致性序列。诚实：平台不支持 seed（seed 标 null），一致性靠 DNA 后缀锚定而非种子锁定；metadata.consistency_mechanism 如实记录。dry_run=true 只返回请求清单与报价，不提交生图。计费同 image_generate 站点链。",
  args: {
    scenes: tool.schema
      .string()
      .describe('场面清单 JSON 阵列字串，如 [{"id":"M1","description":"雨中告白"}]'),
    character_dna: tool.schema.string().describe("角色 DNA 后缀（锁定卡返回的 dna_suffix / 外观描述，逐帧原样注入）"),
    style_anchor: tool.schema.string().optional().describe("全序列风格锚"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求清单与报价，不提交生图"),
  },
  async execute(args, context) {
    const parsed = parseJsonArray(args.scenes, "scenes")
    if (!parsed.ok) return fail("invalid_scenes", parsed.hint, { title: "输入非法" })
    const dna = args.character_dna.trim()
    if (!dna) return fail("missing_dna", "character_dna 不能为空（先跑 cast_asset_lock / character_dna_turnaround 拿后缀）", { title: "输入非法" })
    const style = args.style_anchor ? `, ${args.style_anchor}` : ""
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const total = parsed.value.length
    const missing: string[] = []
    const reqs = parsed.value.map((s, i) => {
      const id = String(s?.id ?? `M${i + 1}`).trim()
      const desc = String(s?.description ?? s?.action ?? "").trim()
      if (!desc) missing.push(id)
      return {
        tag: id,
        prompt: `story sequence frame ${i + 1} of ${total}: ${desc}, consistent character design — ${dna}, identical art style, lighting and palette across the whole sequence${style}`,
        model,
        size,
        n: 1,
      }
    })
    if (missing.length) return fail("missing_description", `场面 ${missing.join(",")} 缺 description`, { title: "输入非法" })
    if (args.dry_run) {
      return ok({ title: `story_sequence_consistency dry_run：${reqs.length} 场`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `序列一致性图组：${reqs.length} 场（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生图失败", ...batch.detail })
    const sequence = batch.results.map((r) => ({
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
        title: `序列图组：${sequence.filter((s) => s.status === "succeeded").length}/${sequence.length} 场`,
        sequence,
        consistency_mechanism: "shared character DNA suffix injected verbatim into every frame + unified model/size; platform seed uncontrollable (seed:null)",
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
      },
      { sequence, consistency_mechanism: "shared DNA suffix + unified model/size; seed:null (platform limitation)", total_cost_coins: batch.total_cost_coins },
    )
  },
})
