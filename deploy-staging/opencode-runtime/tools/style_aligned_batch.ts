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

// 风格对齐批量渲染（2026-08-31 片6）：风格锚（style_anchor_sref 的 prompt_suffix/token，
// 或直接给风格参考图 URL 现场抽取）+ 主题清单 → 逐项 prompt+锚后缀 → 站点 generations
// 批量生图（img-orchestrate runGenBatch 计费链）→ 复用 outlier_audit_regenerate 核心做
// 群组一致性审计（VLM 评分 + z-score 离群）。
// 诚实（spec 红线）：文字级风格锚对齐（prompt 后缀复用 + 统一 model/size），
// 非 StyleAligned attention-sharing；无上游 batch id，逐项 task_id 如实回传真实 batch 统计。
// 风格抽取段逐行复用 style_anchor_sref.ts（片3）；群组审计段逐行复用 outlier_audit_regenerate.ts（片5）。

const STYLE_Q =
  "这是风格参考图（可能多张，代表同一风格）。提炼可复用的风格 DNA 供 AI 生图追加，输出 JSON：" +
  '{"brushwork":"笔触/媒材/绘画质感（中英文皆可，具体）",' +
  '"palette":["主色 HEX","#辅色 HEX",... 4-6 个],' +
  '"composition":"构图倾向（视角/留白/主体位置/景深）",' +
  '"lighting":"光照/色温/氛围",' +
  '"english_suffix":"一段简短英文风格后缀，可直接追加到生图 prompt 末尾，精确描述笔触色板构图光照"}'

