// 模板守衛 v2（接線契約）真值表測試（2026-10-02）。
// 直接呼叫守衛函式、餵真 ops 陣列（非源碼字串斷言）。
import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
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
  consumeTemplateDeviateToken,
} from "./canvas-cascade-state.ts"
import { sessions, dirtySessions } from "./sessions-core.ts"
import { hydrateRow } from "./persistence.ts"
import type { SessionState } from "./types-gateway.ts"

// 2026-10-02：偏離 token 住 session 狀態（persistence 白名單）——token 測試需要一個真 session。
// 用 sessions-core 的註冊面（sessions Map）建最小 state；測完即摘除（避免殘留污染其他測試）。
function mkSession(id: string): SessionState {
  return {
    sessionId: id,
    apiKey: "test-key",
    opencodeSessionId: `${id}-oc`,
    clients: new Set(),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: 0,
    replayBuffer: [],
    lastActivityAt: Date.now(),
    partTextEmitted: new Map(),
    partStripState: new Map(),
    announcedUrls: new Set(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    stepCostLogged: new Set(),
    messageRole: new Map(),
    suppressedParts: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    sessionTasks: new Map(),
    vettingInjected: false,
    profileOnboardingPending: false,
  } as SessionState
}

function dropSession(id: string): void {
  sessions.delete(id)
  dirtySessions.delete(id)
}

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
    sessions.set(S, mkSession(S)) // token 住 session 狀態（persistence 白名單），需真 session
    try {
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
    } finally {
      dropSession(S)
    }
  })

  test("新增1：markUserAnsweredQuestion 後 getTemplateDeviateToken 非 null（token 住 session 狀態）", () => {
    const S = "tpl-tok-issued"
    sessions.set(S, mkSession(S))
    try {
      expect(getTemplateDeviateToken(S)).toBeNull()
      markUserAnsweredQuestion(S)
      const token = getTemplateDeviateToken(S)
      expect(token).toBeTruthy()
      // 真值源頭在 session 狀態欄位，不是行程內 Map
      expect(sessions.get(S)?.tplDeviateToken?.token).toBe(token)
    } finally {
      dropSession(S)
    }
  })

  test("新增2：consumeTemplateDeviateToken 單次核銷——第一次 true、第二次 false", () => {
    const S = "tpl-tok-consume"
    const st = mkSession(S)
    sessions.set(S, st)
    try {
      markUserAnsweredQuestion(S)
      const token = getTemplateDeviateToken(S)!
      expect(token).toBeTruthy()
      expect(consumeTemplateDeviateToken(S, token)).toBe(true)
      expect(consumeTemplateDeviateToken(S, token)).toBe(false)
      expect(st.tplDeviateToken).toBeNull()
    } finally {
      dropSession(S)
    }
  })

  test("新增3：TTL 過期（at 16 分鐘前）→ getTemplateDeviateToken 回 null 且欄位被清成 null", () => {
    const S = "tpl-tok-ttl"
    const st = mkSession(S)
    st.tplDeviateToken = { token: "t-ttl", at: Date.now() - 16 * 60 * 1000 }
    sessions.set(S, st)
    try {
      expect(getTemplateDeviateToken(S)).toBeNull()
      expect(st.tplDeviateToken).toBeNull()
    } finally {
      dropSession(S)
    }
  })

  test("新增4a：hydrateRow 還原 tplDeviateToken；壞形狀一律 null（純函式）", () => {
    const base = { sessionId: "r1", apiKey: "k", opencodeSessionId: "oc1", createdAt: 1, updatedAt: 2 }
    const ok = hydrateRow({ ...base, data: { tplDeviateToken: { token: "t1", at: 123456 } } as never }) as { tplDeviateToken: { token: string; at: number } | null }
    expect(ok.tplDeviateToken?.token).toBe("t1")
    expect(ok.tplDeviateToken?.at).toBe(123456)
    const badToken = hydrateRow({ ...base, data: { tplDeviateToken: { token: 123, at: 1 } } as never }) as { tplDeviateToken: unknown }
    expect(badToken.tplDeviateToken).toBeNull()
    const badShape = hydrateRow({ ...base, data: { tplDeviateToken: "abc" } as never }) as { tplDeviateToken: unknown }
    expect(badShape.tplDeviateToken).toBeNull()
    const missing = hydrateRow({ ...base, data: {} as never }) as { tplDeviateToken: unknown }
    expect(missing.tplDeviateToken).toBeNull()
  })

  test("新增4b：真 DB round-trip（saveSession→loadSessionById）保住 tplDeviateToken", async () => {
    // 真 DB（tmp 隔離）：查詢字串動態 import = 全新模組實例，才會在載入時讀到本檔設的
    // SESSIONS_DB_PATH（persistence 已被 canvas-cascade-state→sessions-core 靜態載入且快取，
    // 直接用 "./persistence.ts" 只會拿回舊實例＝寫進生產 DB，故必須 cache-bust）。
    const dbPath = `/tmp/tpl-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
    process.env.SESSIONS_DB_PATH = dbPath
    const p = (await import("./persistence.ts?tplroundtrip=" + Date.now())) as typeof import("./persistence.ts")
    p.initPersistence()
    const id = `tpl-rt-${Math.random().toString(36).slice(2, 8)}`
    const st = mkSession(id)
    st.tplDeviateToken = { token: "rt-token", at: Date.now() }
    p.saveSession(st)
    const row = p.loadSessionById(id)
    expect(row?.data.tplDeviateToken?.token).toBe("rt-token")
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(dbPath + suffix, { force: true })
      } catch {
        // best-effort 清理，殘檔在 /tmp 無害
      }
    }
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
