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

// 情緒板矩陣（2026-08-31 片2）：關鍵詞 → 維度×變體 prompt 矩陣批量生圖。
// 行=視覺維度（色溫/構圖/意象），列=該維度下的固定變體交叉表，網格座標進 metadata。

const TREATMENTS: Record<string, string[]> = {
  色溫: ["warm golden-hour lighting", "cool blue-teal night lighting", "neutral soft overcast daylight"],
  構圖: ["centered symmetrical composition", "low-angle wide shot", "top-down macro detail"],
  意象: ["literal scene depiction", "metaphorical abstract forms", "silhouette and negative space mood"],
}

export default tool({
  description:
    "情緒板矩陣：keywords 填情緒關鍵詞，按「色溫/構圖/意象」三維度 × 每維度變體交叉構造 prompt 矩陣批量生圖（默認 3×3=9 張，可用 dimensions/variants 縮小）。返回網格 metadata：row=維度、col=變體，每格含 url+prompt，供用戶圈選方向。dry_run=true 只返回矩陣請求清單與報價（張數=維度數×variants），不提交生圖。計費同 image_generate 站點鏈。",
  args: {
    keywords: tool.schema.string().describe("情緒關鍵詞（如 「孤獨、雨夜、霓虹」）"),
    dimensions: tool.schema.string().optional().describe(`維度 JSON 陣列字串，可選 ${Object.keys(TREATMENTS).join("/")}，默認全部`),
    variants: tool.schema.number().int().min(1).max(3).optional().describe("每維度變體數 1-3，默認 3"),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回請求清單與報價，不提交生圖"),
  },
  async execute(args, context) {
    const kw = args.keywords.trim()
    if (!kw) return fail("missing_keywords", "keywords 不能為空", { title: "輸入非法" })
    let dims = Object.keys(TREATMENTS)
    if (args.dimensions) {
      const p = parseJsonArray(args.dimensions, "dimensions")
      if (!p.ok) return fail("invalid_dimensions", p.hint, { title: "輸入非法" })
      dims = p.value.map((d) => String(d)).filter((d) => TREATMENTS[d])
      if (!dims.length) return fail("unknown_dimensions", `dimensions 只能取 ${Object.keys(TREATMENTS).join("/")}`, { title: "輸入非法" })
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
      return ok({ title: `emotion_board_matrix dry_run：${dims.length}×${variants}=${reqs.length} 張`, grid, ...(await planRequests(reqs, context.sessionID, context.abort)) })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `情緒板矩陣：${reqs.length} 張（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生圖失敗", ...batch.detail })
    const cells = batch.results.map((r) => {
      const g = grid.find((x) => `${x.row}-${x.col}` === r.tag)!
      return { row: g.row, col: g.col, treatment: g.treatment, prompt: r.prompt, task_id: r.task_id, status: r.status, url: r.url, seed: null, cost_coins: r.cost_coins, ...(r.error ? { error: r.error } : {}) }
    })
    return ok(
      {
        title: `情緒板矩陣：${cells.filter((c) => c.status === "succeeded").length}/${cells.length} 格`,
        grid: { rows: dims, cols_per_row: variants },
        cells,
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "cells 按 row(維度)×col(變體) 定位；請用戶圈選偏好的格子作為收斂方向。",
      },
      { cells, total_cost_coins: batch.total_cost_coins },
    )
  },
})
