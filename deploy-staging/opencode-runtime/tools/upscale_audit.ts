import { tool } from "@opencode-ai/plugin/tool"
import {
  classifyError,
  confirmSpend,
  estimateUpscaleCoins,
  platformFetch,
  resolveMediaId,
  randomUUID,
  ok,
  fail,
} from "../lib/client"
import { runPIL, downloadImage, vlmAskJson } from "../lib/batch5-matting"
import { parseUrlArray } from "../lib/batch5-matting"

// 放大 + 細節審計（2026-08-31 片5）：交付圖組 → 逐圖走站點 /upscale 計費鏈真放大 →
// PIL 實測輸出尺寸 + VLM 對放大結果做細節審計（鋸齒/糊邊/artefacts → pass/warn/block）。
// 復用 image_upscale 的同一套 client 調法（resolveMediaId→estimateUpscaleCoins→confirmSpend→platformFetch），
// 不重造計費鏈；扣費閘門與 image_upscale 同口徑（單價>0.1 幣才確認，一次確認覆蓋整批）。

const AUDIT_Q =
  "這是放大後的交付圖。請審計放大品質，輸出 JSON：" +
  '{"verdict":"pass|warn|block",' +
  '"issues":["鋸齒","糊邊","artefact","色帶","過度銳化",... 若無問題為空陣列],' +
  '"evidence":"一句話具體證據（指出問題出現的區域或無問題的依據）"}' +
  " 判定標準：無可見鋸齒/糊邊/偽影=pass；輕微瑕疵不影響交付=warn；明顯鋸齒/糊邊/結構偽影=block。只輸出 JSON。"

