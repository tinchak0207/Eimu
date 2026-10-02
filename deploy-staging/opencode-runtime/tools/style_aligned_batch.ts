import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { createHash } from "node:crypto"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  planRequests,
  runGenBatch,
  vlmAskJson,
  type GenReq,
} from "../lib/img-orchestrate"
import { normHex, parseUrlArray, parseStringArray } from "../lib/batch5-matting"

// 風格對齊批量渲染（2026-08-31 片6）：風格錨（style_anchor_sref 的 prompt_suffix/token，
// 或直接給風格參考圖 URL 現場抽取）+ 主題清單 → 逐項 prompt+錨後綴 → 站點 generations
// 批量生圖（img-orchestrate runGenBatch 計費鏈）→ 復用 outlier_audit_regenerate 核心做
// 群組一致性審計（VLM 評分 + z-score 離群）。
// 誠實（spec 紅線）：文字級風格錨對齊（prompt 後綴複用 + 統一 model/size），
// 非 StyleAligned attention-sharing；無上游 batch id，逐項 task_id 如實回傳真實 batch 統計。
// 風格抽取段逐行復用 style_anchor_sref.ts（片3）；群組審計段逐行復用 outlier_audit_regenerate.ts（片5）。

const STYLE_Q =
  "這是風格參考圖（可能多張，代表同一風格）。提煉可複用的風格 DNA 供 AI 生圖追加，輸出 JSON：" +
  '{"brushwork":"筆觸/媒材/繪畫質感（中英文皆可，具體）",' +
  '"palette":["主色 HEX","#輔色 HEX",... 4-6 個],' +
  '"composition":"構圖傾向（視角/留白/主體位置/景深）",' +
  '"lighting":"光照/色溫/氛圍",' +
  '"english_suffix":"一段簡短英文風格後綴，可直接追加到生圖 prompt 末尾，精確描述筆觸色板構圖光照"}'

const OUTLIER_Q =
  "這是一組應風格/主題一致的圖（按輸入順序編號 0..N-1）。" +
  "請逐圖評估其與『整組共識風格/主題』的一致性，輸出 JSON：" +
  '{"scores":[{"index":0,"consistency":0.0~1.0,"deviation":"該圖偏離群體之處（若一致則空）","fix_prompt":"若偏離，給一段可讓重生貼合群體的英文 prompt 修正指令（一致則空）"}, ...每圖一項],' +
  '"group_summary":"一句話描述整組共識風格/主題"}' +
  " consistency 越高越貼合群體。只輸出 JSON。"

function zScores(vals: number[]): number[] {
  const n = vals.length
  if (n < 2) return vals.map(() => 0)
  const mean = vals.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
  if (sd < 1e-9) return vals.map(() => 0)
  return vals.map((v) => Math.round(((v - mean) / sd) * 100) / 100)
}

