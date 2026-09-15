/**
 * memory-gate.test.ts — G1/G2/G3/G4/G6 命中/放過矩陣 + stripJsonFence 三態（node:test 純邏輯）。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/memory-gate.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  applyMemoryGates,
  stripJsonFence,
  type CuratorCandidate,
  type GateContext,
} from "./memory-gate.ts"

const OWNER = "0123456789abcdef01234567" // 24 hex（SHA-256 前 12 bytes 形狀）
const sharedCtx: GateContext = { sharedEnabled: true }
const ownerCtx: GateContext = { sharedEnabled: true, ownerKeyHint: OWNER }

function base(over: Partial<CuratorCandidate> = {}): CuratorCandidate {
  return {
    scope: "shared",
    domain: "日本动漫",
    slug: "anime-key-lighting",
    description: "动漫夜景用冷暖补色做主光与阴影可提升画面层次",
    type: "domain",
    body: "先铺冷色主光，再以暖色补色打阴影，形成层次对比。",
    links: [],
    evidence: "用户确认：补色光影的感觉很好，以后都这样",
    evidence_kind: "tool_result",
    self_score: 4,
    self_score_reason: "多轮生成均获正反馈",
    ...over,
  }
}

describe("G1 結構", () => {
  it("合法 shared 候選通過並轉駝峰", () => {
    const r = applyMemoryGates(base(), sharedCtx)
    assert.equal(r.action, "accept")
    assert.ok(r.doc)
    assert.equal(r.doc?.evidenceKind, "tool_result") // snake→camel 在本檔發生
    assert.equal(r.doc?.selfScore, 4)
    assert.ok(!("evidence_kind" in (r.doc ?? {})))
    assert.ok(!("self_score" in (r.doc ?? {})))
  })
  it("非物件候選丟棄", () => {
    assert.equal(applyMemoryGates(null as unknown as CuratorCandidate, sharedCtx).reason, "g1_structure")
  })
  it("slug 不合規丟棄", () => {
    for (const bad of ["Anime_Lighting", "有中文", "a".repeat(65), ""]) {
      const r = applyMemoryGates(base({ slug: bad }), sharedCtx)
      assert.equal(r.action, "drop", `slug=${bad}`)
      assert.equal(r.reason, "g1_structure")
    }
  })
  it("description >120 丟棄", () => {
    assert.equal(applyMemoryGates(base({ description: "x".repeat(121) }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ description: "x".repeat(120) }), sharedCtx).action, "accept")
  })
  it("body >2000 丟棄", () => {
    assert.equal(applyMemoryGates(base({ body: "y".repeat(2001) }), sharedCtx).reason, "g1_structure")
  })
  it("枚舉不命中丟棄", () => {
    assert.equal(applyMemoryGates(base({ type: "preference" }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ scope: "team" }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ evidence_kind: "model_reasoning" }), sharedCtx).reason, "g1_structure")
  })
  it("self_score 非 1-5 數字丟棄", () => {
    assert.equal(applyMemoryGates(base({ self_score: 0 }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ self_score: "4" }), sharedCtx).reason, "g1_structure")
  })
  it("MEMORY_SHARED_ENABLED=false 時 shared 零寫入", () => {
    const r = applyMemoryGates(base(), { sharedEnabled: false })
    assert.deepEqual({ action: r.action, reason: r.reason }, { action: "drop", reason: "shared_disabled" })
    // private 不受共享開關影響
    assert.equal(applyMemoryGates(base({ scope: "private", self_score: 3 }), { sharedEnabled: false }).action, "accept")
  })
})

describe("G2 證據（硬線）", () => {
  it("evidence <10 字元丟棄", () => {
    for (const bad of ["", "   ", "用户说不错", undefined]) {
      const r = applyMemoryGates(base({ evidence: bad }), sharedCtx)
      assert.equal(r.action, "drop", JSON.stringify(bad))
      assert.equal(r.reason, "g2_evidence")
    }
  })
  it("evidence 恰 10 字元放過", () => {
    assert.equal(applyMemoryGates(base({ evidence: "abcdefghij" }), sharedCtx).action, "accept")
  })
})

describe("G3 敏感（只回代號、不回顯內容）", () => {
  const samples: Array<[string, CuratorCandidate]> = [
    ["sk- 金鑰", base({ description: "配置 key sk-proj-9f8e7d6c5b4a 後重試" })],
    ["AIza", base({ body: "上游回傳 AIzaSyD-fake-key-for-test 需輪換" })],
    ["Bearer ", base({ evidence: "工具日誌 Bearer abcdefghijklmnop 洩漏" })],
    ["AKIA", base({ body: "AKIA1234567890ABCDEF 屬機密" })],
    ["-----BEGIN", base({ body: "-----BEGIN PRIVATE KEY----- 不可入庫" })],
    ["JWT 三段", base({ body: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_Xt09GH5Wm2B5tWb8ZgqA" })],
    ["password 關鍵詞", base({ evidence: "用戶貼了 password hunter2please 讓我存" })],
    [".env 字形", base({ body: "把值寫進 .env 即可生效" })],
  ]
  for (const [name, candidate] of samples) {
    it(`丟棄：${name}`, () => {
      const r = applyMemoryGates(candidate, sharedCtx)
      assert.equal(r.action, "drop")
      assert.equal(r.reason, "g3_secret")
      assert.equal(r.doc, undefined)
      // 結果物件絕不回顯命中內容
      assert.ok(!JSON.stringify(r).includes("sk-proj"))
      assert.ok(!JSON.stringify(r).includes("hunter2"))
      assert.ok(!JSON.stringify(r).includes("BEGIN"))
    })
  }
  it("普通正文放過", () => {
    assert.equal(applyMemoryGates(base(), sharedCtx).action, "accept")
  })
})

describe("G6 分數線", () => {
  it("shared <4 丟棄、=4 放過", () => {
    assert.equal(applyMemoryGates(base({ self_score: 3 }), sharedCtx).reason, "g6_score")
    assert.equal(applyMemoryGates(base({ self_score: 4 }), sharedCtx).action, "accept")
  })
  it("private ≥3 放過、<3 丟棄", () => {
    const p = (score: number) => base({ scope: "private", self_score: score })
    assert.equal(applyMemoryGates(p(3), sharedCtx).action, "accept")
    assert.equal(applyMemoryGates(p(2), sharedCtx).reason, "g6_score")
  })
})

describe("G4 身份泄漏（僅 shared → 降級 private）", () => {
  const leaky = [
    ["郵箱", base({ description: "用戶 tina.chen@example.com 偏好此風格" })],
    ["session id", base({ body: "該風格確立於 ses_ABC123def456 對話" })],
    ["URL", base({ body: "參考 https://img.example.com/ref.png 風格" })],
    ["絕對路徑", base({ body: "素材存放在 /opt/agent-harness/assets 下" })],
    ["ownerKey hex 長串", base({ body: `標識 ${OWNER} 對應該用戶` })],
    ["價格數字", base({ description: "用戶預算 $19.9 內選模型" })],
  ] as const
  for (const [name, candidate] of leaky) {
    it(`有 ownerKey 可降：${name}`, () => {
      const r = applyMemoryGates(candidate, ownerCtx)
      assert.equal(r.action, "downgrade", name)
      assert.equal(r.reason, "g4_identity_downgraded")
      assert.equal(r.doc?.scope, "private")
      assert.equal(r.doc?.ownerKey, OWNER)
    })
    it(`無 ownerKey 則丟：${name}`, () => {
      const r = applyMemoryGates(candidate, sharedCtx)
      assert.equal(r.action, "drop", name)
      assert.equal(r.reason, "g4_no_owner")
      assert.equal(r.doc, undefined)
    })
  }
  it("private 命中郵箱不降級（僅 shared 適用 G4）", () => {
    const r = applyMemoryGates(
      base({ scope: "private", self_score: 3, description: "用戶 tina.chen@example.com 偏好此風格" }),
      sharedCtx,
    )
    assert.equal(r.action, "accept")
  })
  it("G3 先於 G4：敏感 shared 直接丟而非降級", () => {
    const r = applyMemoryGates(base({ body: "sk-test-abcdef12345 且 tina@example.com" }), ownerCtx)
    assert.equal(r.action, "drop")
    assert.equal(r.reason, "g3_secret")
  })
})

describe("stripJsonFence 三態", () => {
  it("無圍欄原樣（trim）", () => {
    assert.equal(stripJsonFence('  {"a":1}\n'), '{"a":1}')
  })
  it("```json 圍欄剝除", () => {
    assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}')
  })
  it("``` 無語言圍欄剝除", () => {
    assert.equal(stripJsonFence('```\n{"a":1}\n```'), '{"a":1}')
  })
})
