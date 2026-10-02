import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"
import { llmChatJson } from "../lib/llm-channel"
import {
  ORCH_DEFAULT_MODEL,
  SEED_NOTE,
  normalizeSize,
  planRequests,
  runGenBatch,
} from "../lib/img-orchestrate"

// 情緒板發散→收斂（2026-08-31 片2）：LLM 發散 N 方向×M prompt → 生圖 → LLM 給推薦排序。
// 誠實：收斂決策權在用戶/agent，本工具只附推薦，不自動收斂。

const DIVERGE_SYSTEM =
  "你是視覺總監。給定主題，發散出指定數量的情緒板方向，只輸出 JSON：{\"directions\":[{\"label\":\"方向名（4-8字）\",\"rationale\":\"一句話理由\",\"prompts\":[\"英文生圖 prompt1\",\"prompt2\",...]}]}，每個方向的 prompts 數量必須等於要求數，prompt 要具體可畫（構圖/光線/色板/質感）。"

const RANK_SYSTEM =
  "你是視覺評審。給定主題與情緒板方向清單（含 label/rationale），按與主題的契合度與商業潛力排序，只輸出 JSON：{\"ranking\":[\"方向label\",...],\"recommendation\":\"一句話推薦與理由\"}。"

export default tool({
  description:
    "情緒板發散→收斂：theme 填主題詞。發散段：LLM 生成 directions（默認 3）× per_direction（默認 3）張 prompt 並生圖（默認 9 張）；收斂段：返回帶 direction 標籤的圖組 + LLM 推薦排序。誠實聲明：收斂決策權在用戶——工具只給推薦，不自動砍方向，agent 應拿 ranking 向用戶提問確認。dry_run=true 仍執行 LLM 發散（內部通道零扣費）返回完整請求清單，但不提交生圖、不排序。計費同 image_generate 站點鏈。",
  args: {
    theme: tool.schema.string().describe("主題詞（如 「夏日檸檬氣泡水」）"),
    directions: tool.schema.number().int().min(1).max(4).optional().describe("發散方向數 1-4，默認 3"),
    per_direction: tool.schema.number().int().min(1).max(4).optional().describe("每方向張數 1-4，默認 3"),
    model: tool.schema.string().optional().describe(`生成模型，默認 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("true=只返回 LLM 發散的請求清單與報價，不提交生圖"),
  },
  async execute(args, context) {
    const theme = args.theme.trim()
    if (!theme) return fail("missing_theme", "theme 不能為空", { title: "輸入非法" })
    const nDir = args.directions ?? 3
    const nPer = args.per_direction ?? 3
    const div = await llmChatJson(
      DIVERGE_SYSTEM,
      `主題：${theme}。要求 ${nDir} 個方向，每方向 ${nPer} 條 prompt。`,
      6000,
    )
    if (!div.ok) return fail("llm_diverge_failed", `LLM 發散失敗：${div.reason}。請重試或改用 emotion_board_matrix（模板交叉不依賴 LLM）。`, { title: "發散失敗" })
    const dirs = Array.isArray(div.data?.directions) ? (div.data!.directions as any[]) : []
    if (!dirs.length) return fail("llm_diverge_empty", "LLM 未返回 directions 陣列", { title: "發散失敗" })
    const model = args.model ?? ORCH_DEFAULT_MODEL
    const size = normalizeSize(args.size)
    const reqs: { tag: string; prompt: string; model: string; size: string; n: number }[] = []
    const labels: string[] = []
    dirs.slice(0, nDir).forEach((d, di) => {
      const label = String(d?.label ?? `方向${di + 1}`)
      labels.push(label)
      const prompts = Array.isArray(d?.prompts) ? (d.prompts as string[]).slice(0, nPer) : []
      prompts.forEach((p, pi) => {
        if (typeof p !== "string" || !p.trim()) return
        reqs.push({ tag: `${label}#${pi + 1}`, prompt: `moodboard frame, theme: ${theme} — ${p.trim()}, cohesive style, no text`, model, size, n: 1 })
      })
    })
    if (!reqs.length) return fail("no_prompts", "LLM 方向內無有效 prompt", { title: "發散失敗" })
    if (args.dry_run) {
      return ok({
        title: `moodboard dry_run：${dirs.length} 方向 × ${nPer} 張 = ${reqs.length} 張`,
        directions: dirs.slice(0, nDir).map((d) => ({ label: String(d?.label ?? ""), rationale: String(d?.rationale ?? "") })),
        ...(await planRequests(reqs, context.sessionID, context.abort)),
      })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `情緒板發散：${reqs.length} 張（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生圖失敗", ...batch.detail })
    const groups = labels.map((label) => ({
      direction: label,
      rationale: String(dirs.find((d) => String(d?.label) === label)?.rationale ?? ""),
      items: batch.results
        .filter((r) => r.tag.startsWith(`${label}#`))
        .map((r) => ({ tag: r.tag, prompt: r.prompt, task_id: r.task_id, status: r.status, url: r.url, seed: null, cost_coins: r.cost_coins, ...(r.error ? { error: r.error } : {}) })),
    }))
    const rank = await llmChatJson(RANK_SYSTEM, `主題：${theme}。方向清單：${JSON.stringify(groups.map((g) => ({ label: g.direction, rationale: g.rationale })))}`, 2000)
    return ok(
      {
        title: `情緒板：${groups.length} 方向 ${reqs.length} 張`,
        groups,
        convergence: rank.ok ? { ranking: rank.data?.ranking ?? null, recommendation: rank.data?.recommendation ?? null } : { ranking: null, recommendation: null, note: `LLM 排序不可用：${rank.reason}` },
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "誠實：收斂不自動——ranking/recommendation 僅為 LLM 推薦，最終方向必須由用戶圈選決定。",
      },
      { groups, total_cost_coins: batch.total_cost_coins },
    )
  },
})
