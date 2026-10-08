import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, platformFetch } from "../lib/client"
import { gatewayReadSnapshot, gatewayDispatchOps } from "../lib/canvas-flow"

const GATEWAY = process.env.GATEWAY_URL || "http://127.0.0.1:8081"

// workflow_write — 人机共笔的「笔」：agent 读回画布产线的宣告式 DSL（canvas_get_state 的
// dsl 栏位），像改代码一样改它，整份交回本工具 → 站点确定性编译器全图校验 → 原子落图。
//
// 为什么不是直接下 ops：座标/增量/连线去重/幂等 id 全在编译器里（deterministic node id =
// wf- + 内容杂凑），agent 手拼 ops 会破坏「声明 ⇄ 图」的可逆性，也会与人拖过的座标打架。
// 本工具只做三件事：读当前图 → 交编译 → 把编译出的 ops 原样下发。
export default tool({
  description:
    "把整份工作流声明（DSL）编译成画布操作并原子落图——「像改代码一样改工作流」的写入口。用法：先 canvas_get_state 读当前 dsl（工作流的可逆声明），按需增删改 steps，整份 source 交回本工具。\n\n" +
    "**冷启动（画布没有 dsl 时）**：不必先读到 dsl 才能用本工具。两种情况都能交：①收编——按画布现有产线节点写 steps（每步对应一颗现有节点，meta 可带 _origin_node_id 指定原节点 id），交回后编译器把现有节点收编进 DSL 管理（幂等更新+键回填，不建平行节点）；②新建——按用户意图直接写整份新产线 source 交回。\n\n" +
    "source 形状：{ workflow: \"<小写字母开头 [a-z0-9_-]>\"， title?: string， steps: [ { id, title, kind?, prompt?, needs?, model?, size?, count?, gate?, tool?, meta? } ] }。\n" +
    "· id：小写字母开头 [a-z0-9_]，档内唯一；决定画布节点 id（同 id 同节点，重复交=幂等更新）。\n" +
    "· kind：image（默认）| text | video | audio | director。\n" +
    "· needs：依赖的上游 step id（画布连线由它推出）。\n" +
    "· tool：必须是 harness 工具 id（image_generate / image_edit / …），不确定就省略。\n" +
    "· gate: true = 人工批准门禁步。meta 是自由透传键值（≤4KB）。steps 1..24 个。\n\n" +
    "语义保证：①全图校验（id 重复/needs 悬空/依赖成环/tool 非法）不过则整份拒绝、画布不动，错误里带修复提示；②合法则原子落图，增节点/改节点/连线的位置由画布排布，人拖过的节点位置不会被覆盖（人工编辑优先）；③v0 不删节点：源码里移除的步骤只回 warnings。\n\n" +
    "**改画布产线上任何东西（改单步 prompt／改结构）都用本工具**——它按 step id 幂等（同 id 同节点＝更新），先读 `dsl` 再整份交回即可；只有节点不在 `dsl` 里、或要动位置/尺寸/手调连线时，才用 `canvas_apply_ops`。**禁**手拼 `add_node`+`connect_nodes` 搭流程。\n\n" +
    "**改画布产线（节点在 `dsl` 里）→ 一律 `workflow_write`**（幂等；读 `dsl`→改 `steps`→整份交回）。单步或多步、改 prompt 或改结构，都是它。**节点不在 `dsl` 里，或 DSL 表达不到的栏位（位置／尺寸／手调连线）→ 才用 `canvas_apply_ops`**（`update_node`／`connect_nodes`／`delete_connections`）。**禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。",
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
        hint: "画布尚未上报状态，请让用户打开画布后重试。**拿到状态后：改步骤内容或结构一律 `workflow_write`（读 `dsl`→改 `steps`→整份交回）；退回某步旧内容用 `workflow_history` 查 version → `workflow_rollback`。**",
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
      // 教学式报错原样透传：模型照 errors 改 source 重交（自修 ≤2 轮）。
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