export default tool({
  description:
    "放大 + 細節審計（真扣費，走站點 /upscale 計費鏈）：image_urls（交付圖 URL JSON 陣列，1-6 張）→ 逐圖真放大（默認 pixai-upscale 2x）→ PIL 實測輸出尺寸 + VLM 逐圖細節審計（鋸齒/糊邊/artefacts → pass/warn/block + 證據）。輸出每圖：放大後 URL + 實測尺寸 + 審計判定 + 實際扣費（從站點響應讀），並匯總 pass/warn/block 計數。誠實：審計 verdict 為 VLM 目測非像素級量化；扣費閘門與 image_upscale 同口徑（單價>0.1 幣先確認一次）。dry_run=true 只做尺寸探測+審計規劃不提交放大（零扣費）。upscale 上游失敗如實回傳錯誤不假裝成功。",
  args: {
    image_urls: tool.schema.string().describe('交付圖 URL JSON 陣列字串，例 ["https://..."]'),
    scale: tool.schema.number().int().min(2).max(4).optional().describe("放大倍數，默認 2"),
    model: tool.schema.string().optional().describe("放大模型，默認 pixai-upscale"),
    dry_run: tool.schema.boolean().optional().describe("true=不提交放大（零扣費），僅回規劃與原圖尺寸"),
    request_id: tool.schema.string().optional().describe("可選：批次冪等/確認 request_id（省略則自動生成）"),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "輸入非法" })
    const model = args.model?.trim() || "pixai-upscale"
    const scale = args.scale ?? 2
    const request_id = args.request_id?.trim() || randomUUID()

    const per = await estimateUpscaleCoins(model, context.sessionID, undefined, context.abort)
    const total = Math.round(per * p.urls.length * 1000) / 1000

    if (args.dry_run) {
      const plan = []
      for (const u of p.urls) {
        let size: string | null = null
        try {
          const buf = await downloadImage(u, context.abort)
          const j = await runPIL({ inputs: { in: buf }, outputs: [], code: `im=load('in')\nim=im.convert('RGB')\nemit(w=im.width,h=im.height)`, timeoutMs: 30_000, signal: context.abort })
          if (j.ok) size = `${j.result?.w}x${j.result?.h}`
        } catch { /* 誠實留 null */ }
        plan.push({ source_url: u, source_size: size })
      }
      return ok({
        title: "upscale_audit dry_run（未扣費）",
        dry_run: true,
        model,
        scale,
        estimate_coins_per_image: per,
        estimate_coins_total: total,
        plan,
        note: "dry_run 未提交放大；estimate 取自站點目錄（upscale 若不在目錄則為保守 FALLBACK 估值，實際扣費以站點響應 cost_coins 為準）。",
      })
    }

    // 扣費閘門：與 image_upscale 同口徑，>0.1 幣先確認一次（覆蓋整批）
    if (total > 0.1) {
      const approved = await confirmSpend(
        { sessionID: context.sessionID, amount_coins: total, description: `放大審計 ${p.urls.length} 張 ×${scale}x，預估 ${total} 幣`, model, request_id },
        context.abort,
      )
      if (!approved) return fail("user_declined", "用戶未確認扣費，已取消放大審計。", { title: "未確認扣費", request_id })
    }

    const results: Record<string, unknown>[] = []
    let spend = 0
    let counts = { pass: 0, warn: 0, block: 0, error: 0 }
    for (let i = 0; i < p.urls.length; i++) {
      const u = p.urls[i]
      const entry: Record<string, unknown> = { source_url: u }
      try {
        const media = await resolveMediaId(u, context.sessionID, context.abort)
        const idem = `${request_id}-${i}`
        const resp = await platformFetch("/upscale", { method: "POST", headers: { "idempotency-key": idem }, body: JSON.stringify({ image: media, factor: scale, model }) }, context.sessionID, context.abort)
        const body = (await resp.json().catch(() => ({}))) as Record<string, any>
        if (!resp.ok) {
          const err = await classifyError(resp, body)
          entry.error = `${err.code}: ${err.hint}`
          entry.upscale_status = "failed"
          counts.error++
          results.push(entry)
          continue
        }
        const url = body?.data?.[0]?.url || body?.result_url || body?.url || null
        const cost = Number(body?.cost_coins ?? body?.x_cost_coins ?? per) || 0
        spend += cost
        entry.upscaled_url = url
        entry.cost_coins = cost
        entry.upscale_status = "ok"
        // PIL 實測輸出尺寸
        if (url) {
          try {
            const buf = await downloadImage(url, context.abort)
            const j = await runPIL({ inputs: { in: buf }, outputs: [], code: `im=load('in').convert('RGB')\nemit(w=im.width,h=im.height)`, timeoutMs: 30_000, signal: context.abort })
            if (j.ok) entry.upscaled_size = `${j.result?.w}x${j.result?.h}`
          } catch { /* 尺寸留 null */ }
          // VLM 審計放大結果
          const a = await vlmAskJson([url], AUDIT_Q, 700)
          if (a.ok) {
            const ad = a.data as Record<string, unknown>
            const verdict = typeof ad.verdict === "string" ? ad.verdict.toLowerCase() : "warn"
            const v = verdict === "pass" || verdict === "block" ? verdict : "warn"
            entry.audit = { verdict: v, issues: Array.isArray(ad.issues) ? ad.issues : [], evidence: typeof ad.evidence === "string" ? ad.evidence : "" }
            counts[v]++
          } else {
            entry.audit = { verdict: "warn", issues: [], evidence: `VLM 審計不可達：${a.reason}` }
            counts.warn++
          }
        }
      } catch (e: any) {
        const err = await classifyError(null, e)
        entry.error = `${err.code}: ${err.hint}`
        entry.upscale_status = "failed"
        counts.error++
      }
      results.push(entry)
    }
    return ok(
      {
        title: `放大審計完成（${p.urls.length} 張：pass ${counts.pass}/warn ${counts.warn}/block ${counts.block}/err ${counts.error}）`,
        model,
        scale,
        request_id,
        actual_cost_coins_total: Math.round(spend * 1000) / 1000,
        estimate_coins_per_image: per,
        counts,
        results,
        note: "誠實：cost_coins 從站點 /upscale 響應讀（實際扣費）；upscaled_size 為 PIL 實測；audit.verdict 為 VLM 目測非像素量化；upscale_status=failed 的圖如實帶 error 不假裝成功。",
      },
      { spend, counts },
    )
  },
})
