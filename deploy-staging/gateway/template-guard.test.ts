// 模板守衛 v2（接線契約）真值表測試（2026-10-02）。
// 直接呼叫守衛函式、餵真 ops 陣列（非源碼字串斷言）。
import { describe, expect, test } from "bun:test"
import {
  storeCanvasState,
  checkTemplateGuard,
  buildTemplateSlotsFact,
  renderTemplateTopology,
  hasTemplateNodes,
  claimTemplateSlot,
  canvasResultNodeId,
  templateLandingFact,
  markUserAnsweredQuestion,
  getTemplateDeviateToken,
} from "./canvas-cascade-state.ts"

const dev = (over: Partial<{ declared: boolean; reason: string; token: string }> = {}) => ({
  declared: false,
  reason: "",
  ...over,
})

// 基本模板：一個 open 生成卡（image，title/role＝「成图」）+ 一個既有 text 上游。
const tplState = (genContent = "", genType = "image", genTitle = "成图", genRole?: string) => ({
  nodes: [
    { id: "tpl-x-prompt", type: "text", title: "画面描述", metadata: { content: "cat" } },
    {
      id: "tpl-x-gen",
      type: genType,
      title: genTitle,
      metadata: genContent ? { content: genContent } : genRole ? { role: genRole } : {},
    },
  ],
  connections: [{ id: "c0", fromNodeId: "tpl-x-prompt", toNodeId: "tpl-x-gen" }],
})

const wireFromTpl = (newId: string) => ({
  type: "connect_nodes",
  connections: [{ fromNodeId: "tpl-x-prompt", toNodeId: newId }],
})

describe("模板守衛·紅/綠真值表（接線契約 I1/I2）", () => {
  test("GREEN 1：加一步（config 型）＋同批接線 → 放行（v1 病灶：曾被 409）", () => {
    const S = "tpl-truth-step"
    storeCanvasState(S, tplState())
    const ops = [
      { type: "add_node", node: { id: "n-step", type: "config", metadata: { role: "额外步骤：配音" } } },
      wireFromTpl("n-step"),
    ]
    expect(checkTemplateGuard(S, ops, dev())).toBeNull()
  })

  test("GREEN 2：加角色（character_card，role 不同於空位）＋接線 → 放行", () => {
    const S = "tpl-truth-extra-role"
    storeCanvasState(S, tplState("", "character_card", "主角卡", "主角卡"))
    const ops = [
      { type: "add_node", node: { id: "n-char", type: "character_card", metadata: { role: "额外角色：反派" } } },
      wireFromTpl("n-char"),
    ]
    expect(checkTemplateGuard(S, ops, dev())).toBeNull()
  })

  test("GREEN 3：update_node 填模板節點 → 放行", () => {
    const S = "tpl-truth-update"
    storeCanvasState(S, tplState())
    expect(checkTemplateGuard(S, [{ type: "update_node", id: "tpl-x-gen", patch: {} }], dev())).toBeNull()
  })

  test("GREEN 4：模板已全部落位（無空位）→ 不做守衛，放行", () => {
    const S = "tpl-truth-filled"
    storeCanvasState(S, tplState("https://x/y.webp"))
    expect(checkTemplateGuard(S, [{ type: "add_node", node: { id: "n1", type: "config" } }], dev())).toBeNull()
  })

  test("RED 1：加一步但不接線（漂浮）→ 409 且給接線修法", () => {
    const S = "tpl-truth-unwired"
    storeCanvasState(S, tplState())
    const msg = checkTemplateGuard(S, [{ type: "add_node", node: { id: "n1", type: "config" } }], dev())
    expect(msg).not.toBeNull()
    expect(msg!).toContain("接線")
    expect(msg!).toContain("connect_nodes")
  })

  test("RED 2：平行重複生成同一交付物（同 type 同 role）→ 409 且給接線/填位修法", () => {
    const S = "tpl-truth-dup-role"
    storeCanvasState(S, tplState())
    const ops = [
      { type: "add_node", node: { id: "n-dup", type: "image", metadata: { role: "成图" } } },
      wireFromTpl("n-dup"),
      { type: "run_generation", node_id: "n-dup" },
    ]
    const msg = checkTemplateGuard(S, ops, dev())
    expect(msg).not.toBeNull()
    expect(msg!).toContain("平行重複生成")
    expect(msg!).toContain("tpl-x-gen")
  })

  test("RED 3：平行重複生成（未宣告 role，同 type + run_generation）→ 409", () => {
    const S = "tpl-truth-dup-norole"
    storeCanvasState(S, tplState())
    const ops = [
      { type: "add_node", node: { id: "n-dup", type: "image" } },
      wireFromTpl("n-dup"),
      { type: "run_generation", node_id: "n-dup" },
    ]
    const msg = checkTemplateGuard(S, ops, dev())
    expect(msg).not.toBeNull()
    expect(msg!).toContain("平行重複生成")
    expect(msg!).toContain("metadata.role")
  })

  test("RED 4：平行新流（邊只連新節點，未錨定既有圖）→ 409", () => {
    const S = "tpl-truth-parallel"
    storeCanvasState(S, tplState())
    const ops = [
      { type: "add_node", node: { id: "p-text", type: "text" } },
      { type: "add_node", node: { id: "p-gen", type: "config" } },
      { type: "connect_nodes", connections: [{ fromNodeId: "p-text", toNodeId: "p-gen" }] },
    ]
    const msg = checkTemplateGuard(S, ops, dev())
    expect(msg).not.toBeNull()
    expect(msg!).toContain("接線")
  })
})

