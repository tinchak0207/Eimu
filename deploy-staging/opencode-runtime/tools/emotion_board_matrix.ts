import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  parseJsonArray,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// 情绪板矩阵（2026-08-31 片2）：关键词 → 维度×变体 prompt 矩阵批量生图。
// 行=视觉维度（色温/构图/意象），列=该维度下的固定变体交叉表，网格座标进 metadata。

const TREATMENTS: Record<string, string[]> = {
  色温: ["warm golden-hour lighting", "cool blue-teal night lighting", "neutral soft overcast daylight"],
  构图: ["centered symmetrical composition", "low-angle wide shot", "top-down macro detail"],
  意象: ["literal scene depiction", "metaphorical abstract forms", "silhouette and negative space mood"],
}

export default tool({
  description:
    "情绪板矩阵：keywords 填情绪关键词，按「色温/构图/意象」三维度 × 每维度变体交叉构造 prompt 矩阵批量生图（默认 3×3=9 张，可用 dimensions/variants 缩小）。返回网格 metadata：row=维度、col=变体，每格含 url+prompt，供用户圈选方向。dry_run=true 只返回矩阵请求清单与报价（张数=维度数×variants），不提交生图。计费同 image_generate 站点链。",
  args: {
    keywords: tool.schema.string().describe("情绪关键词（如 「孤独、雨夜、霓虹」）"),
    dimensions: tool.schema.string().optional().describe(`维度 JSON 阵列字串，可选 ${Object.keys(TREATMENTS).join("/")}，默认全部`),
    variants: tool.schema.number().int().min(1).max(3).optional().describe("每维度变体数 1-3，默认 3"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回请求清单与报价，不提交生图"),
  },
  async execute(args, context) {
    const kw = args.keywords.trim()
    if (!kw) return fail("missing_keywords", "keywords 不能为空", { title: "输入非法" })
    let dims = Object.keys(TREATMENTS)
    if (args.dimensions) {
      const p = parseJsonArray(args.dimensions, "dimensions")
      if (!p.ok) return fail("invalid_dimensions", p.hint, { title: "输入非法" })
      dims = p.value.map((d) => String(d)).filter((d) => TREATMENTS[d])
      if (!dims.length) return fail("unknown_dimensions", `dimensions 只能取 ${Object.keys(TREATMENTS).join("/")}`, { title: "输入非法" })
    }
    const variants = args.variants ?? 3
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const grid: { row: string; col: number; treatment: string }[] = []
    const reqs: { tag: string; prompt: string; model: string; size: string; n: number }[] = []
    for (const dim of dims) {
      const cells = TREATMENTS[dim].slice(0, variants)
      cells.forEach((t, i) => {
        grid.push({ row: dim, col: i + 1, treatment: t })
        reqs.push({
          tag: `${dim}-${i + 1}`,
          prompt: `moodboard frame, emotion: ${kw}, ${dim} treatment: ${t}, cohesive color grade, cinematic still, no text`,
          model,
          size,
          n: 1,
        })
      })
    }
    if (args.dry_run) {
      return ok({ title: `emotion_board_matrix dry_run：${dims.length}×${variants}=${reqs.length} 张`, grid, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `情绪板矩阵：${reqs.length} 张（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生图失败", ...batch.detail })
    const cells = batch.results.map((r) => {
      const g = grid.find((x) => `${x.row}-${x.col}` === r.tag)!
      return { row: g.row, col: g.col, treatment: g.treatment, prompt: r.prompt, task_id: r.task_id, status: r.status, url: r.url, seed: null, cost_coins: r.cost_coins, ...(r.error ? { error: r.error } : {}) }
    })
    return ok(
      {
        title: `情绪板矩阵：${cells.filter((c) => c.status === "succeeded").length}/${cells.length} 格`,
        grid: { rows: dims, cols_per_row: variants },
        cells,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "cells 按 row(维度)×col(变体) 定位；请用户圈选偏好的格子作为收敛方向。",
      },
      { cells, total_cost_coins: batch.total_cost_coins },
    )
  },
})
