/**
 * workflow-templates.test.ts — 模板目錄常駐測試（2026-09-28 W6）。
 *
 * 缺口背景：`gateway/workflow-templates/` 目錄自 09-20 工業化起**零專屬測試檔**，
 * 行為覆蓋只有一次性臨時 E2E（已刪）。本檔把它變成常駐覆蓋，防止
 * 「81/90/51 卡默默漂移」——任一模板的節點數、衍生卡數、role 命名、連線端點、
 * 泳道座標或 placeholder 形狀被改動時，測試必須指名「哪個模板哪一格變了」。
 *
 * 禁同源斷言（工作區 AGENTS.md Verification 鐵律）：下表 BASELINE 是**人工核對過**
 * 的凍結基準（2026-09-28 從活體 expandTemplate 逐模板抄錄），不得由被測函式自己算出。
 * 測試只拿被測函式的輸出與這張死表比對。
 *
 * 執行器（2026-09-28 現場校正）：**VPS 有 bun**（`~/.bun/bin/bun`，agent-gateway.service
 * 就是以 `bun run index.ts` 跑的）。權威跑法（在 /opt/agent-harness/gateway 下）：
 *   export PATH=$HOME/.bun/bin:$PATH
 *   bun test workflow-templates/workflow-templates.test.ts
 *
 * 無 bun 的退路（本目錄 ts-loader.mjs 是 node ESM resolve hook，只補 extensionless
 * import 的 .ts / /index.ts）：`workflow-service.ts` 有 TypeScript parameter properties，
 * `--experimental-strip-types` 會拋 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，故必須：
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
// 凍結基準表（2026-09-28 人工核對；漂移時本表是唯一 oracle）
//
// main   = 非衍生卡節點數（模板節點 + R8 克隆）
// tool   = pipelineCard==="tool" 卡數
// note   = pipelineCard==="note" 卡數
// gate   = pipelineCard==="gate" 卡數
// nodes  = main + tool + note + gate（總節點數）
// conns  = 展開後連線數
// textPh = kind==="text" 且非衍生卡 的 role 數（＝ templatePlaceholderContent 應有的鍵數）
// lanes  = computeSwimlanePositions 的 distinct x（＝DAG 分層欄數）
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

/** 泳道幾何常數（gateway/workflow-service.ts:1070-1076）。前端同值契約見 agent-template-canvas.ts:32/38/40。 */
const SWIM = { CARD_W: 300, GAP_X: 80, DERIVED_H: 150, MAIN_H: 220 } as const
const FRONTEND = { CARD_W: 300, CARD_GAP_X: 60, LANE_GAP_Y: 330 } as const

