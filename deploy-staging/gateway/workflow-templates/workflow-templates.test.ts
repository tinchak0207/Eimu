/**
 * workflow-templates.test.ts — 模板目录常驻测试（2026-09-28 W6）。
 *
 * 缺口背景：`gateway/workflow-templates/` 目录自 09-20 工业化起**零专属测试档**，
 * 行为覆盖只有一次性临时 E2E（已删）。本档把它变成常驻覆盖，防止
 * 「81/90/51 卡默默漂移」——任一模板的节点数、衍生卡数、role 命名、连线端点、
 * 泳道座标或 placeholder 形状被改动时，测试必须指名「哪个模板哪一格变了」。
 *
 * 禁同源断言（工作区 AGENTS.md Verification 铁律）：下表 BASELINE 是**人工核对过**
 * 的冻结基准（2026-09-28 从活体 expandTemplate 逐模板抄录），不得由被测函式自己算出。
 * 测试只拿被测函式的输出与这张死表比对。
 *
 * 执行器（2026-09-28 现场校正）：**VPS 有 bun**（`~/.bun/bin/bun`，agent-gateway.service
 * 就是以 `bun run index.ts` 跑的）。权威跑法（在 /opt/eimu-harness/gateway 下）：
 *   export PATH=$HOME/.bun/bin:$PATH
 *   bun test workflow-templates/workflow-templates.test.ts
 *
 * 无 bun 的退路（本目录 ts-loader.mjs 是 node ESM resolve hook，只补 extensionless
 * import 的 .ts / /index.ts）：`workflow-service.ts` 有 TypeScript parameter properties，
 * `--experimental-strip-types` 会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，故必须：
 *   node --experimental-transform-types \
 *     --experimental-loader ./workflow-templates/ts-loader.mjs \
 *     --test workflow-templates/workflow-templates.test.ts
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { WORKFLOW_TEMPLATES, getWorkflowTemplate, listWorkflowTemplates, templatePlaceholderContent } from "./index.ts"
import { expandTemplate, topologicalSort } from "../workflow-engine.ts"
import { computeSwimlanePositions } from "../workflow-service.ts"

// ────────────────────────────────────────────────────────────────────────────
// 冻结基准表（2026-09-28 人工核对；漂移时本表是唯一 oracle）
//
// main   = 非衍生卡节点数（模板节点 + R8 克隆）
// tool   = pipelineCard==="tool" 卡数
// note   = pipelineCard==="note" 卡数
// gate   = pipelineCard==="gate" 卡数
// nodes  = main + tool + note + gate（总节点数）
// conns  = 展开后连线数
// textPh = kind==="text" 且非衍生卡 的 role 数（＝ templatePlaceholderContent 应有的键数）
// lanes  = computeSwimlanePositions 的 distinct x（＝DAG 分层栏数）
// ys     = computeSwimlanePositions 的 distinct y
// ────────────────────────────────────────────────────────────────────────────
type Baseline = {
  nodes: number; conns: number; main: number; tool: number; note: number; gate: number
  textPh: number; lanes: number; ys: number
}

const BASELINE: Record<string, Baseline> = {
  single_image:      { nodes:  7, conns:  6, main:  3, tool:  2, note:  2, gate: 0, textPh: 1, lanes:  3, ys:  3 },
  character_sheet:   { nodes: 12, conns: 11, main:  6, tool:  2, note:  3, gate: 1, textPh: 1, lanes:  3, ys:  8 },
  scene_setup:       { nodes:  8, conns:  7, main:  3, tool:  2, note:  3, gate: 0, textPh: 1, lanes:  3, ys:  4 },
  single_video:      { nodes: 10, conns:  9, main:  4, tool:  2, note:  3, gate: 1, textPh: 1, lanes:  3, ys:  6 },
  feature_film:      { nodes: 53, conns: 52, main: 14, tool: 14, note: 19, gate: 6, textPh: 4, lanes:  6, ys: 29 },
  novel_film:        { nodes: 92, conns: 94, main: 16, tool: 31, note: 37, gate: 8, textPh: 6, lanes:  9, ys: 50 },
  novel_ip:          { nodes: 81, conns: 80, main: 15, tool: 24, note: 34, gate: 8, textPh: 1, lanes: 15, ys: 10 },
  ecom_launch:       { nodes: 85, conns: 84, main: 15, tool: 23, note: 39, gate: 8, textPh: 1, lanes: 15, ys: 10 },
  ecom_model:        { nodes: 79, conns: 78, main: 14, tool: 21, note: 37, gate: 7, textPh: 0, lanes: 14, ys: 11 },
  shortdrama_visual: { nodes: 82, conns: 83, main: 14, tool: 28, note: 36, gate: 4, textPh: 3, lanes: 13, ys: 19 },
  shortdrama_poster: { nodes: 81, conns: 80, main: 12, tool: 20, note: 42, gate: 7, textPh: 2, lanes: 12, ys: 12 },
  art_curation:      { nodes: 86, conns: 85, main: 14, tool: 23, note: 41, gate: 8, textPh: 2, lanes: 14, ys: 11 },
  art_style:         { nodes: 82, conns: 81, main: 15, tool: 18, note: 41, gate: 8, textPh: 1, lanes: 15, ys: 10 },
}

/** 泳道几何常数（gateway/workflow-service.ts:1070-1076）。前端同值契约见 agent-template-canvas.ts:32/38/40。 */
const SWIM = { CARD_W: 300, GAP_X: 80, DERIVED_H: 150, MAIN_H: 220 } as const
const FRONTEND = { CARD_W: 300, CARD_GAP_X: 60, LANE_GAP_Y: 330 } as const

