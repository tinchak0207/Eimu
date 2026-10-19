import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { createHash } from "node:crypto"
import { vlmAskJson } from "../lib/img-orchestrate"

// 风格锚（sref 级固定后缀）（2026-08-31 片3）：风格参考图 → VLM 读图输出四栏风格 DNA
// （笔触/色板 HEX/构图/光照）→ 合成一段可注入生图 prompt 的固定后缀 + 结构化 DNA JSON。
// 诚实：这是「文字级风格锚」（把风格蒸馏成稳定可复用的 prompt 后缀），非 Midjourney 的 sref 参数；
// 与片2 product_lock 的 DNA 后缀同学——后续所有生图 prompt 追加该后缀即得风格一致性锚定。

const STYLE_Q =
  "这是风格参考图（可能多张，代表同一风格）。提炼可复用的风格 DNA 供 AI 生图追加，输出 JSON：" +
  '{"brushwork":"笔触/媒材/绘画质感（中英文皆可，具体）",' +
  '"palette":["主色 HEX","#辅色 HEX",... 4-6 个],' +
  '"composition":"构图倾向（视角/留白/主体位置/景深）",' +
  '"lighting":"光照/色温/氛围",' +
  '"english_suffix":"一段简短英文风格后缀，可直接追加到生图 prompt 末尾，精确描述笔触色板构图光照"}'

function normHex(s: unknown): string | null {
  if (typeof s !== "string") return null
  const m = s.trim().match(/#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/)
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split("").map((c) => c + c).join("")
  return "#" + h.toLowerCase()
}

export default tool({
  description:
    "风格锚 / sref 级固定后缀（零生图扣费，仅 VLM 读图）：image_urls（风格参考图 URL JSON 阵列，1+ 张）→ VLM 蒸馏四栏风格 DNA（笔触/色板 HEX/构图/光照），合成一段可直接追加到后续生图 prompt 末尾的固定后缀 + 结构化 DNA JSON + 稳定锚 token（DNA 杂凑，同图同 token）。诚实：这是文字级风格锚（prompt 后缀复用），不是 Midjourney 的 --sref 参数，也不产图；要像素级风格迁移请走生图/编辑链。VLM 不可达回 ok:false 不编造。",
  args: {
    image_urls: tool.schema.string().describe('风格参考图 URL JSON 阵列字串，例 ["https://..."]'),
    language: tool.schema.string().optional().describe("后缀语言偏好：en（默认，生图模型友好）或 zh"),
  },
  async execute(args, context) {
    let urls: string[] = []
    try {
      const j = JSON.parse(args.image_urls)
      if (!Array.isArray(j)) return fail("invalid_image_urls", "image_urls 必须是 JSON 阵列字串", { title: "输入非法" })
      urls = j.filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x.trim())).map((s) => s.trim())
    } catch {
      return fail("invalid_image_urls", "image_urls 必须是合法 JSON 阵列字串", { title: "输入非法" })
    }
    if (!urls.length) return fail("empty_input", "image_urls 至少一个合法 http(s) URL", { title: "输入缺失" })
    if (urls.length > 6) return fail("too_many", "风格参考单次最多 6 张", { title: "输入过多" })

    const v = await vlmAskJson(urls, STYLE_Q, 1200)
    if (!v.ok) return fail("vlm_unavailable", `VLM 读风格图失败：${v.reason}（未编造 DNA）`, { title: "风格抽取失败" })
    const d = v.data as Record<string, unknown>

    const brushwork = typeof d.brushwork === "string" ? d.brushwork.trim() : ""
    const composition = typeof d.composition === "string" ? d.composition.trim() : ""
    const lighting = typeof d.lighting === "string" ? d.lighting.trim() : ""
    const palette = Array.isArray(d.palette) ? (d.palette.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
    const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""

    if (!brushwork && !composition && !lighting && !palette.length && !enSuffix) {
      return fail("empty_dna", "VLM 回覆未含任何风格栏位", { title: "风格抽取失败" })
    }

    // 合成固定后缀（四栏 + 英文段），供后续生图 prompt 直接追加
    const parts: string[] = []
    if (enSuffix) parts.push(enSuffix)
    if (brushwork) parts.push(`brushwork: ${brushwork}`)
    if (palette.length) parts.push(`palette: ${palette.join(", ")}`)
    if (composition) parts.push(`composition: ${composition}`)
    if (lighting) parts.push(`lighting: ${lighting}`)
    const suffix = parts.join("; ")

    const dna = { brushwork, palette, composition, lighting, english_suffix: enSuffix || null }
    const token = "sref-" + createHash("sha256").update(JSON.stringify(dna)).digest("hex").slice(0, 12)

    return ok(
      {
        title: `风格锚已锁定（${token}）`,
        style_anchor_token: token,
        prompt_suffix: suffix,
        style_dna: dna,
        source_refs: urls,
        mechanism: "text_style_anchor",
        usage: "把 prompt_suffix 原样追加到后续每次生图 prompt 末尾，即得该风格的文字级锚定（同 token=同风格 DNA）。",
        note: "诚实：文字级风格锚（可复用 prompt 后缀），非 Midjourney --sref 参数、不产图；palette 已正规化为小写 6 位 HEX。",
      },
      { token, suffix },
    )
  },
})