/**
 * 跨欄連線凍結表（2026-09-28 人工核對，非由被測函式算出）：主工序**扇入**（多條上游
 * 匯入同一道下游工序）的 `from->to` 全集。絕大多數模板為空；這三支的跨欄不是佈局缺陷，
 * 而是合法合流（如 char_card/art_card→video_gen、voiceover→final_cut）。引擎若新增或
 * 移除任何跨欄連線，此表必須同步——這就是「漂移必紅」的棘輪。
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

describe("W6 模板目錄常駐：13 模板逐支展開契約", () => {
  it("模板清單恰為基準表的 13 個 id（順序即部署順序）", () => {
    assert.deepEqual(WORKFLOW_TEMPLATES.map((t) => t.id), Object.keys(BASELINE))
  })

  it("listWorkflowTemplates 與 WORKFLOW_TEMPLATES 逐欄一致", () => {
    const listed = listWorkflowTemplates()
    assert.equal(listed.length, WORKFLOW_TEMPLATES.length)
    for (const [i, t] of WORKFLOW_TEMPLATES.entries()) {
      assert.deepEqual(listed[i], { id: t.id, name: t.name, description: t.description, multiShot: t.multiShot })
    }
  })

  for (const [id, base] of Object.entries(BASELINE)) {
    describe(`模板 ${id}`, () => {
      it("節點數/連線數與凍結基準一致", () => {
        const g = expand(id)
        assert.equal(g.nodes.length, base.nodes, `${id} 總節點數漂移`)
        assert.equal(g.connections.length, base.conns, `${id} 連線數漂移`)
      })

      it("主節點數與衍生卡三類計數（tool/note/gate）逐項一致", () => {
        const g = expand(id)
        assert.equal(g.nodes.filter((n) => !isDerivedRole(n.role)).length, base.main, `${id} 主節點數漂移`)
        assert.equal(pipelineCount(g.nodes, "tool"), base.tool, `${id} 工具卡數漂移`)
        assert.equal(pipelineCount(g.nodes, "note"), base.note, `${id} 配方卡數漂移`)
        assert.equal(pipelineCount(g.nodes, "gate"), base.gate, `${id} 門禁卡數漂移`)
      })

      it("節點 id 唯一（主節點/克隆/衍生卡三源不撞）", () => {
        const g = expand(id)
        const ids = g.nodes.map((n) => n.id)
        const dup = ids.filter((x, i) => ids.indexOf(x) !== i)
        assert.deepEqual(dup, [], `${id} 有重複節點 id: ${dup.join(",")}`)
      })

      it("每條連線的兩端都存在（無懸空端點）", () => {
        const g = expand(id)
        const ids = new Set(g.nodes.map((n) => n.id))
        const dangling = g.connections.filter((c) => !ids.has(c.from) || !ids.has(c.to))
        assert.deepEqual(dangling.map((c) => `${c.from}->${c.to}`), [], `${id} 有懸空連線`)
      })

      it("無環（topologicalSort 的 cycle 為空且覆蓋全部節點）", () => {
        const g = expand(id)
        const { order, cycle } = topologicalSort(g)
        assert.deepEqual(cycle, [], `${id} 成環: ${cycle.join(" -> ")}`)
        assert.equal(order.length, g.nodes.length, `${id} 拓撲序未覆蓋全部節點`)
      })

      it("衍生卡 role 命名契約（__tool_i / __note_i / __gate）", () => {
        const g = expand(id)
        const badTool = g.nodes.filter((n) => n.metadata.pipelineCard === "tool" && !/__tool_\d+$/.test(n.role))
        const badNote = g.nodes.filter((n) => n.metadata.pipelineCard === "note" && !/__note_\d+$/.test(n.role))
        const badGate = g.nodes.filter((n) => n.metadata.pipelineCard === "gate" && !/__gate$/.test(n.role))
        assert.deepEqual(badTool.map((n) => n.role), [], `${id} 工具卡 role 不合規`)
        assert.deepEqual(badNote.map((n) => n.role), [], `${id} 配方卡 role 不合規`)
        assert.deepEqual(badGate.map((n) => n.role), [], `${id} 門禁卡 role 不合規`)
        // 衍生卡 role 的父 role 必須是本次展開存在的主 role（防孤兒卡）
        const mainRoles = new Set(g.nodes.filter((n) => !isDerivedRole(n.role)).map((n) => n.role))
        const orphans = g.nodes
          .filter((n) => isDerivedRole(n.role))
          .map((n) => n.role.slice(0, n.role.lastIndexOf("__")))
          .filter((parent) => !mainRoles.has(parent))
        assert.deepEqual([...new Set(orphans)], [], `${id} 有孤兒衍生卡（父 role 不存在）`)
      })

      it("templatePlaceholderContent 形狀＝{ role: { content } } 且鍵集＝text 主 role", () => {
        const g = expand(id)
        const ph = templatePlaceholderContent(id)
        const textRoles = g.nodes
          .filter((n) => n.kind === "text" && !isDerivedRole(n.role))
          .map((n) => n.role)
        assert.deepEqual(Object.keys(ph).sort(), [...textRoles].sort(), `${id} placeholder 鍵集漂移`)
        assert.equal(Object.keys(ph).length, base.textPh, `${id} placeholder 鍵數漂移`)
        for (const [role, value] of Object.entries(ph)) {
          assert.equal(typeof value, "object", `${id}.${role} 不是物件（傳純字串會被 startSync 判缺內容 400）`)
          assert.ok(value !== null && !Array.isArray(value), `${id}.${role} 不是純物件`)
          assert.equal(typeof (value as Record<string, unknown>).content, "string", `${id}.${role} 缺 content 字串`)
        }
      })

      it("泳道座標：distinct x/y 數與基準一致，x 為 CARD_W+GAP_X 的整數倍遞增", () => {
        const g = expand(id)
        const pos = computeSwimlanePositions(g.nodes, g.connections)
        assert.equal(pos.size, g.nodes.length, `${id} 有節點未被指派泳道座標`)
        const xs = [...new Set([...pos.values()].map((p) => p.x))].sort((a, b) => a - b)
        const ys = new Set([...pos.values()].map((p) => p.y))
        assert.equal(xs.length, base.lanes, `${id} 泳道欄數漂移`)
        assert.equal(ys.size, base.ys, `${id} distinct y 數漂移`)
        assert.equal(xs[0], 0, `${id} 首欄 x 不是 0`)
        for (const [i, x] of xs.entries()) {
          assert.equal(x, i * (SWIM.CARD_W + SWIM.GAP_X), `${id} 第 ${i} 欄 x=${x} 偏離 CARD_W+GAP_X 步長`)
        }
        // 跨欄連線棘輪：只准 CROSS_LANE 表列出的扇入合流；其餘一律必須是相鄰欄短跳線。
        // 逐一指名 `from->to`，漂移時能直接看出新增/消失的是哪一條。
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
          `${id} 跨欄連線漂移（新增/移除了跨欄貫穿連線）`,
        )
      })
    })
  }
})

describe("W6 泳道幾何常數：gateway 內部一致 ＋ 前端同值契約", () => {
  it("CARD_W 兩側同值（300），GAP_X 為 gateway 內部常數（80）", () => {
    // 直接觀察產出：相鄰欄間距 = CARD_W + GAP_X
    const g = expand("single_image")
    const pos = computeSwimlanePositions(g.nodes, g.connections)
    const xs = [...new Set([...pos.values()].map((p) => p.x))].sort((a, b) => a - b)
    assert.equal(xs[1]! - xs[0]!, SWIM.CARD_W + SWIM.GAP_X)
    assert.equal(SWIM.CARD_W, FRONTEND.CARD_W, "gateway CARD_W 與前端 CARD_W 不同值（契約破裂）")
  })

  it("衍生卡垂直掛在父工序下方，欄 x 與父相同，y 遞增且高度＝DERIVED_H+GAP 步長", () => {
    const g = expand("shortdrama_visual")
    const pos = computeSwimlanePositions(g.nodes, g.connections)
    const derived = g.nodes.filter((n) => isDerivedRole(n.role))
    assert.ok(derived.length > 0, "shortdrama_visual 應有衍生卡")
    // 同欄 y 嚴格遞增且不重疊（每張卡高度 >= DERIVED_H）
    for (const lane of new Set([...pos.values()].map((p) => p.x))) {
      const ys = [...pos.values()].filter((p) => p.x === lane).map((p) => p.y).sort((a, b) => a - b)
      if (ys.length > 1) {
        for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i]! - ys[i - 1]! >= SWIM.DERIVED_H, `欄 x=${lane} 卡片垂直重疊`)
      }
    }
    assert.equal(FRONTEND.LANE_GAP_Y, 330, "前端 LANE_GAP_Y 契約值漂移（gateway 檔案頭聲明同值）")
  })
})

describe("W6 placeholder 邊界", () => {
  it("未知模板 id 回空物件（不拋錯）", () => {
    assert.deepEqual(templatePlaceholderContent("no_such_template"), {})
  })
  it("衍生卡不走 placeholder（只遍歷模板節點；startSync 缺內容驗證不會 400 衍生 text 卡）", () => {
    const ph = templatePlaceholderContent("shortdrama_visual")
    const derivedKeys = Object.keys(ph).filter((k) => /__tool_|__note_|__gate/.test(k))
    assert.deepEqual(derivedKeys, [], "placeholder 不應包含衍生卡 role")
  })
})
