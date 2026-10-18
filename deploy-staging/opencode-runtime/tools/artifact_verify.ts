import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

export default tool({
  description: [
    "对 artifact 的 url 做真实探测并与落库 sha256 比对。",
    "何时用：发布后、交付前，需要证明链接真的可访问时；没有 url 或还没发布时不要调用。",
    "关键约束：只有 state=verified 才算通过；blocked 如实回报并带 reason；no_row 不得当作干净；sha256_match 必须为 true。",
    "失败处置：verify_no_row 表示没有探测结果（artifact 无 url），补 url 后重试；verify_blocked 回传 reason/status，不要宣称通过；artifact_verify_failed 按 gateway 文本修正。",
    "互指：读元数据用 artifact_get；发布用 artifact_publish；不得用已登记代替已验证。",
    "示例：artifact_verify({name:film_final_cut, version:3})",
  ].join("\n"),
  args: {
    name: tool.schema.string().describe("artifact 名称"),
    version: tool.schema.number().optional().describe("版本号；省略取 latest_version"),
  },
  async execute(args, context) {
    try {
      const resp = await fetch(`${GATEWAY}/internal/artifact/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: context.sessionID,
          name: args.name,
          version: args.version,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || !data?.ok) {
        return fail(
          typeof data?.code === "string" && data.code ? data.code : "artifact_verify_failed",
          data?.error || `HTTP ${resp.status}`,
          { title: "验证失败", http_status: resp.status },
        )
      }
      const probe = {
        state: data.state,
        verify_status: data.verify_status,
        reason: data.reason,
        status: data.status,
        content_type: data.content_type,
        bytes: data.bytes,
        sha256: data.sha256,
        expected_sha256: data.expected_sha256,
        sha256_match: data.sha256_match,
        method: data.method,
        partial: data.partial,
        error: data.error,
        version: data.version,
        url: data.url,
        verified_at: data.verified_at,
      }
      if (data.state === "no_row") {
        return fail("verify_no_row", "没有探测结果（artifact 无 url），不能宣称干净；请补 url 后重试", {
          title: "未验证（no_row）",
          probe,
        })
      }
      if (data.state !== "verified") {
        return fail("verify_blocked", `探测未通过：${data.reason ?? "unknown"}（status=${data.status ?? "none"}）`, {
          title: "验证被阻断（blocked）",
          probe,
        })
      }
      return ok({
        title: `验证通过 v${data.version}（sha256 一致）`,
        probe,
      })
    } catch (e) {
      return fail("network_error", `artifact 验证通信失败：${e instanceof Error ? e.message : String(e)}`, {
        title: "验证失败",
      })
    }
  },
})
