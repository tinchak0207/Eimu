import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, parseUrlArray, parseStringArray, permilleBboxToPx, downloadImage, runPIL } from "../lib/batch5-matting"

// 賣點→圖內證據映射（2026-08-31 片5）：圖 URL + 賣點清單 → VLM 讀圖逐賣點找證據區域
// （歸一化千分比 bbox + 置信）；找不到證據的賣點進缺失清單，誠實標 confidence，不編造。

const EVIDENCE_Q_TMPL = (points: string[]) =>
  "這是一張商品/詳情頁圖。請針對下列每個賣點，在圖中定位能支撐它的證據區域（若圖中確無對應證據則 found=false，禁止編造）。\n" +
  "賣點清單（按序）：\n" +
  points.map((pt, i) => `${i}. ${pt}`).join("\n") +
  "\n輸出 JSON：{\"evidence\":[{\"index\":0,\"found\":true|false,\"bbox\":[x1,y1,x2,y2]（千分比 0-1000，found=false 時 null）,\"confidence\":0.0~1.0,\"region\":\"該證據區域的具體描述（看到了什麼支撐該賣點）\",\"missing_reason\":\"found=false 時說明圖中為何無證據，否則空\"}, ...每賣點一項]}。只輸出 JSON。"

export default tool({
  description:
    "賣點→圖內證據映射（零生圖扣費，僅 VLM 讀圖）：image_url（詳情頁/商品圖 URL）+ selling_points（賣點清單 JSON 陣列）→ VLM 逐賣點在圖中定位證據區域（歸一化千分比 bbox + 換算像素 + 置信 + 區域描述）；圖中無對應證據的賣點誠實標 found=false 進缺失清單，不編造。輸出 mappings（每賣點 bbox/confidence/證據描述）+ missing（缺證據賣點）+ 覆蓋率。誠實：bbox/confidence 為 VLM 目測非實測檢測器；confidence 低表示證據間接。VLM 不可達回 ok:false。",
  args: {
    image_url: tool.schema.string().describe("詳情頁/商品圖 URL（http(s)）"),
    selling_points: tool.schema.string().describe('賣點清單 JSON 陣列字串，例 ["防水面料","四針六線"]'),
  },
  async execute(args, context) {
    const imageUrl = args.image_url?.trim() || ""
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必須是 http(s) URL", { title: "輸入非法" })
    const sp = parseStringArray(args.selling_points, { min: 1, max: 20 })
    if (!sp.ok) return fail(sp.code, sp.hint, { title: "賣點清單非法" })

    let w = 0
    let h = 0
    try {
      const buf = await downloadImage(imageUrl, context.abort)
      const j = await runPIL({ inputs: { in: buf }, outputs: [], code: `im=load('in').convert('RGB')\nemit(w=im.width,h=im.height)`, timeoutMs: 30_000, signal: context.abort })
      if (j.ok) { w = Number(j.result?.w) || 0; h = Number(j.result?.h) || 0 }
    } catch { /* 尺寸留 0，bbox 僅回千分比 */ }

    const v = await vlmAskJson([imageUrl], EVIDENCE_Q_TMPL(sp.items), 2200)
    if (!v.ok) return fail("vlm_unavailable", `VLM 讀圖失敗：${v.reason}（未編造證據）`, { title: "證據映射失敗" })
    const raw = (v.data as Record<string, unknown>).evidence
    if (!Array.isArray(raw)) return fail("bad_schema", "VLM 回覆缺 evidence 陣列", { title: "證據映射失敗" })
    const byIndex = new Map<number, Record<string, unknown>>()
    for (const e of raw as Record<string, unknown>[]) {
      const idx = Number(e.index)
      if (Number.isInteger(idx) && idx >= 0 && idx < sp.items.length) byIndex.set(idx, e)
    }
    const mappings: Record<string, unknown>[] = []
    const missing: string[] = []
    let foundCount = 0
    for (let i = 0; i < sp.items.length; i++) {
      const e = byIndex.get(i) || {}
      const found = e.found === true
      let conf = typeof e.confidence === "number" ? e.confidence : Number(e.confidence)
      if (!Number.isFinite(conf)) conf = 0
      conf = Math.max(0, Math.min(1, Math.round(conf * 100) / 100))
      const bboxPx = found && w && h ? permilleBboxToPx(e.bbox, w, h) : null
      const row: Record<string, unknown> = {
        index: i,
        selling_point: sp.items[i],
        found,
        confidence: found ? conf : 0,
        bbox_permille: found && Array.isArray(e.bbox) ? e.bbox : null,
        bbox_px: bboxPx,
        region: typeof e.region === "string" ? e.region : "",
      }
      if (!found) {
        row.missing_reason = typeof e.missing_reason === "string" ? e.missing_reason : "圖中未見對應證據"
        missing.push(sp.items[i])
      } else foundCount++
      mappings.push(row)
    }
    return ok(
      {
        title: `賣點證據映射（${foundCount}/${sp.items.length} 有證據）`,
        image_url: imageUrl,
        image_size: w && h ? `${w}x${h}` : null,
        coverage: Math.round((foundCount / sp.items.length) * 100) / 100,
        mappings,
        missing,
        mechanism: "vlm_claim_to_region_grounding",
        note: "誠實：bbox/confidence 為 VLM 目測非檢測器實測；found=false 的賣點進 missing，未編造證據；bbox_px 依實測尺寸換算（尺寸探測失敗時僅回千分比）。",
      },
      { coverage: foundCount / sp.items.length, missing_count: missing.length },
    )
  },
})
