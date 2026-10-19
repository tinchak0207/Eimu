import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, harnessInternalHeaders } from "../lib/client"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

/**
 * 低成本记忆写入（2026-10-19）：模型只交「事实 + 证据」，结构/slug/描述/评分/域
 * 全部由网关 `memory-note.ts` 确定性补齐——不呼叫 LLM、不产生付费上游请求。
 *
 * 通道＝既有 memory_save 同一形态：POST /internal/memory/note（loopback-only，
 * 配了 HARNESS_INTERNAL_TOKEN 时带 X-Internal-Token），ownerKey 由网关从
 * 会话身份派生，工具不持有、也不能自报身份。
 */
export default tool({
  description: [
    "写入长期记忆（低成本通道）：只交一条事实和它的证据，网关自动补结构，不呼叫模型、不扣费。",
    "何时用：用户在对话中确认了稳定偏好/纠正，或工具结果里出现了对未来会话可复用的领域事实；临时的、可从现场重得的过程不要写。",
    "证据要求：evidence 必须是真实可核对的工具输出片段或用户明确确认的原话（至少 10 个字符）；自己的推理、凭感觉的总结不算证据。",
    "scope 纪律：shared 只用于「平台可观测的工具结果」，且会被跨账号佐证（人数不足只会进待审、不会直接全服可见）；任何个人偏好、客户信息、账号/会话痕迹一律 private。",
    "内容里不得出现密钥、token、密码、验证码、私钥或连接串；shared 不得出现用户标识、路径、价格、URL。",
    "一次只写一条事实（可多次调用）；保存成功后不要立刻回读。",
    "示例：memory_note({fact:平台图片生成任务完成后必须先 image_get_result 观察，再 image_result_download 验证落盘才算交付。, evidence:工具输出「downloaded:true, artifacts:2/2」, source:tool_result, scope:private})",
  ].join("\n"),
  args: {
    fact: tool.schema.string().describe("一条可独立成立的事实（1-2000 字）；不要写多件事"),
    evidence: tool.schema.string().describe("证据：工具结果原文片段或用户明确确认的话（≥10 字），不是自己的推理"),
    source: tool.schema.enum(["tool_result", "user_confirmed"]).describe("tool_result=平台工具的真实输出；user_confirmed=用户明确确认/纠正的原话"),
    scope: tool.schema.enum(["private", "shared"]).optional().describe("默认 private；shared 仅限平台可观测的工具结果，且会进入跨账号佐证"),
  },
  async execute(args, context) {
    const fact = typeof args.fact === "string" ? args.fact : ""
    const evidence = typeof args.evidence === "string" ? args.evidence : ""
    const source = typeof args.source === "string" ? args.source : ""
    const missing: string[] = []
    if (fact.trim().length === 0) missing.push("fact")
    if (evidence.trim().length === 0) missing.push("evidence")
    if (source !== "tool_result" && source !== "user_confirmed") missing.push("source")
    if (missing.length > 0) {
      return fail("missing_required_args", `memory_note 缺少或填错必填字段：${missing.join("、")}。请补齐后重呼。`, { missing })
    }
    // 约束：租户/身份由网关用 session 解析，工具只持有 session id。
    const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : ""
    if (!sessionID) {
      return fail("missing_session", "memory_note 需要会话上下文（sessionID），当前调用没有。")
    }
    try {
      const res = await fetch(`${GATEWAY}/internal/memory/note`, {
        method: "POST",
        headers: harnessInternalHeaders(),
        body: JSON.stringify({
          session_id: sessionID,
          fact,
          evidence,
          source,
          ...(typeof args.scope === "string" ? { scope: args.scope } : {}),
        }),
        signal: AbortSignal.timeout(20000),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || data.ok !== true) {
        const error = data.error as { code?: unknown; message?: unknown } | undefined
        const code = typeof error?.code === "string" && error.code ? error.code : "memory_note_failed"
        const message = typeof error?.message === "string" && error.message ? error.message : `HTTP ${res.status}`
        return fail(code, message, { http_status: res.status })
      }
      const accepted = Array.isArray(data.accepted) ? data.accepted : []
      const rejected = Array.isArray(data.rejected) ? data.rejected : []
      const proposals = Array.isArray(data.proposals) ? data.proposals : []
      // accepted＝平台真写入；proposals＝未提升的待佐证提案（live 未变，不是入库/生效）。
      if (accepted.length > 0) {
        return ok({
          title: "记忆已入库",
          accepted,
          rejected,
          proposals,
          note: "accepted=平台已真写入；rejected 含逐条原因（如 structure/quota_scope）。shared 可能进入待审而非立即全服可见。",
        })
      }
      if (proposals.length > 0) {
        return ok({
          title: "已记录为待佐证提案",
          accepted,
          rejected,
          proposals,
          note: "已记录为待佐证提案，尚未对所有人生效；需另一个账号独立佐证后才会提升为正式记忆。",
        })
      }
      // 既无实写也无提案：按服务端 rejected 原因代号回报失败（不回显正文）。
      const firstRejected = rejected[0] as { reason?: unknown } | undefined
      const reasonCode =
        typeof firstRejected?.reason === "string" && firstRejected.reason
          ? firstRejected.reason
          : "memory_not_accepted"
      return fail(reasonCode, "记忆未入库：服务端既未写入也未接收提案。", {
        accepted,
        rejected,
        proposals,
        http_status: res.status,
      })
    } catch (e) {
      return fail("gateway_unreachable", (e as Error).message)
    }
  },
})