describe("模板守衛·偏離 token（網關簽發、模型自宣告無效）", () => {
  test("模型自帶 deviate_from_template=true＋理由＝仍 409（無網關 token）", () => {
    const S = "tpl-dev-no-token"
    storeCanvasState(S, tplState())
    const msg = checkTemplateGuard(S, [{ type: "add_node", node: { id: "n1", type: "config" } }], dev({ declared: true, reason: "用户同意" }))
    expect(msg).not.toBeNull()
    expect(msg!).toContain("question")
  })

  test("用戶真實回應 question → 網關簽發 token；帶對的 token 才放行，且單次核銷", () => {
    const S = "tpl-dev-token"
    storeCanvasState(S, tplState())
    const add = [{ type: "add_node", node: { id: "n1", type: "config" } }]
    expect(checkTemplateGuard(S, add, dev({ declared: true, reason: "用户同意" }))).not.toBeNull()
    markUserAnsweredQuestion(S)
    const token = getTemplateDeviateToken(S)
    expect(token).toBeTruthy()
    // 錯誤 token → 仍攔
    expect(checkTemplateGuard(S, add, dev({ declared: true, reason: "用户同意", token: "wrong" }))).not.toBeNull()
    // 正確 token → 放行
    expect(checkTemplateGuard(S, add, dev({ declared: true, reason: "用户同意", token: token! }))).toBeNull()
    // 單次核銷：同 token 再用一次 → 攔
    expect(checkTemplateGuard(S, add, dev({ declared: true, reason: "用户同意", token: token! }))).not.toBeNull()
  })
})

describe("模板事實注入（拓撲＋空位＋插入配方）", () => {
  test("buildTemplateSlotsFact 含 stepIndex/stepName/前驅/下游/空位狀態；loading 標示已在跑", () => {
    const S = "tpl-fact-topology"
    storeCanvasState(S, {
      nodes: [
        { id: "tpl-m-s0-gen", type: "image", title: "首图", metadata: { stepIndex: 0, stepName: "首图" } },
        { id: "tpl-m-s1-gen", type: "image", title: "终图", metadata: { stepIndex: 1, stepName: "终图" } },
        { id: "tpl-m-loading-gen", type: "image", title: "跑中", metadata: { status: "loading" } },
      ],
      connections: [{ id: "c1", fromNodeId: "tpl-m-s0-gen", toNodeId: "tpl-m-s1-gen" }],
    })
    const fact = buildTemplateSlotsFact(S)
    expect(fact).not.toBeNull()
    expect(fact!).toContain("第1步")
    expect(fact!).toContain("首图")
    expect(fact!).toContain("前驅=")
    expect(fact!).toContain("下游=tpl-m-s1-gen")
    expect(fact!).toContain("已在跑")
    expect(fact!).toContain("connect_nodes")
    expect(renderTemplateTopology(S)).toContain("tpl-m-s1-gen")
  })
})

describe("模板槽位綁定與落位回灌", () => {
  test("image_generate 綁定 open image 空位；回灌落位事實", () => {
    const S = "tpl-bind"
    storeCanvasState(S, tplState())
    expect(hasTemplateNodes(S)).toBe(true)
    const s1 = claimTemplateSlot(S, "cu_a", "image")
    expect(s1?.id).toBe("tpl-x-gen")
    expect(canvasResultNodeId(S, "cu_a")).toBe("tpl-x-gen")
    expect(canvasResultNodeId(S, "cu_zzz")).toBe("cu_zzz-image")
    expect(claimTemplateSlot(S, "cu_b", "video")).toBeNull()
    expect(templateLandingFact(S)).toContain("tpl-x-gen")
  })

  test("多步模板 claimTemplateSlot 取 stepIndex 最小者，跳過 loading/已佔位", () => {
    const S = "tpl-bind-multi"
    storeCanvasState(S, {
      nodes: [
        { id: "tpl-m-s1-gen", type: "image", title: "第一步", metadata: { stepIndex: 1, stepName: "首图" } },
        { id: "tpl-m-s2-gen", type: "image", title: "第二步", metadata: { stepIndex: 2, stepName: "终图" } },
        { id: "tpl-m-loading-gen", type: "image", title: "跑中", metadata: { status: "loading" } },
      ],
    })
    expect(claimTemplateSlot(S, "cu_m1", "image")?.id).toBe("tpl-m-s1-gen")
    expect(claimTemplateSlot(S, "cu_m2", "image")?.id).toBe("tpl-m-s2-gen")
  })
})