/**
 * 跨栏连线冻结表（2026-09-28 人工核对，非由被测函式算出）：主工序**扇入**（多条上游
 * 汇入同一道下游工序）的 `from->to` 全集。绝大多数模板为空；这三支的跨栏不是布局缺陷，
 * 而是合法合流（如 char_card/art_card→video_gen、voiceover→final_cut）。引擎若新增或
 * 移除任何跨栏连线，此表必须同步——这就是「漂移必红」的棘轮。
 */
const CROSS_LANE: Record<string, readonly string[]> = {
  feature_film:      ["shot1->shot1_gen"],
  novel_film:        ["char_card->video_gen", "art_card->video_gen", "voiceover->final_cut"],
  shortdrama_visual: ["cast_card->video_gen", "voiceover->final_cut"],
}

const isDerivedRole = (role: string) => /__tool_\d+$/.test(role) || /__note_\d+$/.test(role) || /__gate$/.test(role)
const expand = (id: string) => expandTemplate(id, getWorkflowTemplate(id)!, {})
const pipelineCount = (nodes: { metadata: Record<string, unknown> }[], kind: string) =>
  nodes.filter((n) => n.metadata.pipelineCard === kind).length

describe("W6 模板目录常驻：13 模板逐支展开契约", () => {
  it("模板清单恰为基准表的 13 个 id（顺序即部署顺序）", () => {
    assert.deepEqual(WORKFLOW_TEMPLATES.map((t) => t.id), Object.keys(BASELINE))
  })

  it("listWorkflowTemplates 与 WORKFLOW_TEMPLATES 逐栏一致", () => {
    const listed = listWorkflowTemplates()
    assert.equal(listed.length, WORKFLOW_TEMPLATES.length)
    for (const [i, t] of WORKFLOW_TEMPLATES.entries()) {
      assert.deepEqual(listed[i], { id: t.id, name: t.name, description: t.description, multiShot: t.multiShot })
    }
  })

  for (const [id, base] of Object.entries(BASELINE)) {
    describe(`模板 ${id}`, () => {
      it("节点数/连线数与冻结基准一致", () => {
        const g = expand(id)
        assert.equal(g.nodes.length, base.nodes, `${id} 总节点数漂移`)
        assert.equal(g.connections.length, base.conns, `${id} 连线数漂移`)
      })

      it("主节点数与衍生卡三类计数（tool/note/gate）逐项一致", () => {
        const g = expand(id)
        assert.equal(g.nodes.filter((n) => !isDerivedRole(n.role)).length, base.main, `${id} 主节点数漂移`)
        assert.equal(pipelineCount(g.nodes, "tool"), base.tool, `${id} 工具卡数漂移`)
        assert.equal(pipelineCount(g.nodes, "note"), base.note, `${id} 配方卡数漂移`)
        assert.equal(pipelineCount(g.nodes, "gate"), base.gate, `${id} 门禁卡数漂移`)
      })

      it("节点 id 唯一（主节点/克隆/衍生卡三源不撞）", () => {
        const g = expand(id)
        const ids = g.nodes.map((n) => n.id)
        const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
        assert.deepEqual(dup, [], `${id} 有重复节点 id: ${dup.join(",")}`)
      })

      it("每条连线的两端都存在（无悬空端点）", () => {
        const g = expand(id)
        const ids = new Set(g.nodes.map((n) => n.id))
        const dangling = g.connections.filter((c) => !ids.has(c.from) || !ids.has(c.to))
        assert.deepEqual(dangling.map((c) => `${c.from}->${c.to}`), [], `${id} 有悬空连线`)
      })

      it("无环（topologicalSort 的 cycle 为空且覆盖全部节点）", () => {
        const g = expand(id)
        const { order, cycle } = topologicalSort(g)
        assert.deepEqual(cycle, [], `${id} 成环: ${cycle.join(" -> ")}`)
        assert.equal(order.length, g.nodes.length, `${id} 拓扑序未覆盖全部节点`)
      })

      it("衍生卡 role 命名契约（__tool_i / __note_i / __gate）", () => {
        const g = expand(id)
        const badTool = g.nodes.filter((n) => n.metadata.pipelineCard === "tool" && !/__tool_\d+$/.test(n.role))
        const badNote = g.nodes.filter((n) => n.metadata.pipelineCard === "note" && !/__note_\d+$/.test(n.role))
        const badGate = g.nodes.filter((n) => n.metadata.pipelineCard === "gate" && !/__gate$/.test(n.role))
        assert.deepEqual(badTool.map((n) => n.role), [], `${id} 工具卡 role 不合规`)
        assert.deepEqual(badNote.map((n) => n.role), [], `${id} 配方卡 role 不合规`)
        assert.deepEqual(badGate.map((n) => n.role), [], `${id} 门禁卡 role 不合规`)
        // 衍生卡 role 的父 role 必须是本次展开存在的主 role（防孤儿卡）
        const mainRoles = new Set(g.nodes.filter((n) => !isDerivedRole(n.role)).map((n) => n.role))
        const orphans = g.nodes
          .filter((n) => isDerivedRole(n.role))
          .map((n) => n.role.slice(0, n.role.lastIndexOf("__")))
          .filter((parent) => !mainRoles.has(parent))
        assert.deepEqual([...new Set(orphans)], [], `${id} 有孤儿衍生卡（父 role 不存在）`)
      })

      it("templatePlaceholderContent 形状＝{ role: { content } } 且键集＝text 主 role", () => {
        const g = expand(id)
        const ph = templatePlaceholderContent(id)
        const textRoles = g.nodes
          .filter((n) => n.kind === "text" && !isDerivedRole(n.role))
          .map((n) => n.role)
        assert.deepEqual(Object.keys(ph).sort(), [...textRoles].sort(), `${id} placeholder 键集漂移`)
        assert.equal(Object.keys(ph).length, base.textPh, `${id} placeholder 键数漂移`)
        for (const [role, value] of Object.entries(ph)) {
          assert.equal(typeof value, "object", `${id}.${role} 不是物件（传纯字串会被 startSync 判缺内容 400）`)
          assert.ok(value !== null && !Array.isArray(value), `${id}.${role} 不是纯物件`)
          assert.equal(typeof (value as Record<string, unknown>).content, "string", `${id}.${role} 缺 content 字串`)
        }
      })

      it("泳道座标：distinct x/y 数与基准一致，x 为 CARD_W+GAP_X 的整数倍递增", () => {
        const g = expand(id)
        const pos = computeSwimlanePositions(g.nodes, g.connections)
        assert.equal(pos.size, g.nodes.length, `${id} 有节点未被指派泳道座标`)
        const xs = [...new Set([...pos.values()].map((p) => p.x))].sort((a, b) => a - b)
        const ys = new Set([...pos.values()].map((p) => p.y))
        assert.equal(xs.length, base.lanes, `${id} 泳道栏数漂移`)
        assert.equal(ys.size, base.ys, `${id} distinct y 数漂移`)
        assert.equal(xs[0], 0, `${id} 首栏 x 不是 0`)
        for (const [i, x] of xs.entries()) {
          assert.equal(x, i * (SWIM.CARD_W + SWIM.GAP_X), `${id} 第 ${i} 栏 x=${x} 偏离 CARD_W+GAP_X 步长`)
        }
        // 跨栏连线棘轮：只准 CROSS_LANE 表列出的扇入合流；其余一律必须是相邻栏短跳线。
        // 逐一指名 `from->to`，漂移时能直接看出新增/消失的是哪一条。
        const depthOf = new Map(xs.map((x, i) => [x, i]))
        const roleById = new Map(g.nodes.map((n) => [n.id, n.role]))
        const spanning = g.connections
          .filter((c) => pos.has(c.from) && pos.has(c.to))
          .filter((c) => Math.abs(depthOf.get(pos.get(c.to)!.x)! - depthOf.get(pos.get(c.from)!.x)!) > 1)
          .map((c) => `${roleById.get(c.from)}->${roleById.get(c.to)}`)
          .sort()
        assert.deepEqual(
          spanning,
          [...(CROSS_LANE[id] ?? [])].sort(),
          `${id} 跨栏连线漂移（新增/移除了跨栏贯穿连线）`,
        )
      })
    })
  }
})

