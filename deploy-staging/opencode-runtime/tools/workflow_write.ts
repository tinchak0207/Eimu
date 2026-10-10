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
    "**冷启动／收编（`dsl` 与画布现状的关系）**：①`dsl` 非空 ⇒ 骨架**已自动收编**存量画布上的产线节点（含未带产线身份键的提示词节点与生成配置节点），**直接改 `steps` 整份交回即可，每步的 `meta._origin_node_id` 原样带回、不要自己发明**；②`dsl` 为空 ⇒ 两种原因（画布上确实没有任何产线节点；或画布太大、骨架超出快照预算，摘要带 `dsl_omitted: \"budget\"`，**不代表没有产线**），此时按画布现状写 steps 收编（**每步对应一颗现有节点，`meta._origin_node_id` 指原节点 id**；交回后编译器把现有节点收编进 DSL 管理，幂等更新+键回填，不建平行节点）或按用户意图整份新建产线 source。\n\n" +
    "source 形状：{ workflow: \"<小写字母开头 [a-z0-9_-]>\"， title?: string， steps: [ { id, title, kind?, prompt?, needs?, model?, size?, count?, gate?, tool?, meta? } ] }。\n" +
    "· id：小写字母开头 [a-z0-9_]，档内唯一；决定画布节点 id（同 id 同节点，重复交=幂等更新）。\n" +
    "· kind：image（默认）| text | video | audio | director。\n" +
    "· needs：依赖的上游 step id（画布连线由它推出）。\n" +
    "· tool：必须是 harness 工具 id（image_generate / image_edit / …），不确定就省略。\n" +
    "· gate: true = 人工批准门禁步。meta 是自由透传键值（≤4KB）。steps 1..256 个。**合法性透传：节点上不合 DSL 格式的值（例：`size` 不是 `宽x高`）读面会原样放进该步的 `meta`（同键，如 `meta.size`），不会丢；要改它就改 `meta` 里的同名键。**\n\n" +
    "语义保证：①全图校验（id 重复/needs 悬空/依赖成环/tool 非法）不过则整份拒绝、画布不动，错误里带修复提示；②合法则原子落图，增节点/改节点/连线的位置由画布排布，人拖过的节点位置不会被覆盖（人工编辑优先）；③从 source 里移除步骤不会删画布节点（v0 只回 `warnings`）；**族4 节点在首次收编前**被移除时不会回 warning，下一步读面仍会看到它——要真移除节点用 `canvas_apply_ops`。\n\n" +
    "**改画布产线（节点在 `dsl` 里）→ 一律 `workflow_write`**（幂等；读 `dsl`→改 `steps`→整份交回）。单步或多步、改 prompt 或改结构，都是它。**`dsl` 已自动覆盖存量画布上的产线节点（含未带产线身份键的提示词节点与生成配置节点），每步的 `meta._origin_node_id` 由读面自动填好——原样带回即可，不要自己发明。**改提示词要改「生成步」（kind=image/video 的那一步）的 `prompt`**——生成面板与重跑读的是生成节点自身的 `metadata.prompt`；若上游另有「提示词节点步」持有同一段提示词（画布把提示词存了两份），把两处改成同一段：只改提示词步不会改变生成输入。节点不在 `dsl` 里，或要动 DSL 表达不到的栏位（位置／尺寸／手调连线）→ 才用 `canvas_apply_ops`（`update_node`／`connect_nodes`／`delete_connections`）。**铺新产线＝有意动作**：交回会新建节点的 source 时，若 `source.workflow` 不在当前画布 `dsl` 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），工具先回 `confirm_new_line` 要你确认——确认前画布不动。确为有意（用户要铺这条线／你在规划另一张画布）就带 `confirm_new_line: true` 重交同一份 source；若它只是记忆或别的画布的 source 就不要交回。**回执里的新建/更新颗数（`created_node_ids`）必须如实转述，不得声称「无新建」。** **禁手拼 `add_node`＋`connect_nodes` 搭整条产线结构**（绕过编译器、破坏可逆性）。**",
  args: {
    source: tool.schema
      .object({
        workflow: tool.schema.string().describe("工作流命名空间，小写字母开头，[a-z0-9_-]{1,48}"),
        title: tool.schema.string().optional().describe("可读标题（≤60 字）"),
        steps: tool.schema
          .array(tool.schema.object({ id: tool.schema.string() }).passthrough())
          .min(1)
          .describe("步骤数组（1..256）"),
      })
      .passthrough()
      .describe("整份工作流声明（从 canvas_get_state / workflow_history 的 `dsl` 读出、修改 `steps` 后整份交回；`dsl` 已自动覆盖存量画布上的产线节点，每步 `meta._origin_node_id` 原样带回）"),
    label: tool.schema.string().optional().describe("给用户看的一句话操作意图，如「把分镜从 3 步扩到 5 步」"),
    dry_run: tool.schema.boolean().optional().describe("true = 只编译不落图，先看 ops 与 summary（用于确认改动面）"),
    confirm_new_line: tool.schema
      .boolean()
      .optional()
      .describe("确认这是有意在当前画布铺一条新产线。交回会新建节点的 source 时，若 source.workflow 不在当前画布 dsl 的 ns 里（画布快照没有产线信息、或它来自别的画布／会话记忆，都算不在），不传本参数工具会先回 confirm_new_line 拒绝落图（画布不动）；只有确认这是有意动作（用户要求铺这条线／你在规划另一张画布或另一条线）才传 true 重交同一份 source。"),
  },
  async execute(args, context) {
    const snap = await gatewayReadSnapshot(GATEWAY, context.sessionID)
    // F1：无画布上报视为空画布，照样编译落盘（网关写穿 canvasStates／queued），禁止甩锅「请打开画布」。
    const s = (snap.has_state && snap.state ? snap.state : {}) as Record<string, unknown>
    const current = {
      nodes: Array.isArray(s.nodes) ? s.nodes : [],
      connections: Array.isArray(s.connections) ? s.connections : [],
    }

    // 新产线明示确认闸（2026-10-10，收紧判据）：交回的 source.workflow 不在当前画布 dsl 的 ns
    // 集合里（currentNs 为空＝快照没有产线信息，画布未挂载或确为空画布，一律视为不在），且编译会
    // 新建节点（added>0）时，必须由调用方显式确认（confirm_new_line:true）才落图——否则「快照没带
    // dsl」这条不可靠路径会放行「会话记忆／别的画布」的 DSL、静默建出平行节点。
    // 不误伤：同 ns 收编/改步（currentNs.has(ns)）、幂等重放／纯改内容（added===0），两者照旧直落。
    const currentNs = new Set<string>()
    if (Array.isArray(s.dsl)) {
      for (const src of s.dsl as unknown[]) {
        const ns = (src as Record<string, unknown> | null)?.workflow
        if (typeof ns === "string" && ns) currentNs.add(ns)
      }
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
    // summary 形状防御：非有限数一律当 0（编译器正常回 {added, updated, connected, warnings}）。
    const summaryShape = (summary ?? {}) as Record<string, unknown>
    const added = typeof summaryShape.added === "number" && Number.isFinite(summaryShape.added) ? summaryShape.added : 0
    const updated = typeof summaryShape.updated === "number" && Number.isFinite(summaryShape.updated) ? summaryShape.updated : 0
    const sourceWorkflow = typeof args.source.workflow === "string" ? args.source.workflow : ""
    // 新产线判定：会新建节点，且交回的 ns 不在已知产线集合里（sourceWorkflow 为空字串也算不在）。
    const newProductionLine = added > 0 && !currentNs.has(sourceWorkflow)
    const reportNote = `本次新建 ${added} 颗 / 更新 ${updated} 颗节点；如实向用户转述，不得声称「无新建」。`
    if (args.dry_run === true) {
      // dry_run 不落图，故只带判定结果、不要求确认。
      return ok({ dry_run: true, new_production_line: newProductionLine, summary, ops })
    }
    if (newProductionLine && args.confirm_new_line !== true) {
      // 命中「新产线」且未明示确认：不落图，回确认项（含两种成因、预算提示、两条出路与 steps 预览）。
      const stepsRaw = Array.isArray(args.source.steps) ? (args.source.steps as unknown[]) : []
      const stepsPreview = stepsRaw.slice(0, 10).map((st) => {
        const o = (st ?? {}) as Record<string, unknown>
        return {
          id: typeof o.id === "string" ? o.id : null,
          title: typeof o.title === "string" ? o.title : null,
        }
      })
      const cause =
        currentNs.size === 0
          ? "当前画布快照里没有产线信息（画布可能未挂载／刚新建）"
          : `source.workflow=${sourceWorkflow || "?"} 不在当前画布 dsl 的 ns 里（画布上还没有这条产线）`
      const budgetNote =
        s.dsl_omitted === "budget"
          ? " 注意：本会话摘要因体积省掉了 dsl 骨架（`dsl_omitted: budget`），不能据此认为画布上没有产线——确认前请先用 `canvas_get_state` 核对。"
          : ""
      return fail(
        "confirm_new_line",
        `这次交回的 source 会在当前画布新建 ${added} 颗节点，且 ${cause}——本条画布未改动。${budgetNote}`,
        {
          new_production_line: true,
          would_create: added,
          updated,
          workflow: sourceWorkflow || null,
          steps: stepsPreview,
          steps_total: stepsRaw.length,
          hint: "①这是有意铺的新产线（用户要求，或你在规划另一张画布／另一条线）→ 带 `confirm_new_line: true` 重新调用同一份 source；②这 source 来自会话记忆或别的画布、而你不是有意要铺它 → 不要交回（交回会在当前画布建出平行节点）。确认前画布不动。",
        },
      )
    }
    if (ops.length === 0) {
      return ok({
        applied: 0,
        new_production_line: newProductionLine,
        added,
        updated,
        summary,
        note: "声明与当前画布一致，无需改动（幂等重放）",
        report_note: reportNote,
      })
    }

    const outcome = await gatewayDispatchOps(GATEWAY, context.sessionID, ops, args.label)
    if (outcome.ok !== true && outcome.code !== "OPS_TIMEOUT") {
      return fail("canvas_ops_failed", outcome.error || (outcome.status ? `HTTP ${outcome.status}` : "下发失败"))
    }
    const result = outcome.result ?? {}
    // F1：网关逾时／无客户端时仍写穿快照并回 queued；视为成功，勿叫用户「打开画布」。
    const queued = result.queued === true || outcome.code === "OPS_TIMEOUT"
    if (result.ok !== true && !queued) {
      return fail("ops_rejected", result.error || "前端执行画布操作失败（可能被用户拒绝）", {
        request_id: outcome.request_id,
      })
    }
    return ok({
      request_id: outcome.request_id,
      applied: ops.length,
      created_node_ids: result.created_node_ids ?? [],
      new_production_line: newProductionLine,
      added,
      updated,
      summary,
      report_note: reportNote,
      ...(queued
        ? {
            queued: true,
            note: "画布页未即时回执，节点／连线已写入可 hydrate 快照队列；用户稍后打开画布即可看到。请向用户说明「已落盘，打开画布可见」，不要只回复「请打开画布」。",
          }
        : {}),
    })
  },
})
