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

// 情绪板发散→收敛（2026-08-31 片2）：LLM 发散 N 方向×M prompt → 生图 → LLM 给推荐排序。
// 诚实：收敛决策权在用户/agent，本工具只附推荐，不自动收敛。

const DIVERGE_SYSTEM =
  "你是视觉总监。给定主题，发散出指定数量的情绪板方向，只输出 JSON：{\"directions\":[{\"label\":\"方向名（4-8字）\",\"rationale\":\"一句话理由\",\"prompts\":[\"英文生图 prompt1\",\"prompt2\",...]}]}，每个方向的 prompts 数量必须等于要求数，prompt 要具体可画（构图/光线/色板/质感）。"

const RANK_SYSTEM =
  "你是视觉评审。给定主题与情绪板方向清单（含 label/rationale），按与主题的契合度与商业潜力排序，只输出 JSON：{\"ranking\":[\"方向label\",...],\"recommendation\":\"一句话推荐与理由\"}。"

export default tool({
  description:
    "情绪板发散→收敛：theme 填主题词。发散段：LLM 生成 directions（默认 3）× per_direction（默认 3）张 prompt。默认 dry_run=true，不提交生图；显式 dry_run:false 才生图并计费（默认 9 张）。收敛段：返回带 direction 标签的图组 + LLM 推荐排序。诚实声明：收敛决策权在用户——工具只给推荐，不自动砍方向，agent 应拿 ranking 向用户提问确认。dry_run 仍执行 LLM 发散（内部通道零扣费）返回完整请求清单，但不提交生图、不排序。计费同 image_generate 站点链。",
  args: {
    theme: tool.schema.string().describe("主题词（如 「夏日柠檬气泡水」）"),
    directions: tool.schema.number().int().min(1).max(4).optional().describe("发散方向数 1-4，默认 3"),
    per_direction: tool.schema.number().int().min(1).max(4).optional().describe("每方向张数 1-4，默认 3"),
    model: tool.schema.string().optional().describe(`生成模型，默认 ${ORCH_DEFAULT_MODEL}`),
    size: tool.schema.string().optional().describe("尺寸：1024x1024 / 1536x1024 / 1024x1536 / 2048x2048"),
    dry_run: tool.schema.boolean().optional().describe("默认 true：只返回 LLM 发散的请求清单与报价，不提交生图。显式 false 才提交生图并计费"),
  },
  async execute(args, context) {
    const theme = args.theme.trim()
    if (!theme) return fail("missing_theme", "theme 不能为空", { title: "输入非法" })
    const nDir = args.directions ?? 3
    const nPer = args.per_direction ?? 3
    const div = await llmChatJson(
      DIVERGE_SYSTEM,
      `主题：${theme}。要求 ${nDir} 个方向，每方向 ${nPer} 条 prompt。`,
      6000,
    )
    if (!div.ok) return fail("llm_diverge_failed", `LLM 发散失败：${div.reason}。请重试或改用 emotion_board_matrix（模板交叉不依赖 LLM）。`, { title: "发散失败" })
    const dirs = Array.isArray(div.data?.directions) ? (div.data!.directions as any[]) : []
    if (!dirs.length) return fail("llm_diverge_empty", "LLM 未返回 directions 阵列", { title: "发散失败" })
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
    if (!reqs.length) return fail("no_prompts", "LLM 方向内无有效 prompt", { title: "发散失败" })
    const dryRun = args.dry_run !== false
    if (dryRun) {
      return ok({
        title: `moodboard dry_run：${dirs.length} 方向 × ${nPer} 张 = ${reqs.length} 张`,
        directions: dirs.slice(0, nDir).map((d) => ({ label: String(d?.label ?? ""), rationale: String(d?.rationale ?? "") })),
        ...(await planRequests(reqs, context.sessionID, context.abort)),
      })
    }
    const batch = await runGenBatch(reqs, context.sessionID, context.abort, `情绪板发散：${reqs.length} 张（${model}）`)
    if (!batch.ok) return fail(batch.code, batch.hint, { title: "批量生图失败", ...batch.detail })
    const groups = labels.map((label) => ({
      direction: label,
      rationale: String(dirs.find((d) => String(d?.label) === label)?.rationale ?? ""),
      items: batch.results
        .filter((r) => r.tag.startsWith(`${label}#`))
        .map((r) => ({ tag: r.tag, prompt: r.prompt, task_id: r.task_id, status: r.status, url: r.url, seed: null, cost_coins: r.cost_coins, ...(r.error ? { error: r.error } : {}) })),
    }))
    const rank = await llmChatJson(RANK_SYSTEM, `主题：${theme}。方向清单：${JSON.stringify(groups.map((g) => ({ label: g.direction, rationale: g.rationale })))}`, 2000)
    return ok(
      {
        title: `情绪板：${groups.length} 方向 ${reqs.length} 张`,
        groups,
        convergence: rank.ok ? { ranking: rank.data?.ranking ?? null, recommendation: rank.data?.recommendation ?? null } : { ranking: null, recommendation: null, note: `LLM 排序不可用：${rank.reason}` },
        total_cost_coins: batch.total_cost_coins,
        seed_policy: SEED_NOTE,
        note: "诚实：收敛不自动——ranking/recommendation 仅为 LLM 推荐，最终方向必须由用户圈选决定。",
      },
      { groups, total_cost_coins: batch.total_cost_coins },
    )
  },
})
