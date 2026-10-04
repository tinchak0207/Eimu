import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, normHex, parseUrlArray } from "../lib/batch5-matting"

// 风格 DNA 解构表（2026-08-31 片5）：参考图 URL(s) → VLM 读图输出四栏结构化解构表
// （笔触/色板/构图/光照，每栏附置信）+ 可注入生图 prompt 的后缀。
// 与片3 style_anchor_sref 的区别：那个输出 sref token 锚（稳定哈希 + 纯后缀），
// 这个输出「四栏解构表」——每栏带 confidence，且支持传入 DNA 草稿做正式化校准。
// 共用 lib：normHex / vlmAskJson 皆取自 batch5-matting（转出 img-orchestrate）。

const STYLE_TABLE_Q =
  "这是风格参考图（可能多张，代表同一风格）。把风格解构成四栏表格，输出 JSON：" +
  '{"brushwork":{"value":"笔触/媒材/绘画质感（具体）","confidence":0.0~1.0},' +
  '"palette":{"value":"色板描述","hexes":["#主色","#辅色",...4-6个],"confidence":0.0~1.0},' +
  '"composition":{"value":"构图倾向（视角/留白/主体位置/景深）","confidence":0.0~1.0},' +
  '"lighting":{"value":"光照/色温/氛围","confidence":0.0~1.0},' +
  '"english_suffix":"一段简短英文风格后缀，可直接追加到生图 prompt 末尾，精确描述笔触色板构图光照"}'

const STYLE_TABLE_Q_WITH_DRAFT = STYLE_TABLE_Q.replace(
  "这是风格参考图（可能多张，代表同一风格）。",
  "这是风格参考图（可能多张，代表同一风格）。用户已提供一份 DNA 草稿，请以图为准校准/补全草稿，输出正式解构表。",
)

function conf(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

export default tool({
  description:
    "风格 DNA 解构表（零生图扣费，仅 VLM 读图）：image_urls（风格参考图 URL JSON 阵列，1-6 张）→ VLM 蒸馏四栏结构化解构表（笔触/色板 HEX/构图/光照，每栏附 0~1 置信）+ 一段可注入生图 prompt 的英文后缀。可选 draft（DNA 草稿文字）：传入时 VLM 以图为准校准草稿输出正式表。与 style_anchor_sref 的分工：sref 工具产稳定 token 锚，本工具产「带置信的四栏解构表」供人工核准/结构化引用。诚实：置信为 VLM 自评非实测；色板已正规化为小写 6 位 HEX。VLM 不可达回 ok:false 不编造。",
  args: {
    image_urls: tool.schema.string().describe('风格参考图 URL JSON 阵列字串，例 ["https://..."]'),
    draft: tool.schema.string().optional().describe("可选：风格 DNA 草稿文字，传入则 VLM 校准成正式表"),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "输入非法" })
    const draft = args.draft?.trim()
    const q = draft ? `${STYLE_TABLE_Q_WITH_DRAFT}\n\n【DNA 草稿】\n${draft}` : STYLE_TABLE_Q
    const v = await vlmAskJson(p.urls, q, 1400)
    if (!v.ok) return fail("vlm_unavailable", `VLM 读风格图失败：${v.reason}（未编造解构表）`, { title: "风格解构失败" })
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
      return fail("empty_dna", "VLM 回覆未含任何风格栏位", { title: "风格解构失败" })
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
        title: draft ? "风格 DNA 正式解构表（已校准草稿）" : "风格 DNA 解构表",
        style_dna_table: table,
        prompt_suffix: suffix,
        avg_confidence: avgConf,
        calibrated_from_draft: !!draft,
        source_refs: p.urls,
        mechanism: "vlm_style_deconstruction_table",
        usage: "四栏表供人工核准/结构化引用；prompt_suffix 可直接追加到生图 prompt 末尾。",
        note: "诚实：confidence 为 VLM 自评（非实测）；palette.hexes 已正规化为小写 6 位 HEX。与 style_anchor_sref 分工：本工具出表，sref 工具出 token 锚。",
      },
      { avg_confidence: avgConf, suffix },
    )
  },
})
