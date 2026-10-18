import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

function errorText(data: unknown, fallback: string): string {
  const d = (data ?? {}) as Record<string, unknown>
  if (typeof d.error === "string" && d.error) return d.error
  const nested = d.error as Record<string, unknown> | undefined
  if (nested && typeof nested.hint === "string" && nested.hint) return nested.hint
  if (nested && typeof nested.message === "string" && nested.message) return nested.message
  if (typeof d.detail === "string" && d.detail) return d.detail
  return fallback
}

export default tool({
  description: [
    "监视外部事件源：start 立即返回 monitor id，事件作为会话事件推送。",
    "何时用：等待任务完成、日志出现、服务恢复等外部条件；只是稍后再查用 schedule_wakeup。",
    "关键约束：command 与 ws 二选一；timeout_ms 默认 300000、上限 1800000；每秒最多 20 条，超出丢弃计数；stop 需正整数 monitor_id；本工具没有 noop 参数。",
    "失败处置：bad_action 表示 action 不是 start/stop/status；missing_description 补描述；bad_source 表示 command/ws 必须且只能填一个；missing_monitor_id 补 id；monitor_failed 按 gateway 文本修正。",
    "互指：稍后再查用 schedule_wakeup；周期性提醒用 cron_create；不要用 sleep 或连续轮询轰炸。",
    "示例：monitor_watch({action:start, description:等待渲染完成, command:tail -f /tmp/render.log | grep -m1 DONE, timeout_ms:600000})",
  ].join("\n"),
  args: {
    action: tool.schema
      .string()
      .optional()
      .describe("start | stop | status（必填）"),
    description: tool.schema
      .string()
      .optional()
      .describe("短句说明在监视什么（start 必填，给用户看）"),
    timeout_ms: tool.schema
      .number()
      .optional()
      .describe("超时毫秒，默认 300000，上限 1800000（超过压到上限）"),
    command: tool.schema
      .string()
      .optional()
      .describe("shell 命令：每行 stdout 为一个事件，进程退出即结束（与 ws 二选一）"),
    ws: tool.schema
      .string()
      .optional()
      .describe("WebSocket URL（ws:// 或 wss://）：每帧为一个事件（与 command 二选一）"),
    monitor_id: tool.schema
      .number()
      .optional()
      .describe("已有 monitor 的 id（stop 必填；status 可选用于只查一个）"),
  },
  async execute(args, context) {
    const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : ""
    if (action !== "start" && action !== "stop" && action !== "status") {
      return fail("bad_action", "action 必须是 start、stop 或 status")
    }
    const payload: Record<string, unknown> = { session_id: context.sessionID }
    if (action === "start") {
      const description = typeof args.description === "string" ? args.description.trim() : ""
      if (!description) return fail("missing_description", "description 必填：用一句短句说明在监视什么")
      const command = typeof args.command === "string" ? args.command.trim() : ""
      const ws = typeof args.ws === "string" ? args.ws.trim() : ""
      if (Boolean(command) === Boolean(ws)) return fail("bad_source", "command 与 ws 必须二选一且只填一个")
      payload.description = description
      if (command) payload.command = command
      if (ws) payload.ws = ws
      if (typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms)) payload.timeout_ms = args.timeout_ms
    } else if (action === "stop") {
      if (typeof args.monitor_id !== "number" || !Number.isInteger(args.monitor_id) || args.monitor_id <= 0) {
        return fail("missing_monitor_id", "stop 需要正整数 monitor_id")
      }
      payload.monitor_id = args.monitor_id
    } else if (typeof args.monitor_id === "number" && Number.isInteger(args.monitor_id) && args.monitor_id > 0) {
      payload.monitor_id = args.monitor_id
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/monitor/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data?.ok === false) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "monitor_failed",
          errorText(data, `HTTP ${res.status}`),
          { http_status: res.status },
        )
      }
      if (action === "start") {
        return ok({
          monitor_id: data.id as number,
          status: "running",
          description: data.description as string,
          timeout_ms: data.timeout_ms as number,
          note: typeof data.note === "string" ? data.note : "监视已启动；事件会作为会话事件推送。",
        })
      }
      if (action === "stop") {
        return ok({ monitor_id: args.monitor_id, stopped: data.stopped === true, status: data.status })
      }
      if (data.monitor) return ok({ monitor: data.monitor })
      return ok({ monitors: Array.isArray(data.monitors) ? data.monitors : [] })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error)?.message || String(e))
    }
  },
})
