import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const POLL_INTERVAL_MS = 4000
const POLL_DEADLINE_MS = 16 * 60 * 1000 // 网关侧 15 分钟硬顶会先以 error 收尾

export default tool({
  description:
    "派一个子代理（subagent）执行一个自包含任务。用于多步骤任务、大素材加工、可并行的探索/生成——把活拆给子代理，主对话保持精简。任务书（prompt）必须自包含：目标、素材路径/数据、验收标准、预期产出格式，四样缺一不可（子代理看不到你们的对话历史，只能拿到 prompt 里的信息）。async=true（后台模式，默认推荐）：立即返回，主对话可继续推进其他工作或结束回合；子代理完成后系统自动唤醒你并附结果摘要（失败也唤醒并附死因），禁止轮询等待。async=false（默认，同步模式）：阻塞等待完成并直接返回 summary，仅用于必须立即拿结果才能继续的小任务。并发上限 3；满了工具会返回「已有 3 个子代理在跑，等一个完成再派」，此时等一个完成再派，不要连续重试。简单单步任务（答一句话、一张图的直接生成）不要派，避免杀鸡用牛刀。野獸模式下派 Expert 域內任務時指定 expert 欄（如 3D 場景→director3d、剪輯→editor），讓子代理以該域專家身分與工具表執行。",
  args: {
    label: tool.schema.string().describe("短标签，简体中文，≤20 字，如「第一章总结」「素材整理」"),
    prompt: tool.schema.string().describe("给子代理的完整任务书（自包含：目标、素材路径/数据、验收标准、预期产出格式）"),
    expert: tool.schema
      .string()
      .optional()
      .describe(
        "Expert id（僅野獸模式生效）：director3d=3D導演 / music=音樂導演 / video-director=視頻導演 / editor=剪輯師 / screenwriter=編劇分鏡 / motion-director=動態設計 / web3d-director=Web3D導演。指定後子代理以該 Expert 身分執行（僅持該域工具）。非野獸模式或省略時=通用子代理。",
      ),
    async: tool.schema
      .boolean()
      .describe(
        "true=后台派出立即返回，完成后自动唤醒主会话附结果摘要（失败也唤醒），军团并发派遣一律用它；缺省/false=同步等待结果（仅限必须立即拿结果的小任务）",
      ),
  },
  async execute(args, context) {
    try {
      const asyncMode = args.async === true
      const expert = typeof args.expert === "string" && args.expert.trim() ? args.expert.trim() : undefined
      const res = await fetch(`${GATEWAY}/internal/subagent/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: context.sessionID,
          label: args.label,
          prompt: args.prompt,
          async: asyncMode,
          ...(expert !== undefined ? { expert } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail("dispatch_failed", data?.error || `HTTP ${res.status}`)
      }
      const subagentId = data.subagent_id as string
      // R6 后台模式：网关已受理，立即返回，完成时网关自动唤醒主会话。
      if (asyncMode && data.status === "running") {
        return ok({
          title: "子代理已后台派出",
          subagent_id: subagentId,
          label: args.label,
          status: "running",
          note: typeof data.note === "string" ? data.note : "后台运行中，完成后自动唤醒主会话汇总。结束本轮，不要轮询等待。",
        })
      }
      // 同步模式（或缺省）：原语义阻塞轮询，零回归。
      const deadline = Date.now() + POLL_DEADLINE_MS
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (context.abort?.aborted) {
          return fail("aborted", "会话中断，已停止等待子代理结果")
        }
        let st: any
        try {
          const sr = await fetch(`${GATEWAY}/internal/subagent/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: context.sessionID, subagent_id: subagentId }),
            signal: AbortSignal.timeout(10000),
          })
          st = await sr.json().catch(() => ({}))
        } catch {
          continue // 单次轮询失败不放弃，继续等下一轮
        }
        if (st?.done) {
          if (st.status === "ok") {
            return ok({ title: "子代理完成", summary: st.summary ?? "" })
          }
          return fail("subagent_error", st.error || st.summary || "子代理失败")
        }
      }
      return fail("timeout", "等待子代理结果超时（16 分钟），请稍后用相同 label 重新派发")
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
