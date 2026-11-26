import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, normHex, parseUrlArray } from "../lib/batch5-matting"

// 文本美学描述，供提示词拼接，不是图像特征锁定。
// 参考图 URL → VLM 读图输出四栏文字（笔触/色板/构图/光照）+ 可拼进生图 prompt 的后缀。
// 不声称 --sref / IP-Adapter，也不把模型随口给的 confidence 当测量值返回。
// 共用 lib：normHex / vlmAskJson 皆取自 batch5-matting（转出 img-orchestrate）。

const STYLE_TABLE_Q =
  "这是风格参考图（可能多张，代表同一风格）。把风格写成四栏文字，输出 JSON：" +
  '{"brushwork":{"value":"笔触/媒材/绘画质感（具体）"},' +
  '"palette":{"value":"色板描述","hexes":["#主色","#辅色",...4-6个]},' +
  '"composition":{"value":"构图倾向（视角/留白/主体位置/景深）"},' +
  '"lighting":{"value":"光照/色温/氛围"},' +
  '"english_suffix":"一段简短英文风格后缀，可直接追加到生图 prompt 末尾，精确描述笔触色板构图光照"}'

const STYLE_TABLE_Q_WITH_DRAFT = STYLE_TABLE_Q.replace(
  "这是风格参考图（可能多张，代表同一风格）。",
  "这是风格参考图（可能多张，代表同一风格）。用户已提供一份 DNA 草稿，请以图为准校准/补全草稿，输出正式解构表。",
)

export default tool({
  description:
    "文本美学描述，供提示词拼接，不是图像特征锁定。image_urls（风格参考图 URL JSON 阵列，1-6 张）→ VLM 写出笔触/色板 HEX/构图/光照四栏文字，加一段可拼进生图 prompt 的英文后缀。不是 --sref，不是 IP-Adapter，不返回数值 confidence（模型自报的数字不是测量值）。可选 draft：传入时按图校准文字。色板正规化为小写 6 位 HEX。VLM 不可达回 ok:false，不编造。零生图扣费。",
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
    const cell = (k: string): { value: string } => {
      const o = (d[k] && typeof d[k] === "object" ? d[k] : {}) as Record<string, unknown>
      return { value: typeof o.value === "string" ? o.value.trim() : "" }
    }
    const brushwork = cell("brushwork")
    const composition = cell("composition")
    const lighting = cell("lighting")
    const palObj = (d.palette && typeof d.palette === "object" ? d.palette : {}) as Record<string, unknown>
    const paletteHexes = Array.isArray(palObj.hexes) ? (palObj.hexes.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
    const palette = { value: typeof palObj.value === "string" ? palObj.value.trim() : "", hexes: paletteHexes }
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
    return ok(
      {
        title: draft ? "风格文字描述（已按草稿校准）" : "风格文字描述",
        style_dna_table: table,
        prompt_suffix: suffix,
        calibrated_from_draft: !!draft,
        source_refs: p.urls,
        mechanism: "vlm_text_aesthetic_description",
        usage: "文本美学描述，供提示词拼接，不是图像特征锁定。prompt_suffix 可直接追加到生图 prompt 末尾。",
        note: "文本美学描述，供提示词拼接，不是图像特征锁定。不是 --sref，不是 IP-Adapter。不返回 confidence：模型随口给的数字不是测量值。palette.hexes 已正规化为小写 6 位 HEX。",
      },
      { suffix },
    )
  },
})
