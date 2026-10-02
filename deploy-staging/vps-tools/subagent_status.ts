import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "查询已派出子代理（subagent）的运行状态/结果。用于：async 派出后查进度、判断多个并行子代理是否到齐、唤醒过后复核摘要。",
    "`subagent_id` 传 subagent_dispatch 返回的完整 run id；也可传 `latest` 取得本会话最近一次 run（不必记住 id）。也支持 label 前缀，命中多笔会回候选清单（此时请用完整 runId 重查）。",
    "返回运行中（done=false，含已耗时）或终态（done=true，ok=summary / error=死因）。结果在网关侧保留 10 分钟，过期会报「不存在或已过期」并附最近 3 笔 run 供你改用；已落盘的产物会附 artifact_path，直接 read 验收，不要重派。",
    "若只是等后台子代理完成，可结束本轮由自动唤醒回灌；也可按需轮询——轮询不会被禁用，但同一 id 连续同参数轮询超过阈值会收到「改变参数或停止」的工具层提示。",
  ].join("\n"),
  args: {
    subagent_id: tool.schema
      .string()
      .optional()
      .describe("subagent_dispatch 返回的完整 subagent_id，或 `latest`（本会话最近一次 run），或 label 前缀（必填；缺失会被拒并回传示例）"),
  },
  async execute(args, context) {
    const id = typeof args.subagent_id === "string" ? args.subagent_id.trim() : ""
    if (!id) {
      return fail(
        "missing_required_args",
        "subagent_status 缺少必填字段：subagent_id。请传 subagent_dispatch 返回的 run id，或传 \"latest\" 取本会话最近一次 run。示例：{\"subagent_id\":\"latest\"}",
        { missing: ["subagent_id"], example: { subagent_id: "latest" } },
      )
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/subagent/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: context.sessionID, subagent_id: id }),
        signal: AbortSignal.timeout(10000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "not_found",
          data?.error || `HTTP ${res.status}`,
          { http_status: res.status },
        )
      }
      // label 前缀命中多笔：回候选清单（不是假 not_found）。
      if (data.multiple === true) {
        return ok({
          title: "命中多笔子代理",
          multiple: true,
          candidates: Array.isArray(data.candidates) ? data.candidates : [],
          note: typeof data.note === "string" ? data.note : "label 前缀命中多笔，请用完整 runId 重查。",
        })
      }
      // run 记录过期但产物已落盘：给路径让调用方直接验收。
      if (data.artifact_path) {
        return ok({
          title: "子代理记录已过期（产物在盘）",
          status: data.status ?? "unknown",
          label: data.label ?? "",
          artifact_path: data.artifact_path,
          artifact_bytes: data.artifact_bytes ?? 0,
          note: typeof data.note === "string" ? data.note : "run 记录已过期但产物已落盘：直接 read 该路径验收，勿重派。",
        })
      }
      if (data.done) {
        if (data.status === "ok") {
          return ok({ title: "子代理已完成", status: "ok", summary: data.summary ?? "" })
        }
        return fail("subagent_error", data.error || data.summary || "子代理失败", { done: true })
      }
      return ok({
        title: "子代理运行中",
        subagent_id: data.subagent_id ?? id,
        status: "running",
        label: data.label ?? "",
        elapsed_ms: data.elapsed_ms ?? 0,
        note: "仍在运行。可按需再查，或结束本轮等自动唤醒。",
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
