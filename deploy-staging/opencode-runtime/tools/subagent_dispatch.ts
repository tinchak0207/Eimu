import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// 单次网关挂起上限：wait_ms>0 且仍 running 时 gateway 挂在端点上，状态变化
// 立即回，或等满此值回当前态。env SUBAGENT_WAIT_MS 可覆写。
const WAIT_MS = Number(process.env.SUBAGENT_WAIT_MS || 20_000)
const POLL_DEADLINE_MS = 16 * 60 * 1000 // 网关侧 15 分钟硬顶会先以 error 收尾

// F9（P1·把「成功」报成「失败」修复）：终态成败映射——**与 tools/subagent_status.ts 的
// STATUS_IS_FAILURE 同源**（其真源＝gateway types-gateway.ts 的 TASK_STATUS_SEMANTICS.isFailure）。
// stopped（人工停）/interrupted/suspended/partial 都不是失败，只有 error/timeout 类才算失败。
// 工具档之间无法共享常量（各自独立打包），故此处内联同一判据；两处必须同步改动。
const STATUS_IS_FAILURE: Record<string, boolean> = {
  ok: false,
  error: true,
  stopped: false,
  running: false,
  interrupted: false,
  suspended: false,
  timeout: true,
  partial: false,
}

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
    "派一个子代理执行自包含任务。",
    "何时用：多步骤、大素材加工、可并行的研究或生成；主对话需要保持精简时。",
    "何时不用：单步琐事、一句话能答的不要派；fork 由子代理发起，主会话不得 fork。",
    "关键约束：label 与 prompt 必填；prompt 含目标、素材路径、验收标准、产出格式；async 默认后台；并发上限 3；model/effort 仅在用户明确点名时设置。",
    "失败处置：missing_required_args 补 label/prompt；dispatch_failed 按 gateway 文本修正；subagent_error 读 summary 决定修任务书还是换路；timeout 用相同 label 重新派发；aborted 表示会话中断。",
    "互指：后续纠偏用 subagent_message，停止用 subagent_stop，查状态用 subagent_status。",
    "示例：subagent_dispatch({label:研究竞品, prompt:研究 3 个同类纪录片开场，输出文件路径、时间码与手法对比表；验收：每条都有真实链接与时间码。, async:true})",
  ].join("\n"),
  args: {
    label: tool.schema
      .string()
      .optional()
      .describe("短标签，简体中文，≤20 字，如「第一章总结」「素材整理」（必填；缺失会被拒并回传示例）"),
    prompt: tool.schema
      .string()
      .optional()
      .describe("给子代理的完整任务书（必填）：目标、素材路径/数据、验收标准、预期产出格式，四样缺一不可；fork 时这里是那一条指令"),
    expert: tool.schema
      .string()
      .optional()
      .describe(
        "Expert id（lyricist/music 在野兽模式关闭时也生效）：director3d=3D导演 / music=音乐导演 / lyricist=歌词专家 / video-director=视频导演 / editor=剪辑师 / screenwriter=编剧分镜 / motion-director=动态设计 / web3d-director=Web3D导演。指定后子代理以该 Expert 身分执行（仅持该域工具）。野兽模式关闭时仍可指定 lyricist/music，其他域或省略时=通用子代理。fork 忽略。",
      ),
    async: tool.schema
      .boolean()
      .optional()
      .describe(
        "缺省 true=后台派出立即返回，完成后自动唤醒主会话附结果摘要（失败也唤醒），军团并发派遣一律用它；只有下一步必须依赖结果且期间无事可做时才传 false 同步等待",
      ),
    fork: tool.schema
      .boolean()
      .optional()
      .describe("true=派生 worker fork：继承本会话完整历史与工具面，只执行 prompt 里的一条指令后停止；恒后台。等价于 subagent_type:\"fork\""),
    subagent_type: tool.schema
      .string()
      .optional()
      .describe('子代理类型；目前只接受 "fork"（与 fork:true 等价），其他值会走普通子代理路径'),
    model: tool.schema
      .string()
      .optional()
      .describe('显式模型覆写，如 "provider/model" 或可补齐 provider 的 modelID；只在用户或规则明确点名时使用，fork 忽略'),
    effort: tool.schema
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("推理强度档位（作为 opencode variant 传给模型，真正生效；不支持的 agent 会回 variant_applied:false；fork 忽略）；只在用户或规则明确点名时使用"),
    name: tool.schema
      .string()
      .optional()
      .describe("可寻址名（≤64 字符，字母数字开头，仅字母/数字/下划线/连字符；main/team-lead/user/system/latest 保留）；之后可按名字 subagent_message/subagent_status"),
    from_checkpoint_run_id: tool.schema
      .string()
      .optional()
      .describe("前序子代理的 runId（断点接管）：指定后自动继承该子代理最近落盘的检查点，绝不从零重跑已完成阶段"),
    from_checkpoint_id: tool.schema
      .string()
      .optional()
      .describe("继承前序子代理的指定检查点 ID（可选，缺省自动取最新检查点）"),
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
      // CC 2.1.302：后台是默认，不是可选加速。只有显式 false 才同步。
      const asyncMode = args.async !== false
      const expert = typeof args.expert === "string" && args.expert.trim() ? args.expert.trim() : undefined
      const fork = args.fork === true || args.subagent_type === "fork"
      const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined
      const effort = typeof args.effort === "string" && args.effort.trim() ? args.effort.trim() : undefined
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined
      const fromCpRunId = typeof args.from_checkpoint_run_id === "string" && args.from_checkpoint_run_id.trim() ? args.from_checkpoint_run_id.trim() : undefined
      const fromCpId = typeof args.from_checkpoint_id === "string" && args.from_checkpoint_id.trim() ? args.from_checkpoint_id.trim() : undefined
      const res = await fetch(`${GATEWAY}/internal/subagent/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: context.sessionID,
          label,
          prompt,
          async: asyncMode,
          ...(fork ? { fork: true } : {}),
          ...(expert !== undefined ? { expert } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(fromCpRunId !== undefined ? { from_checkpoint_run_id: fromCpRunId } : {}),
          ...(fromCpId !== undefined ? { from_checkpoint_id: fromCpId } : {}),
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
      // D5：以**服务端** data.async / data.status 决定是否早退，而不是本地的 async 请求值。
      // fork:true, async:false 时网关恒返回 async:true；若照本地参数走轮询＝同一结果
      // 既由唤醒送达、又被工具取件＝双重交付。
      const serverAsync = data.async === true || data.status === "running"
      if (serverAsync) {
        return ok({
          title: fork ? "fork 已后台派出" : "子代理已后台派出",
          subagent_id: subagentId,
          ...(typeof data.name === "string" ? { name: data.name } : {}),
          ...(fork ? { fork: true, model: "inherit" } : {}),
          label,
          status: "running",
          async: true,
          ...(data.variant_applied !== undefined ? { variant_applied: data.variant_applied } : {}),
          note:
            typeof data.note === "string" && data.note
              ? data.note
              : "后台运行中，完成后自动唤醒主会话汇总。结束本轮，不要轮询等待。",
        })
      }
      // 同步模式（或缺省）：长挂起取件（wait_ms），零回归。
      const deadline = Date.now() + POLL_DEADLINE_MS
      while (Date.now() < deadline) {
        if (context.abort?.aborted) {
          return fail("aborted", "会话中断，已停止等待子代理结果")
        }
        let st: any
        try {
          const sr = await fetch(`${GATEWAY}/internal/subagent/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: context.sessionID, subagent_id: subagentId, wait_ms: WAIT_MS }),
            // 逾时必须 > WAIT_MS，否则 20s 挂起会被本地超时砍断。
            signal: AbortSignal.timeout(WAIT_MS + 10_000),
          })
          st = await sr.json().catch(() => ({}))
        } catch {
          continue // 单次取件失败不放弃，继续等下一轮（wait_ms 天然限速，不会满速死回圈）
        }
        if (st?.done) {
          // F9：按终态成败表判定，不再「status !== "ok" 即失败」——终态 stopped（人工停）等非失败
          // 状态不得回 fail（否则 orchestrator 收到「失败」会倾向重派＝重复付费生成）。
          const failed = STATUS_IS_FAILURE[String(st.status)] === true
          if (!failed) {
            const title =
              st.status === "stopped" ? "子代理已停止（非失败）" : st.status === "interrupted" ? "子代理已中断（非终态）" : "子代理完成"
            return ok({
              title,
              status: st.status ?? "ok",
              summary: st.summary ?? "",
              ...(st.usage ? { usage: st.usage } : {}),
              ...(typeof st.name === "string" ? { name: st.name } : {}),
              ...(st.fork ? { fork: true } : {}),
            })
          }
          return fail("subagent_error", st.error || st.summary || "子代理失败", {
            status: st.status,
            ...(st.summary ? { summary: st.summary } : {}),
            ...(st.usage ? { usage: st.usage } : {}),
            ...(typeof st.name === "string" ? { name: st.name } : {}),
            ...(st.fork ? { fork: true } : {}),
          })
        }
      }
      return fail("timeout", "等待子代理结果超时（16 分钟），请稍后用相同 label 重新派发")
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
