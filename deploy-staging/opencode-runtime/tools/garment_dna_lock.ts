import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, normHex, parseUrlArray } from "../lib/batch5-matting"

// 服裝 DNA 鎖定（2026-08-31 片5）：服裝資產圖 URL(s) → VLM 讀圖結構化抽取服裝 DNA
// （版型/材質/色板 HEX/工藝線索）→ 合成可注入生圖 prompt 的 DNA 後綴。零生圖扣費。
// 與片2 product_lock 同套路（VLM 抽 DNA + 英文摘要後綴），差別：本工具專精服裝欄位、
// 支持多張同品參考、不產基準圖（純抽取）。

const GARMENT_DNA_Q =
  "這是服裝單品圖（可能多張，代表同一件服裝的不同角度）。提煉服裝 DNA 供 AI 生圖/試穿複用，輸出 JSON：" +
  '{"silhouette":"版型/輪廓（如 A字裙/修身/oversize/高腰）",' +
  '"fit":"合身度與剪裁線索",' +
  '"material":"材質/面料（如 亞麻/牛仔/針織/雪紡）",' +
  '"colors":["主色 HEX","#輔色 HEX",... 3-6 個],' +
  '"craft":"工藝線索（縫線/拉鏈/鈕扣/口袋/印花/刺繡/水洗等）",' +
  '"details":"其他辨識細節",' +
  '"english_suffix":"一段簡短英文，精確描述該服裝版型材質色彩工藝，可直接追加到生圖/試穿 prompt 末尾"}'

export default tool({
  description:
    "服裝 DNA 鎖定（零生圖扣費，僅 VLM 讀圖）：image_urls（服裝資產圖 URL JSON 陣列，1-6 張，可為 garment_extract 的透明底產物或原圖）→ VLM（gemini-2.5-flash-image）蒸餾服裝 DNA（版型/合身/材質/色板 HEX/工藝線索/細節）+ 一段可注入生圖或試穿 prompt 的英文後綴。輸出結構化 DNA JSON + prompt_suffix + 穩定簽名（DNA 雜湊）。誠實：這是文字級服裝身份錨（prompt 後綴複用），非像素級實例編碼；色板已正規化為小寫 6 位 HEX。VLM 不可達回 ok:false 不編造。",
  args: {
    image_urls: tool.schema.string().describe('服裝資產圖 URL JSON 陣列字串，例 ["https://..."]'),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "輸入非法" })
    const v = await vlmAskJson(p.urls, GARMENT_DNA_Q, 1400)
    if (!v.ok) return fail("vlm_unavailable", `VLM 讀服裝圖失敗：${v.reason}（未編造 DNA）`, { title: "服裝 DNA 抽取失敗" })
    const d = v.data as Record<string, unknown>
    const silhouette = typeof d.silhouette === "string" ? d.silhouette.trim() : ""
    const fit = typeof d.fit === "string" ? d.fit.trim() : ""
    const material = typeof d.material === "string" ? d.material.trim() : ""
    const craft = typeof d.craft === "string" ? d.craft.trim() : ""
    const details = typeof d.details === "string" ? d.details.trim() : ""
    const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""
    const colors = Array.isArray(d.colors) ? (d.colors.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
    if (!silhouette && !material && !colors.length && !craft && !enSuffix) {
      return fail("empty_dna", "VLM 回覆未含任何服裝 DNA 欄位", { title: "服裝 DNA 抽取失敗" })
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
        title: `服裝 DNA 已鎖定（${sig}）`,
        garment_dna: dna,
        dna_signature: sig,
        prompt_suffix: suffix,
        source_refs: p.urls,
        mechanism: "vlm_garment_dna_anchor",
        usage: "把 prompt_suffix 追加到生圖/試穿 prompt 末尾，即得該服裝的文字級身份錨（同簽名=同 DNA）。",
        note: "誠實：文字級服裝 DNA（可複用 prompt 後綴），非像素級編碼；colors 已正規化為小寫 6 位 HEX。",
      },
      { signature: sig, suffix },
    )
  },
})
