import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, parseUrlArray } from "../lib/batch5-matting"

// 离群审计 + 重生指令（2026-08-31 片5）：成组图 → VLM 逐图与群体/风格锚的一致性评分 →
// 统计离群（z-score）→ 对离群图输出修正重生 prompt（不自动生图，扣费决策留给 agent/confirm）。
// 单次 VLM 呼叫带全部图（省呼叫预算），TS 端做 z-score 排名。

const OUTLIER_Q =
  "这是一组应风格/主题一致的图（按输入顺序编号 0..N-1）。" +
  "请逐图评估其与『整组共识风格/主题』的一致性，输出 JSON：" +
  '{"scores":[{"index":0,"consistency":0.0~1.0,"deviation":"该图偏离群体之处（若一致则空）","fix_prompt":"若偏离，给一段可让重生贴合群体的英文 prompt 修正指令（一致则空）"}, ...每图一项],' +
  '"group_summary":"一句话描述整组共识风格/主题"}' +
  " consistency 越高越贴合群体。只输出 JSON。"

function zScores(vals: number[]): number[] {
  const n = vals.length
  if (n < 2) return vals.map(() => 0)
  const mean = vals.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
  if (sd < 1e-9) return vals.map(() => 0)
  return vals.map((v) => Math.round(((v - mean) / sd) * 100) / 100)
}

export default tool({
  description:
    "离群审计 + 重生指令（零生图扣费，仅 VLM）：image_urls（成组图 URL JSON 阵列，2-12 张）+ 可选 anchor（风格/主题锚文字，如 style_dna/garment_dna 的 prompt_suffix）→ VLM 逐图给与群体（及锚）的一致性评分 → TS 端 z-score 统计离群（consistency z<-1 或排名末位标 outlier）→ 对离群图输出修正重生 prompt。输出每图 score/deviation_z/outlier/证据 + 汇总离群清单与重生指令清单。诚实：consistency 为 VLM 目测非像素量化；重生指令只给 prompt 不自动生图（扣费决策留给 agent/用户 confirm）。VLM 不可达回 ok:false 不编造。",
  args: {
    image_urls: tool.schema.string().describe('成组图 URL JSON 阵列字串，例 ["https://...","https://..."]'),
    anchor: tool.schema.string().optional().describe("可选：风格/主题一致性锚文字（如 DNA prompt_suffix）"),
    outlier_z: tool.schema.number().min(0.5).max(3).optional().describe("离群 z 阈值（consistency z < -阈值 判离群），默认 1.0"),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 2, max: 12 })
    if (!p.ok) return fail(p.code, p.hint, { title: "输入非法" })
    const anchor = args.anchor?.trim()
    const thr = args.outlier_z ?? 1.0
    const q = anchor ? `${OUTLIER_Q}\n\n【一致性锚（额外对齐目标）】\n${anchor}` : OUTLIER_Q
    const v = await vlmAskJson(p.urls, q, 2000)
    if (!v.ok) return fail("vlm_unavailable", `VLM 审计失败：${v.reason}（未编造评分）`, { title: "离群审计失败" })
    const raw = (v.data as Record<string, unknown>).scores
    if (!Array.isArray(raw)) return fail("bad_schema", "VLM 回覆缺 scores 阵列", { title: "离群审计失败" })
    const byIndex = new Map<number, Record<string, unknown>>()
    for (const s of raw as Record<string, unknown>[]) {
      const idx = Number(s.index)
      if (Number.isInteger(idx) && idx >= 0 && idx < p.urls.length) byIndex.set(idx, s)
    }
    const consistency: number[] = []
    const perImage: Record<string, unknown>[] = []
    for (let i = 0; i < p.urls.length; i++) {
      const s = byIndex.get(i) || {}
      let c = typeof s.consistency === "number" ? s.consistency : Number(s.consistency)
      if (!Number.isFinite(c)) c = 0.5
      c = Math.max(0, Math.min(1, c))
      consistency.push(c)
      perImage.push({
        index: i,
        url: p.urls[i],
        consistency: Math.round(c * 100) / 100,
        deviation: typeof s.deviation === "string" ? s.deviation : "",
        fix_prompt: typeof s.fix_prompt === "string" ? s.fix_prompt : "",
      })
    }
    const zs = zScores(consistency)
    const ranked = [...consistency].map((c, i) => ({ i, c })).sort((a, b) => a.c - b.c)
    const rankOf = new Map<number, number>()
    ranked.forEach((r, pos) => rankOf.set(r.i, pos + 1))
    const outliers: Record<string, unknown>[] = []
    for (let i = 0; i < perImage.length; i++) {
      const z = zs[i]
      const isOutlier = z < -thr || (p.urls.length >= 4 && rankOf.get(i) === 1 && consistency[i] < 0.6)
      perImage[i].deviation_z = z
      perImage[i].rank_lowest = rankOf.get(i)
      perImage[i].outlier = isOutlier
      if (isOutlier) outliers.push({ index: i, url: p.urls[i], consistency: perImage[i].consistency, deviation_z: z, deviation: perImage[i].deviation, regenerate_prompt: perImage[i].fix_prompt || null })
    }
    return ok(
      {
        title: `离群审计完成（${p.urls.length} 张，离群 ${outliers.length}）`,
        group_summary: typeof (v.data as Record<string, unknown>).group_summary === "string" ? (v.data as Record<string, unknown>).group_summary : "",
        anchor_used: anchor || null,
        outlier_z_threshold: thr,
        per_image: perImage,
        outliers,
        regenerate_instructions: outliers.map((o) => ({ url: o.url, index: o.index, corrected_prompt: o.regenerate_prompt })),
        mechanism: "vlm_group_consistency + zscore",
        note: "诚实：consistency 为 VLM 目测；outlier 判定 = consistency z<-阈值 或（≥4 张时）最低分且<0.6；regenerate_instructions 仅给 prompt，未自动生图（扣费留给 agent/confirm）。",
      },
      { outlier_count: outliers.length },
    )
  },
})
