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

// 名場面序列一致性（2026-08-31 片2）：場面清單 × 同一角色 DNA 後綴 → 序列圖組。
// 誠實機制：一致性=共用 DNA 後綴 + 統一 model/size；平台不支持 seed 鎖定，seed 標 null。

export default tool({
  description:
    "序列一致性圖組：scenes 填場面清單 JSON 陣列字串 [{id, description}]，character_dna 填角色鎖定卡（cast_asset_lock/character_dna_turnaround）的 DNA 後綴，逐鏡注入同一 DNA 後綴 + 統一 model/size 批量生圖，輸出跨圖一致性序列。誠實：平台不支持 seed（seed 標 null），一致性靠 DNA 後綴錨定而非種子鎖定；metadata.consistency_mechanism 如實記錄。dry_run=true 只返回請求清單與報價，不提交生圖。計費同 image_generate 站點鏈。",
  args: {
    scenes: tool.schema
      .string()
      .describe('場面清單 JSON 陣列字串，如 [{"id":"M1","description":"雨中告白"}]'),
    character_dna: tool.schema.string().describe("角色 DNA 後綴（鎖定卡返回的 dna_suffix / 外觀描述，逐幀原樣注入）"),
    style_anchor: tool.schema.string().optional().describe("全序列風格錨"),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求清單與報價，不提交生圖"),
  },
  async execute(args, context) {
    const parsed = parseJsonArray(args.scenes, "scenes")
    if (!parsed.ok) return fail("invalid_scenes", parsed.hint, { title: "輸入非法" })
    const dna = args.character_dna.trim()
    if (!dna) return fail("missing_dna", "character_dna 不能為空（先跑 cast_asset_lock / character_dna_turnaround 拿後綴）", { title: "輸入非法" })
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
    if (missing.length) return fail("missing_description", `場面 ${missing.join(",")} 缺 description`, { title: "輸入非法" })
    if (args.dry_run) {
      return ok({ title: `story_sequence_consistency dry_run：${reqs.length} 場`, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `序列一致性圖組：${reqs.length} 場（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生圖失敗", ...batch.detail })
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
        title: `序列圖組：${sequence.filter((s) => s.status === "succeeded").length}/${sequence.length} 場`,
        sequence,
        consistency_mechanism: "shared character DNA suffix injected verbatim into every frame + unified model/size; platform seed uncontrollable (seed:null)",
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
      },
      { sequence, consistency_mechanism: "shared DNA suffix + unified model/size; seed:null (platform limitation)", total_cost_coins: batch.total_cost_coins },
    )
  },
})
