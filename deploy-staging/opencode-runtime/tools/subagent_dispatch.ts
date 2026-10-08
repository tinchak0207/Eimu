import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

const POLL_INTERVAL_MS = 4000
const POLL_DEADLINE_MS = 16 * 60 * 1000 // 网关侧 15 分钟硬顶会先以 error 收尾

// D2（2026-10-02）：必填自检与示例——把过去 135 次空参数（`{}`）造成的
// opencode schema 空错误码，换成「指名缺哪栏 + 可照抄的完整参数」。
const EXAMPLE_ARGS = {
  label: "素材整理",
  prompt:
    "目标：把 inputs/ 下的 12 张草图按主题分成 3 组。素材：inputs/*.png。验收标准：输出分组清单，每组列出文件名且不重不漏。预期产出格式：Markdown 表格。",
  expert: "editor",
  async: true,
}
const EXAMPLE_JSON = JSON.stringify(EXAMPLE_ARGS)

export default tool({
  description: [
    "派一个子代理（subagent）执行一个自包含任务。用于多步骤任务、大素材加工、可并行的探索/生成——把活拆给子代理，主对话保持精简。",
    "**必填两个字段**：`label`（短标签，简体中文，≤20 字）与 `prompt`（自包含任务书：目标、素材路径/数据、验收标准、预期产出格式，四样缺一不可；子代理看不到你们的对话历史，只能拿到 prompt 里的信息）。缺任一个都会被拒，并回传缺哪个字段与一个可照抄的完整参数示例。",
    "async=true（后台模式，默认推荐）：立即返回，主对话可继续推进其他工作或结束回合；子代理完成后系统自动唤醒你并附结果摘要（失败也唤醒并附死因）。async=false（默认）：阻塞等待完成并直接返回 summary，仅用于必须立即拿结果才能继续的小任务。",
    "并发上限 3；满了工具会返回「已有 3 个子代理在跑，等一个完成再派」，此时等一个完成再派，不要连续重试（连续重试同一参数会被工具层重复呼叫断路器拦截）。",
    "简单单步任务（答一句话、一张图的直接生成）不要派，避免杀鸡用牛刀。野兽模式下派 Expert 域内任务时指定 expert 栏（如 3D 场景→director3d、剪辑→editor），让子代理以该域专家身分与工具表执行。",
    `示例参数：${EXAMPLE_JSON}`,
  ].join("\n"),
  args: {
    label: tool.schema
      .string()
      .optional()
      .describe("短标签，简体中文，≤20 字，如「第一章总结」「素材整理」（必填；缺失会被拒并回传示例）"),
    prompt: tool.schema
      .string()
      .optional()
      .describe("给子代理的完整任务书（必填）：目标、素材路径/数据、验收标准、预期产出格式，四样缺一不可"),
    expert: tool.schema
      .string()
      .optional()
      .describe(
        "Expert id（lyricist/music 在野兽模式关闭时也生效）：director3d=3D导演 / music=音乐导演 / lyricist=歌词专家 / video-director=视频导演 / editor=剪辑师 / screenwriter=编剧分镜 / motion-director=动态设计 / web3d-director=Web3D导演。指定后子代理以该 Expert 身分执行（仅持该域工具）。野兽模式关闭时仍可指定 lyricist/music，其他域或省略时=通用子代理。",
      ),
    async: tool.schema
      .boolean()
      .optional()
      .describe(
        "true=后台派出立即返回，完成后自动唤醒主会话附结果摘要（失败也唤醒），军团并发派遣一律用它；缺省/false=同步等待结果（仅限必须立即拿结果的小任务）",
      ),
  },
  async execute(args, context) {
    // D2：必填先自检——不让空参数走到网路层，也不回空错误码。
    const label = typeof args.label === "string" ? args.label.trim() : ""
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
    const missing: string[] = []
    if (!label) missing.push("label")
    if (!prompt) missing.push("prompt")
    if (missing.length > 0) {
      return fail(
        "missing_required_args",
        `subagent_dispatch 缺少必填字段：${missing.join("、")}。请补齐后重呼；完整参数示例：${EXAMPLE_JSON}`,
        { missing, example: EXAMPLE_ARGS },
      )
    }
    try {
      const asyncMode = args.async === true
      const expert = typeof args.expert === "string" && args.expert.trim() ? args.expert.trim() : undefined
      const res = await fetch(`${GATEWAY}/internal/subagent/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: context.sessionID,
          label,
          prompt,
          async: asyncMode,
          ...(expert !== undefined ? { expert } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "dispatch_failed",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      const subagentId = data.subagent_id as string
      // R6 后台模式：网关已受理，立即返回，完成时网关自动唤醒主会话。
      if (asyncMode && data.status === "running") {
        return ok({
          title: "子代理已后台派出",
          subagent_id: subagentId,
          label,
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
