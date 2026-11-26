import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "读取 artifact 元数据与最近一次验证状态。",
    "何时用：发布或验证后复核版本、sha256、url；要重新探测真实性时用 artifact_verify。",
    "关键约束：省略 version 取 latest_version；verify_status=no_row 不得当作通过；只读，不改变版本。",
    "失败处置：artifact_get_failed 按 gateway 文本修正（名称或版本不存在）；network_error 稍后重试；no_row 时补 url 并 verify。",
    "互指：发布用 artifact_publish，探测用 artifact_verify；具型产物登记用 artifact_register。",
    "示例：artifact_get({name:film_final_cut})",
  ].join("\n"),
  args: {
    name: tool.schema.string().describe("artifact 名称"),
    version: tool.schema.number().optional().describe("版本号；省略取 latest_version"),
  },
  async execute(args, context) {
    try {
      const resp = await fetch(`${GATEWAY}/internal/artifact/get`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.HARNESS_INTERNAL_TOKEN ? { "X-Internal-Token": process.env.HARNESS_INTERNAL_TOKEN } : {}),
        },
        body: JSON.stringify({
          session_id: context.sessionID,
          name: args.name,
          version: args.version,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "artifact_get_failed",
          data?.error || `HTTP ${resp.status}`,
          { title: "读取失败", http_status: resp.status },
        )
      }
      const artifact = data.artifact
      return ok({
        title: `${artifact?.slug ?? args.name} v${artifact?.version ?? "?"}（${artifact?.verify_status ?? "no_row"}）`,
        artifact,
      })
    } catch (e) {
      return fail("network_error", `artifact 读取通信失败：${e instanceof Error ? e.message : String(e)}`, {
        title: "读取失败",
      })
    }
  },
})
