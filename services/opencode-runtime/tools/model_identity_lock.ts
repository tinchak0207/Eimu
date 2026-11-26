import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { vlmAskJson, parseUrlArray } from "../lib/batch5-matting"
import { SEED_NOTE } from "../lib/img-orchestrate"

// 模特身份锁定卡（2026-08-31 片5）：模特参考图组 → VLM 结构化描述（面部/体态/发型/辨识点）
// 作身份锚 + 参考图集 + 固定 seed 栏（平台不支持 seed，诚实标 null）+ 可注入 tryon/生图的 DNA 后缀。
// 诚实机制声明：本工具用 VLM 结构化文字描述作身份锚，非 IP-Adapter FaceID / insightface embedding
// （VPS 内存紧张 + insightface CPU 装配超预算，未采那条路；description 如实写实际机制）。

const IDENTITY_Q =
  "这是同一位模特的参考图组（可能多张）。提炼可复用的身份描述供 AI 生图/试穿保持一致，输出 JSON：" +
  '{"face":"面部结构（脸型/眼型/鼻型/唇形/肤色）",' +
  '"hair":"发型/发色/长度/质感",' +
  '"body":"体态（身高感/体型/比例/肩宽）",' +
  '"distinguishing":"辨识点（痣/酒窝/纹身/气质等）",' +
  '"age_range":"推测年龄区间",' +
  '"ethnicity_presented":"呈现的族裔/地域特征（客观描述，供一致性用）",' +
  '"english_identity_suffix":"一段简短英文，精确描述该模特面部发型体态，可直接追加到生图/试穿 prompt 末尾以保持身份一致"}'

export default tool({
  description:
    "模特身份锁定卡（零生图扣费，仅 VLM 读图）：image_urls（同一模特参考图 URL JSON 阵列，1-6 张）→ VLM 结构化抽取身份描述（面部/发型/体态/辨识点/年龄区间/族裔呈现）+ 一段可注入 tryon/生图 prompt 的英文身份后缀 + 参考图集 + seed 栏。诚实机制：身份锚为 VLM 文字级结构化描述（非 IP-Adapter FaceID / insightface embedding——VPS 内存与装配预算下未采该路，如实声明）；平台 /v1/images/generations 不支持 seed，seed 诚实标 null，跨图一致性靠共用身份后缀 + 统一 model/size + 参考图集锚定。VLM 不可达回 ok:false 不编造。",
  args: {
    image_urls: tool.schema.string().describe('模特参考图 URL JSON 阵列字串，例 ["https://..."]'),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "输入非法" })
    const v = await vlmAskJson(p.urls, IDENTITY_Q, 1600)
    if (!v.ok) return fail("vlm_unavailable", `VLM 读模特图失败：${v.reason}（未编造身份卡）`, { title: "身份锁定失败" })
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
      return fail("empty_identity", "VLM 回覆未含任何身份栏位", { title: "身份锁定失败" })
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
        title: `模特身份卡已锁定（${sig}）`,
        identity_card: card,
        identity_signature: sig,
        prompt_suffix: suffix,
        reference_images: p.urls,
        seed: null,
        seed_policy: SEED_NOTE,
        mechanism: "vlm_structured_identity_anchor (NOT FaceID embedding)",
        usage: "把 prompt_suffix 追加到 tryon/生图 prompt 末尾 + 附 reference_images 作视觉参考，即得该模特的文字级身份锚（同签名=同身份描述）。",
        note: "诚实：身份锚为 VLM 结构化文字描述，非 FaceID/insightface embedding；seed 平台不支持标 null；一致性靠后缀+参考图集，非魔法编码。",
      },
      { signature: sig, suffix, seed: null },
    )
  },
})