const OUTLIER_Q =
  "这是一组应风格/主题一致的图（按输入顺序编号 0..N-1）。" +
  "请逐图评估其与『整组共识风格/主题』的一致性，输出 JSON：" +
  '{"scores":[{"index":0,"consistency":0.0~1.0,"deviation":"该图偏离群体之处（若一致则空）","fix_prompt":"若偏离，给一段可让重生贴合群体的英文 prompt 修正指令（一致则空）"}, ...每图一项],' +
  '"group_summary":"一句话描述整组共识风格/主题"}' +
  " consistency 越高越贴合群体。只输出 JSON。"

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
    "风格对齐批量渲染：items（主题/分镜清单 JSON 阵列字串，1-8 项）+ 风格锚二选一（style_prompt_suffix=style_anchor_sref 的 prompt_suffix 文字，或 style_ref_urls=风格参考图 URL JSON 阵列现场抽取）→ 逐项 prompt 追加风格锚后缀 → 站点 /v1/images/generations 批量生图（同 image_generate 计费链，统一 model/size 锚定）→ 产物群组 VLM 一致性审计（逐图 consistency 评分 + z-score 离群标记 + 离群图重生指令，复用 outlier_audit 核心）。诚实：这是文字级风格锚对齐（prompt 后缀复用），非 StyleAligned attention-sharing，无上游 batch id——回传真实逐项 task_id 与 batch 统计（requested/succeeded/failed/total_cost）。dry_run=true 只返回请求清单与免费目录报价，不提交、不扣费。",
  args: {
    items: tool.schema.string().describe('主题清单 JSON 阵列字串，例 ["晨光中的古城墙","雨夜霓虹街巷"]（1-8 项）'),
    style_prompt_suffix: tool.schema.string().optional().describe("风格锚后缀文字（style_anchor_sref 输出的 prompt_suffix），与 style_ref_urls 二选一"),
    style_ref_urls: tool.schema.string().optional().describe('风格参考图 URL JSON 阵列字串（无现成后缀时现场 VLM 抽取，1-6 张）'),
    style_anchor_token: tool.schema.string().optional().describe("可选：style_anchor_sref 的 token，仅原样回显便于对账"),
    model: tool.schema.string().optional().describe(`生图模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸（站点白名单 1024x1024/1536x1024/1024x1536/2048x2048），默认 1024x1024"),
    skip_audit: tool.schema.boolean().optional().describe("true=跳过群组一致性 VLM 审计（省 VLM 预算）"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求构造与目录报价，不提交生图"),
  },
  async execute(args, context) {
    const itemsP = parseStringArray(args.items, { min: 1, max: 8 })
    if (!itemsP.ok) return fail(itemsP.code, `items：${itemsP.hint}`, { title: "输入非法" })
    const suffixInput = args.style_prompt_suffix?.trim() || ""
    const refP = parseUrlArray(args.style_ref_urls, { min: 1, max: 6 })
    if (!suffixInput && !refP.ok) {
      return fail("missing_anchor", "风格锚缺失：style_prompt_suffix（现成后缀）或 style_ref_urls（参考图现场抽取）至少给一个", { title: "风格锚缺失" })
    }

    // 风格锚解析：现成后缀直接用；否则 VLM 抽 DNA（逐行复用 style_anchor_sref 合成段）
    let suffix = suffixInput
    let anchorToken = args.style_anchor_token?.trim() || null
    let anchorSource: "provided_suffix" | "vlm_extracted" = suffixInput ? "provided_suffix" : "vlm_extracted"
    let styleDna: Record<string, unknown> | null = null
    if (!suffix) {
      if (!refP.ok) return fail("missing_anchor", "风格锚缺失：style_prompt_suffix 或 style_ref_urls 至少给一个", { title: "风格锚缺失" })
      const v = await vlmAskJson(refP.urls, STYLE_Q, 1200)
      if (!v.ok) return fail("vlm_unavailable", `VLM 抽风格 DNA 失败：${v.reason}（未编造、未扣费）`, { title: "风格抽取失败" })
      const d = v.data as Record<string, unknown>
      const brushwork = typeof d.brushwork === "string" ? d.brushwork.trim() : ""
      const composition = typeof d.composition === "string" ? d.composition.trim() : ""
      const lighting = typeof d.lighting === "string" ? d.lighting.trim() : ""
      const palette = Array.isArray(d.palette) ? (d.palette.map(normHex).filter(Boolean) as string[]).slice(0, 6) : []
      const enSuffix = typeof d.english_suffix === "string" ? d.english_suffix.trim() : ""
      if (!brushwork && !composition && !lighting && !palette.length && !enSuffix) {
        return fail("empty_dna", "VLM 回覆未含任何风格栏位", { title: "风格抽取失败" })
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
      "文字级风格锚对齐：每项 prompt 追加同一风格后缀 + 统一 model/size 锚定，走站点 /v1/images/generations 计费链" +
      "（同 image_generate，reserve/commit 在站点端）；非 StyleAligned attention-sharing，无上游 batch id。"

    if (args.dry_run) {
      const plan = await planRequests(reqs, context.sessionID, context.abort)
      return ok({
        title: `style_aligned_batch dry_run（${reqs.length} 项）`,
        ...plan,
        style_anchor_token: anchorToken,
        prompt_suffix: suffix,
        mechanism,
        note: "dry_run：未提交生图、未扣费。实际执行后会自动群组 VLM 一致性审计（除非 skip_audit）。",
      })
    }

    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `风格对齐批量生图 ${reqs.length} 项（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "风格对齐批量生图失败", ...batch.detail })

    const succeeded = batch.results.filter((r) => r.status === "succeeded" && r.url)
    const failed = batch.results.filter((r) => r.status !== "succeeded")
    const urls = succeeded.map((r) => r.url!)

    // 群组一致性审计（逐行复用 outlier_audit_regenerate 核心：单次 VLM 带全部图 + TS z-score）
    let audit: Record<string, unknown> | null = null
    let auditError: string | null = null
    if (!args.skip_audit && urls.length >= 2) {
      const q = `${OUTLIER_Q}\n\n【一致性锚（额外对齐目标）】\n${suffix}`
      const v = await vlmAskJson(urls, q, 2000)
      if (!v.ok) {
        auditError = `VLM 审计失败：${v.reason}（未编造评分）`
      } else {
        const raw = (v.data as Record<string, unknown>).scores
        if (!Array.isArray(raw)) {
          auditError = "VLM 回覆缺 scores 阵列"
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
      auditError = "成功图不足 2 张，跳过群组审计（单图无群体可比）"
    }

    return ok(
      {
        title: `风格对齐批量完成（${succeeded.length}/${reqs.length} 张${audit ? `，审计离群 ${((audit.outliers as unknown[]) || []).length}` : ""}）`,
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
        note: "诚实：文字级风格锚对齐（prompt 后缀复用+统一 model/size），非 StyleAligned attention-sharing；consistency 为 VLM 目测非像素量化；离群图重生指令仅给 prompt 未自动生图。",
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
