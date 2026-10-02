import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { createHash } from "node:crypto"
import { vlmAskJson } from "../lib/img-orchestrate"

// 風格錨（sref 級固定後綴）（2026-08-31 片3）：風格參考圖 → VLM 讀圖輸出四欄風格 DNA
// （筆觸/色板 HEX/構圖/光照）→ 合成一段可注入生圖 prompt 的固定後綴 + 結構化 DNA JSON。
// 誠實：這是「文字級風格錨」（把風格蒸餾成穩定可複用的 prompt 後綴），非 Midjourney 的 sref 參數；
// 與片2 product_lock 的 DNA 後綴同學——後續所有生圖 prompt 追加該後綴即得風格一致性錨定。

const STYLE_Q =
  "這是風格參考圖（可能多張，代表同一風格）。提煉可複用的風格 DNA 供 AI 生圖追加，輸出 JSON：" +
  '{"brushwork":"筆觸/媒材/繪畫質感（中英文皆可，具體）",' +
  '"palette":["主色 HEX","#輔色 HEX",... 4-6 個],' +
  '"composition":"構圖傾向（視角/留白/主體位置/景深）",' +
  '"lighting":"光照/色溫/氛圍",' +
  '"english_suffix":"一段簡短英文風格後綴，可直接追加到生圖 prompt 末尾，精確描述筆觸色板構圖光照"}'

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
    "風格錨 / sref 級固定後綴（零生圖扣費，僅 VLM 讀圖）：image_urls（風格參考圖 URL JSON 陣列，1+ 張）→ VLM 蒸餾四欄風格 DNA（筆觸/色板 HEX/構圖/光照），合成一段可直接追加到後續生圖 prompt 末尾的固定後綴 + 結構化 DNA JSON + 穩定錨 token（DNA 雜湊，同圖同 token）。誠實：這是文字級風格錨（prompt 後綴複用），不是 Midjourney 的 --sref 參數，也不產圖；要像素級風格遷移請走生圖/編輯鏈。VLM 不可達回 ok:false 不編造。",
  args: {
    image_urls: tool.schema.string().describe('風格參考圖 URL JSON 陣列字串，例 ["https://..."]'),
    language: tool.schema.string().optional().describe("後綴語言偏好：en（默認，生圖模型友好）或 zh"),
  },
  async execute(args, context) {
    let urls: string[] = []
    try {
      const j = JSON.parse(args.image_urls)
      if (!Array.isArray(j)) return fail("invalid_image_urls", "image_urls 必須是 JSON 陣列字串", { title: "輸入非法" })
      urls = j.filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x.trim())).map((s) => s.trim())
    } catch {
      return fail("invalid_image_urls", "image_urls 必須是合法 JSON 陣列字串", { title: "輸入非法" })
    }
    if (!urls.length) return fail("empty_input", "image_urls 至少一個合法 http(s) URL", { title: "輸入缺失" })
    if (urls.length > 6) return fail("too_many", "風格參考單次最多 6 張", { title: "輸入過多" })

    const v = await vlmAskJson(urls, STYLE_Q, 1200)
    if (!v.ok) return fail("vlm_unavailable", `VLM 讀風格圖失敗：${v.reason}（未編造 DNA）`, { title: "風格抽取失敗" })
    const d = v.data as Record<string, unknown>

    const brushwork = typeof d.brushwork === "string" ? d.brushwork.trim() : ""
    const composition = typeof d.composition === "string" ? d.composition.trim() : ""
    const lighting = typeof d.lighting === "string" ? d.lighting.trim() : ""
    const palette = Array.isArray(d.palette) ? (d.palette.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
    const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""

    if (!brushwork && !composition && !lighting && !palette.length && !enSuffix) {
      return fail("empty_dna", "VLM 回覆未含任何風格欄位", { title: "風格抽取失敗" })
    }

    // 合成固定後綴（四欄 + 英文段），供後續生圖 prompt 直接追加
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
        title: `風格錨已鎖定（${token}）`,
        style_anchor_token: token,
        prompt_suffix: suffix,
        style_dna: dna,
        source_refs: urls,
        mechanism: "text_style_anchor",
        usage: "把 prompt_suffix 原樣追加到後續每次生圖 prompt 末尾，即得該風格的文字級錨定（同 token=同風格 DNA）。",
        note: "誠實：文字級風格錨（可複用 prompt 後綴），非 Midjourney --sref 參數、不產圖；palette 已正規化為小寫 6 位 HEX。",
      },
      { token, suffix },
    )
  },
})
