import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, normHex, parseUrlArray } from "../lib/batch5-matting"

// 服装 DNA 锁定（2026-08-31 片5）：服装资产图 URL(s) → VLM 读图结构化抽取服装 DNA
// （版型/材质/色板 HEX/工艺线索）→ 合成可注入生图 prompt 的 DNA 后缀。零生图扣费。
// 与片2 product_lock 同套路（VLM 抽 DNA + 英文摘要后缀），差别：本工具专精服装栏位、
// 支持多张同品参考、不产基准图（纯抽取）。

const GARMENT_DNA_Q =
  "这是服装单品图（可能多张，代表同一件服装的不同角度）。提炼服装 DNA 供 AI 生图/试穿复用，输出 JSON：" +
  '{"silhouette":"版型/轮廓（如 A字裙/修身/oversize/高腰）",' +
  '"fit":"合身度与剪裁线索",' +
  '"material":"材质/面料（如 亚麻/牛仔/针织/雪纺）",' +
  '"colors":["主色 HEX","#辅色 HEX",... 3-6 个],' +
  '"craft":"工艺线索（缝线/拉链/钮扣/口袋/印花/刺绣/水洗等）",' +
  '"details":"其他辨识细节",' +
  '"english_suffix":"一段简短英文，精确描述该服装版型材质色彩工艺，可直接追加到生图/试穿 prompt 末尾"}'

export default tool({
  description:
    "服装 DNA 锁定（零生图扣费，仅 VLM 读图）：image_urls（服装资产图 URL JSON 阵列，1-6 张，可为 garment_extract 的透明底产物或原图）→ VLM（gemini-2.5-flash-image）蒸馏服装 DNA（版型/合身/材质/色板 HEX/工艺线索/细节）+ 一段可注入生图或试穿 prompt 的英文后缀。输出结构化 DNA JSON + prompt_suffix + 稳定签名（DNA 杂凑）。诚实：这是文字级服装身份锚（prompt 后缀复用），非像素级实例编码；色板已正规化为小写 6 位 HEX。VLM 不可达回 ok:false 不编造。",
  args: {
    image_urls: tool.schema.string().describe('服装资产图 URL JSON 阵列字串，例 ["https://..."]'),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "输入非法" })
    const v = await vlmAskJson(p.urls, GARMENT_DNA_Q, 1400)
    if (!v.ok) return fail("vlm_unavailable", `VLM 读服装图失败：${v.reason}（未编造 DNA）`, { title: "服装 DNA 抽取失败" })
    const d = v.data as Record<string, unknown>
    const silhouette = typeof d.silhouette === "string" ? d.silhouette.trim() : ""
    const fit = typeof d.fit === "string" ? d.fit.trim() : ""
    const material = typeof d.material === "string" ? d.material.trim() : ""
    const craft = typeof d.craft === "string" ? d.craft.trim() : ""
    const details = typeof d.details === "string" ? d.details.trim() : ""
    const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""
    const colors = Array.isArray(d.colors) ? (d.colors.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
    if (!silhouette && !material && !colors.length && !craft && !enSuffix) {
      return fail("empty_dna", "VLM 回覆未含任何服装 DNA 栏位", { title: "服装 DNA 抽取失败" })
    }
    const parts: string[] = []
    if (enSuffix) parts.push(enSuffix)
    if (silhouette) parts.push(`silhouette: ${silhouette}`)
    if (material) parts.push(`material: ${material}`)
    if (colors.length) parts.push(`colors: ${colors.join(", ")}`)
    if (craft) parts.push(`craft: ${craft}`)
    const suffix = parts.join("; ")
    const dna = { silhouette, fit: fit || null, material, colors, craft: craft || null, details: details || null, english_suffix: enSuffix || null }
    const { createHash } = await import("node:crypto")
    const sig = "garment-" + createHash("sha256").update(JSON.stringify(dna)).digest("hex").slice(0, 12)
    return ok(
      {
        title: `服装 DNA 已锁定（${sig}）`,
        garment_dna: dna,
        dna_signature: sig,
        prompt_suffix: suffix,
        source_refs: p.urls,
        mechanism: "vlm_garment_dna_anchor",
        usage: "把 prompt_suffix 追加到生图/试穿 prompt 末尾，即得该服装的文字级身份锚（同签名=同 DNA）。",
        note: "诚实：文字级服装 DNA（可复用 prompt 后缀），非像素级编码；colors 已正规化为小写 6 位 HEX。",
      },
      { signature: sig, suffix },
    )
  },
})
