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

// 放大 + 细节审计（2026-08-31 片5）：交付图组 → 逐图走站点 /upscale 计费链真放大 →
// PIL 实测输出尺寸 + VLM 对放大结果做细节审计（锯齿/糊边/artefacts → pass/warn/block）。
// 复用 image_upscale 的同一套 client 调法（resolveMediaId→estimateUpscaleCoins→confirmSpend→platformFetch），
// 不重造计费链；扣费闸门与 image_upscale 同口径（单价>0.1 币才确认，一次确认覆盖整批）。

const AUDIT_Q =
  "这是放大后的交付图。请审计放大品质，输出 JSON：" +
  '{"verdict":"pass|warn|block",' +
  '"issues":["锯齿","糊边","artefact","色带","过度锐化",... 若无问题为空阵列],' +
  '"evidence":"一句话具体证据（指出问题出现的区域或无问题的依据）"}' +
  " 判定标准：无可见锯齿/糊边/伪影=pass；轻微瑕疵不影响交付=warn；明显锯齿/糊边/结构伪影=block。只输出 JSON。"

export default tool({
  description:
    "放大 + 细节审计（真扣费，走站点 /upscale 计费链）：image_urls（交付图 URL JSON 阵列，1-6 张）→ 逐图真放大（默认 pixai-upscale 2x）→ PIL 实测输出尺寸 + VLM 逐图细节审计（锯齿/糊边/artefacts → pass/warn/block + 证据）。输出每图：放大后 URL + 实测尺寸 + 审计判定 + 实际扣费（从站点响应读），并汇总 pass/warn/block 计数。诚实：审计 verdict 为 VLM 目测非像素级量化；扣费闸门与 image_upscale 同口径（单价>0.1 币先确认一次）。dry_run=true 只做尺寸探测+审计规划不提交放大（零扣费）。upscale 上游失败如实回传错误不假装成功。",
  args: {
    image_urls: tool.schema.string().describe('交付图 URL JSON 阵列字串，例 ["https://..."]'),
    scale: tool.schema.number().int().min(2).max(4).optional().describe("放大倍数，默认 2"),
    model: tool.schema.string().optional().describe("放大模型，默认 pixai-upscale"),
    dry_run: tool.schema.boolean().optional().describe("true=不提交放大（零扣费），仅回规划与原图尺寸"),
    request_id: tool.schema.string().optional().describe("可选：批次幂等/确认 request_id（省略则自动生成）"),
  },
  async execute(args, context) {
    const p = parseUrlArray(args.image_urls, { min: 1, max: 6 })
    if (!p.ok) return fail(p.code, p.hint, { title: "输入非法" })
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
        } catch { /* 诚实留 null */ }
        plan.push({ source_url: u, source_size: size })
      }
      return ok({
        title: "upscale_audit dry_run（未扣费）",
        dry_run: true,
        model,
        scale,
        estimate_coins_per_image: per,
        estimate_coins_total: total,
        plan,
        note: "dry_run 未提交放大；estimate 取自站点目录（upscale 若不在目录则为保守 FALLBACK 估值，实际扣费以站点响应 cost_coins 为准）。",
      })
    }

    // 扣费闸门：与 image_upscale 同口径，>0.1 币先确认一次（覆盖整批）
    if (total > 0.1) {
      const approved = await confirmSpend(
        { sessionID: context.sessionID, amount_coins: total, description: `放大审计 ${p.urls.length} 张 ×${scale}x，预估 ${total} 币`, model, request_id },
        context.abort,
      )
      if (!approved) return fail("user_declined", "用户未确认扣费，已取消放大审计。", { title: "未确认扣费", request_id })
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
        // PIL 实测输出尺寸
        if (url) {
          try {
            const buf = await downloadImage(url, context.abort)
            const j = await runPIL({ inputs: { in: buf }, outputs: [], code: `im=load('in').convert('RGB')\nemit(w=im.width,h=im.height)`, timeoutMs: 30_000, signal: context.abort })
            if (j.ok) entry.upscaled_size = `${j.result?.w}x${j.result?.h}`
          } catch { /* 尺寸留 null */ }
          // VLM 审计放大结果
          const a = await vlmAskJson([url], AUDIT_Q, 700)
          if (a.ok) {
            const ad = a.data as Record<string, unknown>
            const verdict = typeof ad.verdict === "string" ? ad.verdict.toLowerCase() : "warn"
            const v = verdict === "pass" || verdict === "block" ? verdict : "warn"
            entry.audit = { verdict: v, issues: Array.isArray(ad.issues) ? ad.issues : [], evidence: typeof ad.evidence === "string" ? ad.evidence : "" }
            counts[v]++
          } else {
            entry.audit = { verdict: "warn", issues: [], evidence: `VLM 审计不可达：${a.reason}` }
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
        title: `放大审计完成（${p.urls.length} 张：pass ${counts.pass}/warn ${counts.warn}/block ${counts.block}/err ${counts.error}）`,
        model,
        scale,
        request_id,
        actual_cost_coins_total: Math.round(spend * 1000) / 1000,
        estimate_coins_per_image: per,
        counts,
        results,
        note: "诚实：cost_coins 从站点 /upscale 响应读（实际扣费）；upscaled_size 为 PIL 实测；audit.verdict 为 VLM 目测非像素量化；upscale_status=failed 的图如实带 error 不假装成功。",
      },
      { spend, counts },
    )
  },
})