describe("W6 泳道几何常数：gateway 内部一致 ＋ 前端同值契约", () => {
  it("CARD_W 两侧同值（300），GAP_X 为 gateway 内部常数（80）", () => {
    // 直接观察产出：相邻栏间距 = CARD_W + GAP_X
    const g = expand("single_image")
    const pos = computeSwimlanePositions(g.nodes, g.connections)
    const xs = [...new Set([...pos.values()].map((p) => p.x))].sort((a, b) => a - b)
    assert.equal(xs[1]! - xs[0]!, SWIM.CARD_W + SWIM.GAP_X)
    assert.equal(SWIM.CARD_W, FRONTEND.CARD_W, "gateway CARD_W 与前端 CARD_W 不同值（契约破裂）")
  })

  it("衍生卡垂直挂在父工序下方，栏 x 与父相同，y 递增且高度＝DERIVED_H+GAP 步长", () => {
    const g = expand("shortdrama_visual")
    const pos = computeSwimlanePositions(g.nodes, g.connections)
    const derived = g.nodes.filter((n) => isDerivedRole(n.role))
    assert.ok(derived.length > 0, "shortdrama_visual 应有衍生卡")
    // 同栏 y 严格递增且不重叠（每张卡高度 >= DERIVED_H）
    for (const lane of new Set([...pos.values()].map((p) => p.x))) {
      const ys = [...pos.values()].filter((p) => p.x === lane).map((p) => p.y).sort((a, b) => a - b)
      if (ys.length > 1) {
        for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i]! - ys[i - 1]! >= SWIM.DERIVED_H, `栏 x=${lane} 卡片垂直重叠`)
      }
    }
    assert.equal(FRONTEND.LANE_GAP_Y, 330, "前端 LANE_GAP_Y 契约值漂移（gateway 档案头声明同值）")
  })
})

describe("W6 placeholder 边界", () => {
  it("未知模板 id 回空物件（不抛错）", () => {
    assert.deepEqual(templatePlaceholderContent("no_such_template"), {})
  })
  it("衍生卡不走 placeholder（只遍历模板节点；startSync 缺内容验证不会 400 衍生 text 卡）", () => {
    const ph = templatePlaceholderContent("shortdrama_visual")
    const derivedKeys = Object.keys(ph).filter((k) => /__tool_|__note_|__gate/.test(k))
    assert.deepEqual(derivedKeys, [], "placeholder 不应包含衍生卡 role")
  })
})
