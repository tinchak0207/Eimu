import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, parseUrlArray, parseStringArray, permilleBboxToPx, downloadImage, runPIL } from "../lib/batch5-matting"

// 卖点→图内证据映射（2026-08-31 片5）：图 URL + 卖点清单 → VLM 读图逐卖点找证据区域
// （归一化千分比 bbox + 置信）；找不到证据的卖点进缺失清单，诚实标 confidence，不编造。

const EVIDENCE_Q_TMPL = (points: string[]) =>
  "这是一张商品/详情页图。请针对下列每个卖点，在图中定位能支撑它的证据区域（若图中确无对应证据则 found=false，禁止编造）。\n" +
  "卖点清单（按序）：\n" +
  points.map((pt, i) => `${i}. ${pt}`).join("\n") +
  "\n输出 JSON：{\"evidence\":[{\"index\":0,\"found\":true|false,\"bbox\":[x1,y1,x2,y2]（千分比 0-1000，found=false 时 null）,\"confidence\":0.0~1.0,\"region\":\"该证据区域的具体描述（看到了什么支撑该卖点）\",\"missing_reason\":\"found=false 时说明图中为何无证据，否则空\"}, ...每卖点一项]}。只输出 JSON。"

export default tool({
  description:
    "卖点→图内证据映射（零生图扣费，仅 VLM 读图）：image_url（详情页/商品图 URL）+ selling_points（卖点清单 JSON 阵列）→ VLM 逐卖点在图中定位证据区域（归一化千分比 bbox + 换算像素 + 置信 + 区域描述）；图中无对应证据的卖点诚实标 found=false 进缺失清单，不编造。输出 mappings（每卖点 bbox/confidence/证据描述）+ missing（缺证据卖点）+ 覆盖率。诚实：bbox/confidence 为 VLM 目测非实测检测器；confidence 低表示证据间接。VLM 不可达回 ok:false。",
  args: {
    image_url: tool.schema.string().describe("详情页/商品图 URL（http(s)）"),
    selling_points: tool.schema.string().describe('卖点清单 JSON 阵列字串，例 ["防水面料","四针六线"]'),
  },
  async execute(args, context) {
    const imageUrl = args.image_url?.trim() || ""
    if (!/^https?:\/\//.test(imageUrl)) return fail("invalid_image_url", "image_url 必须是 http(s) URL", { title: "输入非法" })
    const sp = parseStringArray(args.selling_points, { min: 1, max: 20 })
    if (!sp.ok) return fail(sp.code, sp.hint, { title: "卖点清单非法" })

    let w = 0
    let h = 0
    try {
      const buf = await downloadImage(imageUrl, context.abort)
      const j = await runPIL({ inputs: { in: buf }, outputs: [], code: `im=load('in').convert('RGB')\nemit(w=im.width,h=im.height)`, timeoutMs: 30_000, signal: context.abort })
      if (j.ok) { w = Number(j.result?.w) || 0; h = Number(j.result?.h) || 0 }
    } catch { /* 尺寸留 0，bbox 仅回千分比 */ }

    const v = await vlmAskJson([imageUrl], EVIDENCE_Q_TMPL(sp.items), 2200)
    if (!v.ok) return fail("vlm_unavailable", `VLM 读图失败：${v.reason}（未编造证据）`, { title: "证据映射失败" })
    const raw = (v.data as Record<string, unknown>).evidence
    if (!Array.isArray(raw)) return fail("bad_schema", "VLM 回覆缺 evidence 阵列", { title: "证据映射失败" })
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
        row.missing_reason = typeof e.missing_reason === "string" ? e.missing_reason : "图中未见对应证据"
        missing.push(sp.items[i])
      } else foundCount++
      mappings.push(row)
    }
    return ok(
      {
        title: `卖点证据映射（${foundCount}/${sp.items.length} 有证据）`,
        image_url: imageUrl,
        image_size: w && h ? `${w}x${h}` : null,
        coverage: Math.round((foundCount / sp.items.length) * 100) / 100,
        mappings,
        missing,
        mechanism: "vlm_claim_to_region_grounding",
        note: "诚实：bbox/confidence 为 VLM 目测非检测器实测；found=false 的卖点进 missing，未编造证据；bbox_px 依实测尺寸换算（尺寸探测失败时仅回千分比）。",
      },
      { coverage: foundCount / sp.items.length, missing_count: missing.length },
    )
  },
})
