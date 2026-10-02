import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, normHex, parseUrlArray } from "../lib/batch5-matting"

// 風格 DNA 解構表（2026-08-31 片5）：參考圖 URL(s) → VLM 讀圖輸出四欄結構化解構表
// （筆觸/色板/構圖/光照，每欄附置信）+ 可注入生圖 prompt 的後綴。
// 與片3 style_anchor_sref 的區別：那個輸出 sref token 錨（穩定哈希 + 純後綴），
// 這個輸出「四欄解構表」——每欄帶 confidence，且支持傳入 DNA 草稿做正式化校準。
// 共用 lib：normHex / vlmAskJson 皆取自 batch5-matting（轉出 img-orchestrate）。

const STYLE_TABLE_Q =
  "這是風格參考圖（可能多張，代表同一風格）。把風格解構成四欄表格，輸出 JSON：" +
  '{"brushwork":{"value":"筆觸/媒材/繪畫質感（具體）","confidence":0.0~1.0},' +
  '"palette":{"value":"色板描述","hexes":["#主色","#輔色",...4-6個],"confidence":0.0~1.0},' +
  '"composition":{"value":"構圖傾向（視角/留白/主體位置/景深）","confidence":0.0~1.0},' +
  '"lighting":{"value":"光照/色溫/氛圍","confidence":0.0~1.0},' +
  '"english_suffix":"一段簡短英文風格後綴，可直接追加到生圖 prompt 末尾，精確描述筆觸色板構圖光照"}'

const STYLE_TABLE_Q_WITH_DRAFT = STYLE_TABLE_Q.replace(
  "這是風格參考圖（可能多張，代表同一風格）。",
  "這是風格參考圖（可能多張，代表同一風格）。用戶已提供一份 DNA 草稿，請以圖為準校準/補全草稿，輸出正式解構表。",
)

function conf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

export default tool({
  description:
    "風格 DNA 解構表（零生圖扣費，僅 VLM 讀圖）：image_urls（風格參考圖 URL JSON 陣列，1-6 張）→ VLM 蒸餾四欄結構化解構表（筆觸/色板 HEX/構圖/光照，每欄附 0~1 置信）+ 一段可注入生圖 prompt 的英文後綴。可選 draft（DNA 草稿文字）：傳入時 VLM 以圖為準校準草稿輸出正式表。與 style_anchor_sref 的分工：sref 工具產穩定 token 錨，本工具產「帶置信的四欄解構表」供人工核准/結構化引用。誠實：置信為 VLM 自評非實測；色板已正規化為小寫 6 位 HEX。VLM 不可達回 ok:false 不編造。",
  args: {
    image_urls: tool.schema.string().describe('風格參考圖 URL JSON 陣列字串，例 ["https://..."]'),
    draft: tool.schema.string().optional().describe("可選：風格 DNA 草稿文字，傳入則 VLM 校準成正式表"),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "輸入非法" })
    const draft = args.draft?.trim()
    const q = draft ? `${STYLE_TABLE_Q_WITH_DRAFT}\n\n【DNA 草稿】\n${draft}` : STYLE_TABLE_Q
    const v = await vlmAskJson(p.urls, q, 1400)
    if (!v.ok) return fail("vlm_unavailable", `VLM 讀風格圖失敗：${v.reason}（未編造解構表）`, { title: "風格解構失敗" })
    const d = v.data as Record<string, unknown>
    const cell = (k: string): { value: string; confidence: number } => {
      const o = (d[k] && typeof d[k] === "object" ? d[k] : {}) as Record<string, unknown>
      return { value: typeof o.value === "string" ? o.value.trim() : "", confidence: conf(o.confidence) }
    }
    const brushwork = cell("brushwork")
    const composition = cell("composition")
    const lighting = cell("lighting")
    const palObj = (d.palette && typeof d.palette === "object" ? d.palette : {}) as Record<string, unknown>
    const paletteHexes = Array.isArray(palObj.hexes) ? (palObj.hexes.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
    const palette = { value: typeof palObj.value === "string" ? palObj.value.trim() : "", hexes: paletteHexes, confidence: conf(palObj.confidence) }
    const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""
    if (!brushwork.value && !palette.value && !composition.value && !lighting.value && !enSuffix) {
      return fail("empty_dna", "VLM 回覆未含任何風格欄位", { title: "風格解構失敗" })
    }
    const parts: string[] = []
    if (enSuffix) parts.push(enSuffix)
    if (brushwork.value) parts.push(`brushwork: ${brushwork.value}`)
    if (paletteHexes.length) parts.push(`palette: ${paletteHexes.join(", ")}`)
    if (composition.value) parts.push(`composition: ${composition.value}`)
    if (lighting.value) parts.push(`lighting: ${lighting.value}`)
    const suffix = parts.join("; ")
    const table = { brushwork, palette, composition, lighting }
    const avgConf = Math.round(((brushwork.confidence + palette.confidence + composition.confidence + lighting.confidence) / 4) * 100) / 100
    return ok(
      {
        title: draft ? "風格 DNA 正式解構表（已校準草稿）" : "風格 DNA 解構表",
        style_dna_table: table,
        prompt_suffix: suffix,
        avg_confidence: avgConf,
        calibrated_from_draft: !!draft,
        source_refs: p.urls,
        mechanism: "vlm_style_deconstruction_table",
        usage: "四欄表供人工核准/結構化引用；prompt_suffix 可直接追加到生圖 prompt 末尾。",
        note: "誠實：confidence 為 VLM 自評（非實測）；palette.hexes 已正規化為小寫 6 位 HEX。與 style_anchor_sref 分工：本工具出表，sref 工具出 token 錨。",
      },
      { avg_confidence: avgConf, suffix },
    )
  },
})
