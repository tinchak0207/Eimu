import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, parseUrlArray } from "../lib/batch5-matting"
import { SEED_NOTE } from "../lib/img-orchestrate"

// 模特身份鎖定卡（2026-08-31 片5）：模特參考圖組 → VLM 結構化描述（面部/體態/髮型/辨識點）
// 作身份錨 + 參考圖集 + 固定 seed 欄（平台不支持 seed，誠實標 null）+ 可注入 tryon/生圖的 DNA 後綴。
// 誠實機制聲明：本工具用 VLM 結構化文字描述作身份錨，非 IP-Adapter FaceID / insightface embedding
// （VPS 內存緊張 + insightface CPU 裝配超預算，未採那條路；description 如實寫實際機制）。

const IDENTITY_Q =
  "這是同一位模特的參考圖組（可能多張）。提煉可複用的身份描述供 AI 生圖/試穿保持一致，輸出 JSON：" +
  '{"face":"面部結構（臉型/眼型/鼻型/唇形/膚色）",' +
  '"hair":"髮型/髮色/長度/質感",' +
  '"body":"體態（身高感/體型/比例/肩寬）",' +
  '"distinguishing":"辨識點（痣/酒窩/紋身/氣質等）",' +
  '"age_range":"推測年齡區間",' +
  '"ethnicity_presented":"呈現的族裔/地域特徵（客觀描述，供一致性用）",' +
  '"english_identity_suffix":"一段簡短英文，精確描述該模特面部髮型體態，可直接追加到生圖/試穿 prompt 末尾以保持身份一致"}'

export default tool({
  description:
    "模特身份鎖定卡（零生圖扣費，僅 VLM 讀圖）：image_urls（同一模特參考圖 URL JSON 陣列，1-6 張）→ VLM 結構化抽取身份描述（面部/髮型/體態/辨識點/年齡區間/族裔呈現）+ 一段可注入 tryon/生圖 prompt 的英文身份後綴 + 參考圖集 + seed 欄。誠實機制：身份錨為 VLM 文字級結構化描述（非 IP-Adapter FaceID / insightface embedding——VPS 內存與裝配預算下未採該路，如實聲明）；平台 /v1/images/generations 不支持 seed，seed 誠實標 null，跨圖一致性靠共用身份後綴 + 統一 model/size + 參考圖集錨定。VLM 不可達回 ok:false 不編造。",
  args: {
    image_urls: tool.schema.string().describe('模特參考圖 URL JSON 陣列字串，例 ["https://..."]'),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "輸入非法" })
    const v = await vlmAskJson(p.urls, IDENTITY_Q, 1600)
    if (!v.ok) return fail("vlm_unavailable", `VLM 讀模特圖失敗：${v.reason}（未編造身份卡）`, { title: "身份鎖定失敗" })
    const d = v.data as Record<string, unknown>
    const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string).trim() : "")
    const face = str("face")
    const hair = str("hair")
    const body = str("body")
    const distinguishing = str("distinguishing")
    const ageRange = str("age_range")
    const ethnicity = str("ethnicity_presented")
    const enSuffix = str("english_identity_suffix")
    if (!face && !hair && !body && !enSuffix) {
      return fail("empty_identity", "VLM 回覆未含任何身份欄位", { title: "身份鎖定失敗" })
    }
    const parts: string[] = []
    if (enSuffix) parts.push(enSuffix)
    if (face) parts.push(`face: ${face}`)
    if (hair) parts.push(`hair: ${hair}`)
    if (body) parts.push(`body: ${body}`)
    if (distinguishing) parts.push(`distinguishing: ${distinguishing}`)
    const suffix = parts.join("; ")
    const card = { face, hair, body, distinguishing: distinguishing || null, age_range: ageRange || null, ethnicity_presented: ethnicity || null, english_identity_suffix: enSuffix || null }
    const { createHash } = await import("node:crypto")
    const sig = "model-" + createHash("sha256").update(JSON.stringify(card)).digest("hex").slice(0, 12)
    return ok(
      {
        title: `模特身份卡已鎖定（${sig}）`,
        identity_card: card,
        identity_signature: sig,
        prompt_suffix: suffix,
        reference_images: p.urls,
        seed: null,
        seed_policy: SEED_NOTE,
        mechanism: "vlm_structured_identity_anchor (NOT FaceID embedding)",
        usage: "把 prompt_suffix 追加到 tryon/生圖 prompt 末尾 + 附 reference_images 作視覺參考，即得該模特的文字級身份錨（同簽名=同身份描述）。",
        note: "誠實：身份錨為 VLM 結構化文字描述，非 FaceID/insightface embedding；seed 平台不支持標 null；一致性靠後綴+參考圖集，非魔法編碼。",
      },
      { signature: sig, suffix, seed: null },
    )
  },
})
