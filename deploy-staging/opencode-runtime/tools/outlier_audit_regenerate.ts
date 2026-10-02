import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, parseUrlArray } from "../lib/batch5-matting"

// 離群審計 + 重生指令（2026-08-31 片5）：成組圖 → VLM 逐圖與群體/風格錨的一致性評分 →
// 統計離群（z-score）→ 對離群圖輸出修正重生 prompt（不自動生圖，扣費決策留給 agent/confirm）。
// 單次 VLM 呼叫帶全部圖（省呼叫預算），TS 端做 z-score 排名。

const OUTLIER_Q =
  "這是一組應風格/主題一致的圖（按輸入順序編號 0..N-1）。" +
  "請逐圖評估其與『整組共識風格/主題』的一致性，輸出 JSON：" +
  '{"scores":[{"index":0,"consistency":0.0~1.0,"deviation":"該圖偏離群體之處（若一致則空）","fix_prompt":"若偏離，給一段可讓重生貼合群體的英文 prompt 修正指令（一致則空）"}, ...每圖一項],' +
  '"group_summary":"一句話描述整組共識風格/主題"}' +
  " consistency 越高越貼合群體。只輸出 JSON。"

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
    "離群審計 + 重生指令（零生圖扣費，僅 VLM）：image_urls（成組圖 URL JSON 陣列，2-12 張）+ 可選 anchor（風格/主題錨文字，如 style_dna/garment_dna 的 prompt_suffix）→ VLM 逐圖給與群體（及錨）的一致性評分 → TS 端 z-score 統計離群（consistency z<-1 或排名末位標 outlier）→ 對離群圖輸出修正重生 prompt。輸出每圖 score/deviation_z/outlier/證據 + 匯總離群清單與重生指令清單。誠實：consistency 為 VLM 目測非像素量化；重生指令只給 prompt 不自動生圖（扣費決策留給 agent/用戶 confirm）。VLM 不可達回 ok:false 不編造。",
  args: {
    image_urls: tool.schema.string().describe('成組圖 URL JSON 陣列字串，例 ["https://...","https://..."]'),
    anchor: tool.schema.string().optional().describe("可選：風格/主題一致性錨文字（如 DNA prompt_suffix）"),
    outlier_z: tool.schema.number().min(0.5).max(3).optional().describe("離群 z 閾值（consistency z < -閾值 判離群），默認 1.0"),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 2, max: 12 })
    if (!p.ok) return fail(p.code, p.hint, { title: "輸入非法" })
    const anchor = args.anchor?.trim()
    const thr = args.outlier_z ?? 1.0
    const q = anchor ? `${OUTLIER_Q}\n\n【一致性錨（額外對齊目標）】\n${anchor}` : OUTLIER_Q
    const v = await vlmAskJson(p.urls, q, 2000)
    if (!v.ok) return fail("vlm_unavailable", `VLM 審計失敗：${v.reason}（未編造評分）`, { title: "離群審計失敗" })
    const raw = (v.data as Record<string, unknown>).scores
    if (!Array.isArray(raw)) return fail("bad_schema", "VLM 回覆缺 scores 陣列", { title: "離群審計失敗" })
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
        title: `離群審計完成（${p.urls.length} 張，離群 ${outliers.length}）`,
        group_summary: typeof (v.data as Record<string, unknown>).group_summary === "string" ? (v.data as Record<string, unknown>).group_summary : "",
        anchor_used: anchor || null,
        outlier_z_threshold: thr,
        per_image: perImage,
        outliers,
        regenerate_instructions: outliers.map((o) => ({ url: o.url, index: o.index, corrected_prompt: o.regenerate_prompt })),
        mechanism: "vlm_group_consistency + zscore",
        note: "誠實：consistency 為 VLM 目測；outlier 判定 = consistency z<-閾值 或（≥4 張時）最低分且<0.6；regenerate_instructions 僅給 prompt，未自動生圖（扣費留給 agent/confirm）。",
      },
      { outlier_count: outliers.length },
    )
  },
})
