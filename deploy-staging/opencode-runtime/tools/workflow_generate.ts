import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description:
    "Execute a canvas workflow (multi-shot film / character sheet / scenes). Returns immediately: status running = 已开跑；status confirm_pending = 已弹出批量扣费确认卡，用户批准后自动开跑（不要重调本工具，也不要轮询）。节点结果 auto-push 到画布；查进度用 workflow_status。",
  args: {
    workflow_id: tool.schema.string().describe("workflow_id"),
    override_zero_delivery: tool.schema.boolean().optional().describe("仅当 gateway 回 needs_override 且用户已明确同意时才传 true"),
    override_reason: tool.schema.string().optional().describe("用户同意的原话（覆写必填）"),
  },
  async execute(args, context) {
    try {
      const body = { workflow_id: args.workflow_id, session_id: context.sessionID, ...(args.override_zero_delivery ? { override_zero_delivery: true, override_reason: args.override_reason } : {}) }
      const res = await fetch(`${GATEWAY}/internal/workflow/generate?session_id=${context.sessionID}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) {
        if (data.status === "confirm_pending") {
          return ok({ status: "confirm_pending", note: data.note || "已弹出批量扣费确认卡，用户批准后自动开跑。不要重调本工具、不要轮询；可用 workflow_status 查看进度。" })
        }
        return ok({ status: data.status, ...(data.request_id ? { request_id: data.request_id } : {}), note: data.note || `gateway status: ${data.status}` })
      }
      if (data?.status === "needs_override") {
        return fail("workflow_needs_override", data.note || "近 24h 影片零交付，需用户明确同意后带 override_zero_delivery=true 重调。")
      }
      if (data?.reason === "already_running") {
        return fail("workflow_already_running", data.note || "该工作流正在运行中，本次 generate 被拒绝（未生效）。等批次结束后再调用；用 workflow_status 查进度。")
      }
      return fail("workflow_generate_failed", [data?.reason, data?.error, data?.note, data?.status].filter(Boolean).join(" | ") || `HTTP ${res.status}`)
    } catch (e) {
      // 誠實語義（2026-08-29 事故整改）：這裡的 timeout 只代表「工具層 30s 內
      // 沒等到網關應答」（網關重啟/網絡抖動/負載高都可能），不能證明後端宕機，
      // 更不能證明工作流已死。先 workflow_status 复核實際狀態，再決定重試。
      return fail(
        "workflow_no_response",
        `30 秒内网关未应答（${(e as Error).message}）。这只说明工具层超时，不代表后端宕机或工作流死亡。先用 workflow_status 查该工作流的实际状态：仍在跑/部分完成就继续等或 rerun 失败节点；确认不存在才考虑重建。`,
      )
    }
  },
})