export default tool({
  description:
    "風格對齊批量渲染：items（主題/分鏡清單 JSON 陣列字串，1-8 項）+ 風格錨二選一（style_prompt_suffix=style_anchor_sref 的 prompt_suffix 文字，或 style_ref_urls=風格參考圖 URL JSON 陣列現場抽取）→ 逐項 prompt 追加風格錨後綴 → 站點 /v1/images/generations 批量生圖（同 image_generate 計費鏈，統一 model/size 錨定）→ 產物群組 VLM 一致性審計（逐圖 consistency 評分 + z-score 離群標記 + 離群圖重生指令，復用 outlier_audit 核心）。誠實：這是文字級風格錨對齊（prompt 後綴複用），非 StyleAligned attention-sharing，無上游 batch id——回傳真實逐項 task_id 與 batch 統計（requested/succeeded/failed/total_cost）。dry_run=true 只返回請求清單與免費目錄報價，不提交、不扣費。",
  args: {
    items: tool.schema.string().describe('主題清單 JSON 陣列字串，例 ["晨光中的古城牆","雨夜霓虹街巷"]（1-8 項）'),
    style_prompt_suffix: tool.schema.string().optional().describe("風格錨後綴文字（style_anchor_sref 輸出的 prompt_suffix），與 style_ref_urls 二選一"),
    style_ref_urls: tool.schema.string().optional().describe('風格參考圖 URL JSON 陣列字串（無現成後綴時現場 VLM 抽取，1-6 張）'),
    style_anchor_token: tool.schema.string().optional().describe("可選：style_anchor_sref 的 token，僅原樣回顯便於對賬"),
    model: tool.schema.string().optional().describe(`生圖模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸（站點白名單 1024x1024/1536x1024/1024x1536/2048x2048），默認 1024x1024"),
    skip_audit: tool.schema.boolean().optional().describe("true=跳過群組一致性 VLM 審計（省 VLM 預算）"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求構造與目錄報價，不提交生圖"),
  },
  async execute(args, context) {
    const itemsP = parseStringArray(args.items, { min: 1, max: 8 })
    if (!itemsP.ok) return fail(itemsP.code, `items：${itemsP.hint}`, { title: "輸入非法" })
    const suffixInput = args.style_prompt_suffix?.trim() || ""
    const refP = parseUrlArray(args.style_ref_urls, { min: 1, max: 6 })
    if (!suffixInput && !refP.ok) {
      return fail("missing_anchor", "風格錨缺失：style_prompt_suffix（現成後綴）或 style_ref_urls（參考圖現場抽取）至少給一個", { title: "風格錨缺失" })
    }

    // 風格錨解析：現成後綴直接用；否則 VLM 抽 DNA（逐行復用 style_anchor_sref 合成段）
    let suffix = suffixInput
    let anchorToken = args.style_anchor_token?.trim() || null
    let anchorSource: "provided_suffix" | "vlm_extracted" = suffixInput ? "provided_suffix" : "vlm_extracted"
    let styleDna: Record<string, unknown> | null = null
    if (!suffix) {
      if (!refP.ok) return fail("missing_anchor", "風格錨缺失：style_prompt_suffix 或 style_ref_urls 至少給一個", { title: "風格錨缺失" })
      const v = await vlmAskJson(refP.urls, STYLE_Q, 1200)
      if (!v.ok) return fail("vlm_unavailable", `VLM 抽風格 DNA 失敗：${v.reason}（未編造、未扣費）`, { title: "風格抽取失敗" })
      const d = v.data as Record<string, unknown>
      const brushwork = typeof d.brushwork === "string" ? d.brushwork.trim() : ""
      const composition = typeof d.composition === "string" ? d.composition.trim() : ""
      const lighting = typeof d.lighting === "string" ? d.lighting.trim() : ""
      const palette = Array.isArray(d.palette) ? (d.palette.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
      const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""
      if (!brushwork && !composition && !lighting && !palette.length && !enSuffix) {
        return fail("empty_dna", "VLM 回覆未含任何風格欄位", { title: "風格抽取失敗" })
      }
      const parts: string[] = []
      if (enSuffix) parts.push(enSuffix)
      if (brushwork) parts.push(`brushwork: ${brushwork}`)
      if (palette.length) parts.push(`palette: ${palette.join(", ")}`)
      if (composition) parts.push(`composition: ${composition}`)
      if (lighting) parts.push(`lighting: ${lighting}`)
      suffix = parts.join("; ")
      styleDna = { brushwork, palette, composition, lighting, english_suffix: enSuffix || null }
      anchorToken = "sref-" + createHash("sha256").update(JSON.stringify(styleDna)).digest("hex").slice(0, 12)
    } else if (!anchorToken) {
      anchorToken = "sref-" + createHash("sha256").update(suffix).digest("hex").slice(0, 12)
    }

    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs: GenReq[] = itemsP.items.map((it, i) => ({
      tag: `aligned-${i}`,
      prompt: `${it}. Style: ${suffix}`,
      model,
      size,
      n: 1,
    }))

    const mechanism =
      "文字級風格錨對齊：每項 prompt 追加同一風格後綴 + 統一 model/size 錨定，走站點 /v1/images/generations 計費鏈" +
      "（同 image_generate，reserve/commit 在站點端）；非 StyleAligned attention-sharing，無上游 batch id。"

    if (args.dry_run) {
      const plan = await planRequests(reqs, context.sessionID, context.abort)
      return ok({
        title: `style_aligned_batch dry_run（${reqs.length} 項）`,
        ...plan,
        style_anchor_token: anchorToken,
        prompt_suffix: suffix,
        mechanism,
        note: "dry_run：未提交生圖、未扣費。實際執行後會自動群組 VLM 一致性審計（除非 skip_audit）。",
      })
    }

    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `風格對齊批量生圖 ${reqs.length} 項（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "風格對齊批量生圖失敗", ...batch.detail })

    const succeeded = batch.results.filter((r) => r.status === "succeeded" && r.url)
    const failed = batch.results.filter((r) => r.status !== "succeeded")
    const urls = succeeded.map((r) => r.url!)

    // 群組一致性審計（逐行復用 outlier_audit_regenerate 核心：單次 VLM 帶全部圖 + TS z-score）
    let audit: Record<string, unknown> | null = null
    let auditError: string | null = null
    if (!args.skip_audit && urls.length >= 2) {
      const q = `${OUTLIER_Q}\n\n【一致性錨（額外對齊目標）】\n${suffix}`
      const v = await vlmAskJson(urls, q, 2000)
      if (!v.ok) {
        auditError = `VLM 審計失敗：${v.reason}（未編造評分）`
      } else {
        const raw = (v.data as Record<string, unknown>).scores
        if (!Array.isArray(raw)) {
          auditError = "VLM 回覆缺 scores 陣列"
        } else {
          const byIndex = new Map<number, Record<string, unknown>>()
          for (const s of raw as Record<string, unknown>[]) {
            const idx = Number(s.index)
            if (Number.isInteger(idx) && idx >= 0 && idx < urls.length) byIndex.set(idx, s)
          }
          const consistency: number[] = []
          const perImage: Record<string, unknown>[] = []
          for (let i = 0; i < urls.length; i++) {
            const s = byIndex.get(i) || {}
            let c = typeof s.consistency === "number" ? s.consistency : Number(s.consistency)
            if (!Number.isFinite(c)) c = 0.5
            c = Math.max(0, Math.min(1, c))
            consistency.push(c)
            perImage.push({
              index: i,
              tag: succeeded[i].tag,
              url: urls[i],
              consistency: Math.round(c * 100) / 100,
              deviation: typeof s.deviation === "string" ? s.deviation : "",
              fix_prompt: typeof s.fix_prompt === "string" ? s.fix_prompt : "",
            })
          }
          const zs = zScores(consistency)
          const ranked = [...consistency].map((c, i) => ({ i, c })).sort((a, b) => a.c - b.c)
          const rankOf = new Map<number, number>()
          ranked.forEach((r, pos) => rankOf.set(r.i, pos + 1))
          const outliers: Record<string, unknown>[] = []
          for (let i = 0; i < perImage.length; i++) {
            const z = zs[i]
            const isOutlier = z < -1.0 || (urls.length >= 4 && rankOf.get(i) === 1 && consistency[i] < 0.6)
            perImage[i].deviation_z = z
            perImage[i].outlier = isOutlier
            if (isOutlier) outliers.push({ index: i, tag: perImage[i].tag, url: perImage[i].url, consistency: perImage[i].consistency, deviation_z: z, deviation: perImage[i].deviation, regenerate_prompt: perImage[i].fix_prompt || null })
          }
          audit = {
            group_summary: typeof (v.data as Record<string, unknown>).group_summary === "string" ? (v.data as Record<string, unknown>).group_summary : "",
            outlier_z_threshold: 1.0,
            per_image: perImage,
            outliers,
            regenerate_instructions: outliers.map((o) => ({ tag: o.tag, url: o.url, corrected_prompt: o.regenerate_prompt })),
            mechanism: "vlm_group_consistency + zscore",
          }
        }
      }
    } else if (!args.skip_audit && urls.length < 2) {
      auditError = "成功圖不足 2 張，跳過群組審計（單圖無群體可比）"
    }

    return ok(
      {
        title: `風格對齊批量完成（${succeeded.length}/${reqs.length} 張${audit ? `，審計離群 ${((audit.outliers as unknown[]) || []).length}` : ""}）`,
        style_anchor_token: anchorToken,
        prompt_suffix: suffix,
        anchor_source: anchorSource,
        style_dna: styleDna,
        images: succeeded.map((r) => ({ tag: r.tag, prompt: r.prompt, url: r.url, task_id: r.task_id, cost_coins: r.cost_coins })),
        batch_stats: {
          requested: reqs.length,
          succeeded: succeeded.length,
          failed: failed.map((f) => ({ tag: f.tag, error: f.error || "unknown" })),
          total_images: batch.total_images,
          total_cost_coins: batch.total_cost_coins,
          task_ids: succeeded.map((r) => r.task_id),
        },
        consistency_audit: audit,
        consistency_audit_error: auditError,
        mechanism,
        seed: null,
        seed_policy: SEED_NOTE,
        note: "誠實：文字級風格錨對齊（prompt 後綴複用+統一 model/size），非 StyleAligned attention-sharing；consistency 為 VLM 目測非像素量化；離群圖重生指令僅給 prompt 未自動生圖。",
      },
      {
        token: anchorToken,
        succeeded: succeeded.length,
        total_cost_coins: batch.total_cost_coins,
        outlier_count: audit ? ((audit.outliers as unknown[]) || []).length : null,
      },
    )
  },
})
