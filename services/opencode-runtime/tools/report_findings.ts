import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"
const FINDINGS_MAX_ITEMS = 32
const SHORT_SUMMARY_MAX_CHARS = 60

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const token = process.env.HARNESS_INTERNAL_TOKEN
  if (token) headers["X-Internal-Token"] = token
  return headers
}

export default tool({
  description: [
    "提交结构化评审问题（ReportFindings），一批写完。",
    "何时用：只在评审指令明确要求时报；评审结束时一次报完，不要分批。",
    "关键约束：最多 32 条；空数组合法（没有存活问题）；每条必填 file、summary、failure_scenario；file 用仓库相对路径（禁止绝对路径与 ..），line 为 1-based。",
    "失败处置：missing_required_args 表示 findings 缺失或不是数组；invalid_findings 表示超过 32 条，只报最重要的并按严重度排序；findings_report_failed 按 gateway hint 修正。",
    "互指：findings 是评审结论，不是任务；要跟踪修复用 task_create/task_update；交付物验证用 artifact_verify。",
    "消费边界：findings 会持久化供人工审计与事后查询（/internal/findings/list），当前没有自动修复或自动门禁消费方；不要假设有人会自动处理，需修复时另建任务。请在最终回报中列出本次 run_id 与条数。",
    "示例：report_findings({findings:[{file:src/auth.ts, line:42, summary:session 过期后 user 为 undefined, failure_scenario:过期 token 命中缓存后访问 user.id 崩溃}]})",
  ].join("\n"),
  args: {
    level: tool.schema
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("本次评审深度档位（可选）"),
    findings: tool.schema
      .array(
        tool.schema.object({
          file: tool.schema.string().describe("仓库相对路径（必填，禁止绝对路径与 ..）"),
          line: tool.schema.number().int().min(1).optional().describe("1-based 行号（可选）"),
          summary: tool.schema.string().describe("一句话缺陷陈述（必填）"),
          short_summary: tool.schema
            .string()
            .optional()
            .describe(`≤${SHORT_SUMMARY_MAX_CHARS} 字符，只讲主张（可选）`),
          failure_scenario: tool.schema
            .string()
            .describe("具体输入/状态 → 错误输出或崩溃（必填，禁止空泛描述）"),
          category: tool.schema
            .string()
            .optional()
            .describe("kebab-case 分类，如 correctness / simplification / efficiency / test-coverage"),
          verdict: tool.schema.enum(["CONFIRMED", "PLAUSIBLE"]).optional().describe("CONFIRMED=已复现；PLAUSIBLE=仅推断"),
          outcome: tool.schema
            .enum(["fixed", "skipped", "no_change_needed"])
            .optional()
            .describe("仅修复后重报时用：fixed / skipped / no_change_needed"),
        }),
      )
      .describe("本次全部评审问题，按严重度从高到低（最多 32 条；空数组=没有存活的问题）"),
    run_id: tool.schema
      .string()
      .optional()
      .describe("评审批次标识：显式复用同一值＝同一批次整批替换（幂等）；不传＝每次上报生成独立批次（多个 critic 不会互相覆盖）"),
  },
  async execute(args, context) {
    if (!Array.isArray(args.findings)) {
      return fail("missing_required_args", "report_findings 缺少必填字段：findings（没有存活的问题时传空数组）")
    }
    if (args.findings.length > FINDINGS_MAX_ITEMS) {
      return fail(
        "invalid_findings",
        `findings 最多 ${FINDINGS_MAX_ITEMS} 条（当前 ${args.findings.length}）；请只报最重要的缺陷并按严重度排序`,
      )
    }

    try {
      const res = await fetch(`${GATEWAY}/internal/findings/report`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          session_id: context.sessionID,
          level: args.level,
          findings: args.findings,
          run_id: args.run_id,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok !== true) {
        return fail(
          typeof data?.error?.code === "string" && data.error.code ? data.error.code : "findings_report_failed",
          data?.error?.hint || data?.error || `HTTP ${res.status}`,
          Array.isArray(data?.errors) ? { errors: data.errors } : { http_status: res.status },
        )
      }
      return ok({ count: data.count, run_id: data.run_id, latest_run: data.latest_run })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
