import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, platformFetch } from "../lib/client"
import { gatewayReadSnapshot, gatewayDispatchOps } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// workflow_write — 人機共筆的「筆」：agent 讀回畫布產線的宣告式 DSL（canvas_get_state 的
// dsl 欄位），像改代碼一樣改它，整份交回本工具 → 站點確定性編譯器全圖校驗 → 原子落圖。
//
// 為什麼不是直接下 ops：座標/增量/連線去重/冪等 id 全在編譯器裡（deterministic node id =
// wf- + 內容雜湊），agent 手拼 ops 會破壞「聲明 ⇄ 圖」的可逆性，也會與人拖過的座標打架。
// 本工具只做三件事：讀當前圖 → 交編譯 → 把編譯出的 ops 原樣下發。
export default tool({
  description:
    "把整份工作流声明（DSL）编译成画布操作并原子落图——「像改代码一样改工作流」的写入口。用法：先 canvas_get_state 读当前 dsl（工作流的可逆声明），按需增删改 steps，整份 source 交回本工具。\n\n" +
    "source 形状：{ workflow: \"<小写字母开头 [a-z0-9_-]>\"， title?: string， steps: [ { id, title, kind?, prompt?, needs?, model?, size?, count?, gate?, tool?, meta? } ] }。\n" +
    "· id：小写字母开头 [a-z0-9_]，档内唯一；决定画布节点 id（同 id 同节点，重复交=幂等更新）。\n" +
    "· kind：image（默认）| text | video | audio | director。\n" +
    "· needs：依赖的上游 step id（画布连线由它推出）。\n" +
    "· tool：必须是 harness 工具 id（image_generate / image_edit / …），不确定就省略。\n" +
    "· gate: true = 人工批准门禁步。meta 是自由透传键值（≤4KB）。steps 1..24 个。\n\n" +
    "语义保证：①全图校验（id 重复/needs 悬空/依赖成环/tool 非法）不过则整份拒绝、画布不动，错误里带修复提示；②合法则原子落图，增节点/改节点/连线的位置由画布排布，人拖过的节点位置不会被覆盖（人工编辑优先）；③v0 不删节点：源码里移除的步骤只回 warnings。\n\n" +
    "改产线一律用本工具，不要用 canvas_apply_ops 手拼 add_node/connect_nodes 来搭流程。",
  args: {
    source: tool.schema
      .object({
        workflow: tool.schema.string().describe("工作流命名空间，小写字母开头，[a-z0-9_-]{1,48}"),
        title: tool.schema.string().optional().describe("可读标题（≤60 字）"),
        steps: tool.schema
          .array(tool.schema.object({ id: tool.schema.string() }).passthrough())
          .min(1)
          .describe("步骤数组（1..24）"),
      })
      .passthrough()
      .describe("整份工作流声明（从 canvas_get_state 的 dsl 读出后修改再交回）"),
    label: tool.schema.string().optional().describe("给用户看的一句话操作意图，如「把分镜从 3 步扩到 5 步」"),
    dry_run: tool.schema.boolean().optional().describe("true = 只编译不落图，先看 ops 与 summary（用于确认改动面）"),
  },
  async execute(args, context) {
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    if (!snap.has_state || snap.state === null) {
      return fail("no_canvas_state", "画布尚未上报状态，请让用户打开画布后再改工作流", {
        hint: "画布尚未上报状态，请让用户打开画布",
      })
    }
    const s = (snap.state ?? {}) as Record<string, unknown>
    const current = {
      nodes: Array.isArray(s.nodes) ? s.nodes : [],
      connections: Array.isArray(s.connections) ? s.connections : [],
    }

    let res: Response
    try {
      res = await platformFetch(
        "/workflow/compile",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: args.source, current, ...(args.label ? { label: args.label } : {}) }),
        },
        context.sessionID,
        AbortSignal.timeout(30_000),
      )
    } catch (e) {
      return fail("workflow_compile_unreachable", (e as Error)?.message || String(e))
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 422 || (data.success === false && data.code === "workflow_dsl_invalid")) {
      // 教學式報錯原樣透傳：模型照 errors 改 source 重交（自修 ≤2 轮）。
      return fail("workflow_dsl_invalid", "声明未通过全图校验，按 errors 修正后重交（画布未改动）", {
        errors: data.errors ?? [],
      })
    }
    if (!res.ok || data.success !== true) {
      return fail("workflow_compile_failed", (typeof data.error === "string" && data.error) || `HTTP ${res.status}`)
    }

    const ops = Array.isArray(data.ops) ? data.ops : []
    const summary = data.summary ?? null
    if (args.dry_run === true) {
      return ok({ dry_run: true, summary, ops })
    }
    if (ops.length === 0) {
      return ok({ applied: 0, summary, note: "声明与当前画布一致，无需改动（幂等重放）" })
    }

    const outcome = await gatewayDispatchOps(GATEWAY, context.sessionID, ops, args.label)
    if (outcome.code === "OPS_TIMEOUT") {
      return fail("ops_timeout", "前端 30 秒内未回执（画布页可能未打开或已断线）。请让用户打开画布工作台后重试。", {
        request_id: outcome.request_id,
      })
    }
    if (outcome.ok !== true) {
      return fail("canvas_ops_failed", outcome.error || (outcome.status ? `HTTP ${outcome.status}` : "下发失败"))
    }
    const result = outcome.result ?? {}
    if (result.ok !== true) {
      return fail("ops_rejected", result.error || "前端执行画布操作失败（可能被用户拒绝）", {
        request_id: outcome.request_id,
      })
    }
    return ok({
      request_id: outcome.request_id,
      applied: ops.length,
      created_node_ids: result.created_node_ids ?? [],
      summary,
    })
  },
})
