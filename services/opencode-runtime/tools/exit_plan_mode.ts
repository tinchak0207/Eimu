import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

type ExitResponse = {
  success?: boolean
  approved?: boolean
  pending?: boolean
  reason?: string
  plan?: string
  filePath?: string
  file_path?: string
  prePlanMode?: string
  requestId?: string
  code?: string
  error?: string
}

export default tool({
  description: [
    "在计划模式下请求用户批准计划并退出计划模式。",
    "何时用：已把完整计划写入 plan_file_path，准备开始实施时；计划没写完或用户没要求审批时不要调用。",
    "关键约束：只有 approved:true 才能实施。本工具只请求一次，不等待。reason=pending 表示计划仍待用户确认，不要空转重试，也不要开始实施。",
    "失败处置：plan_denied 按用户反馈改计划；plan_expired 修改后重试；gateway_unreachable 稍后重试。",
    "互指：进入用 enter_plan_mode；批准后的实施用 task_update 更新任务；不要把批准当作用户授权一切后续动作。",
    "示例：exit_plan_mode()",
  ].join("\n"),
  args: {},
  async execute(_args, context) {
    let res: Response
    try {
      res = await fetch(`${GATEWAY}/internal/plan/exit`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({ session_id: context.sessionID, wait_ms: 0 }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      return fail("gateway_unreachable", `请求计划审批失败：${e instanceof Error ? e.message : String(e)}`)
    }
    const data = (await res.json().catch(() => ({}))) as ExitResponse
    if (!res.ok || data.success === false) {
      return fail(
        typeof data.code === "string" && data.code ? data.code : "exit_plan_mode_failed",
        typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`,
        { http_status: res.status },
      )
    }
    if (data.approved === true) {
      return ok({
        title: "计划已批准，可以开始实施",
        plan: data.plan,
        file_path: data.filePath ?? data.file_path,
        pre_plan_mode: data.prePlanMode,
        note: "用户已批准计划。开始实施前先更新任务清单；计划文件保留在磁盘上供回看。",
      })
    }
    if (data.pending === true || data.reason === "pending") {
      return ok({
        pending: true,
        approved: false,
        request_id: data.requestId,
        plan: data.plan,
        file_path: data.filePath ?? data.file_path,
        note: "计划仍待用户确认，尚未批准。不要空转重试，不要开始实施。等用户确认后再调用一次 exit_plan_mode。",
      })
    }
    return fail(
      data.reason === "denied" ? "plan_denied" : "plan_expired",
      data.reason === "denied" ? "用户拒绝了计划。保持计划模式，按反馈修改计划后再次调用。" : "审批已过期。修改计划后再次调用。",
      { plan: data.plan, file_path: data.filePath ?? data.file_path, reason: data.reason },
    )
  },
})
