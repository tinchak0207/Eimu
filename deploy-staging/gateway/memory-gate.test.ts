/**
 * memory-gate.test.ts — G1/G2/G3/G4/G6 命中/放过矩阵 + stripJsonFence 三态（node:test 纯逻辑）。
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

const OWNER = "0123456789abcdef01234567" // 24 hex（SHA-256 前 12 bytes 形状）
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

describe("G1 结构", () => {
  it("合法 shared 候选通过并转驼峰", () => {
    const r = applyMemoryGates(base(), sharedCtx)
    assert.equal(r.action, "accept")
    assert.ok(r.doc)
    assert.equal(r.doc?.evidenceKind, "tool_result") // snake→camel 在本档发生
    assert.equal(r.doc?.selfScore, 4)
    assert.ok(!("evidence_kind" in (r.doc ?? {})))
    assert.ok(!("self_score" in (r.doc ?? {})))
  })
  it("非物件候选丢弃", () => {
    assert.equal(applyMemoryGates(null as unknown as CuratorCandidate, sharedCtx).reason, "g1_structure")
  })
  it("slug 不合规丢弃", () => {
    for (const bad of ["Anime_Lighting", "有中文", "a".repeat(65), ""]) {
      const r = applyMemoryGates(base({ slug: bad }), sharedCtx)
      assert.equal(r.action, "drop", `slug=${bad}`)
      assert.equal(r.reason, "g1_structure")
    }
  })
  it("description >120 丢弃", () => {
    assert.equal(applyMemoryGates(base({ description: "x".repeat(121) }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ description: "x".repeat(120) }), sharedCtx).action, "accept")
  })
  it("body >2000 丢弃", () => {
    assert.equal(applyMemoryGates(base({ body: "y".repeat(2001) }), sharedCtx).reason, "g1_structure")
  })
  it("枚举不命中丢弃", () => {
    assert.equal(applyMemoryGates(base({ type: "preference" }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ scope: "team" }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ evidence_kind: "model_reasoning" }), sharedCtx).reason, "g1_structure")
  })
  it("self_score 非 1-5 数字丢弃", () => {
    assert.equal(applyMemoryGates(base({ self_score: 0 }), sharedCtx).reason, "g1_structure")
    assert.equal(applyMemoryGates(base({ self_score: "4" }), sharedCtx).reason, "g1_structure")
  })
  it("MEMORY_SHARED_ENABLED=false 时 shared 零写入", () => {
    const r = applyMemoryGates(base(), { sharedEnabled: false })
    assert.deepEqual({ action: r.action, reason: r.reason }, { action: "drop", reason: "shared_disabled" })
    // private 不受共享开关影响
    assert.equal(applyMemoryGates(base({ scope: "private", self_score: 3 }), { sharedEnabled: false }).action, "accept")
  })
})

describe("G2 证据（硬线）", () => {
  it("evidence <10 字元丢弃", () => {
    for (const bad of ["", "   ", "用户说不错", undefined]) {
      const r = applyMemoryGates(base({ evidence: bad }), sharedCtx)
      assert.equal(r.action, "drop", JSON.stringify(bad))
      assert.equal(r.reason, "g2_evidence")
    }
  })
  it("evidence 恰 10 字元放过", () => {
    assert.equal(applyMemoryGates(base({ evidence: "abcdefghij" }), sharedCtx).action, "accept")
  })
})

describe("G3 敏感（只回代号、不回显内容）", () => {
  const samples: Array<[string, CuratorCandidate]> = [
    ["sk- 金钥", base({ description: "配置 key sk-proj-9f8e7d6c5b4a 后重试" })],
    ["AIza", base({ body: "上游回传 AIzaSyD-fake-key-for-test 需轮换" })],
    ["Bearer ", base({ evidence: "工具日志 Bearer abcdefghijklmnop 泄漏" })],
    ["AKIA", base({ body: "AKIA1234567890ABCDEF 属机密" })],
    ["-----BEGIN", base({ body: "-----BEGIN PRIVATE KEY----- 不可入库" })],
    ["JWT 三段", base({ body: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_Xt09GH5Wm2B5tWb8ZgqA" })],
    ["password 关键词", base({ evidence: "用户贴了 password hunter2please 让我存" })],
    [".env 字形", base({ body: "把值写进 .env 即可生效" })],
  ]
  for (const [name, candidate] of samples) {
    it(`丢弃：${name}`, () => {
      const r = applyMemoryGates(candidate, sharedCtx)
      assert.equal(r.action, "drop")
      assert.equal(r.reason, "g3_secret")
      assert.equal(r.doc, undefined)
      // 结果物件绝不回显命中内容
      assert.ok(!JSON.stringify(r).includes("sk-proj"))
      assert.ok(!JSON.stringify(r).includes("hunter2"))
      assert.ok(!JSON.stringify(r).includes("BEGIN"))
    })
  }
  it("普通正文放过", () => {
    assert.equal(applyMemoryGates(base(), sharedCtx).action, "accept")
  })
})

describe("G6 分数线", () => {
  it("shared <4 丢弃、=4 放过", () => {
    assert.equal(applyMemoryGates(base({ self_score: 3 }), sharedCtx).reason, "g6_score")
    assert.equal(applyMemoryGates(base({ self_score: 4 }), sharedCtx).action, "accept")
  })
  it("private ≥3 放过、<3 丢弃", () => {
    const p = (score: number) => base({ scope: "private", self_score: score })
    assert.equal(applyMemoryGates(p(3), sharedCtx).action, "accept")
    assert.equal(applyMemoryGates(p(2), sharedCtx).reason, "g6_score")
  })
})

describe("G4 身份泄漏（仅 shared → 降级 private）", () => {
  const leaky = [
    ["邮箱", base({ description: "用户 tina.chen@example.com 偏好此风格" })],
    ["session id", base({ body: "该风格确立于 ses_ABC123def456 对话" })],
    ["URL", base({ body: "参考 https://img.example.com/ref.png 风格" })],
    ["绝对路径", base({ body: "素材存放在 /opt/agent-harness/assets 下" })],
    ["ownerKey hex 长串", base({ body: `标识 ${OWNER} 对应该用户` })],
    ["价格数字", base({ description: "用户预算 $19.9 内选模型" })],
  ] as const
  for (const [name, candidate] of leaky) {
    it(`有 ownerKey 可降：${name}`, () => {
      const r = applyMemoryGates(candidate, ownerCtx)
      assert.equal(r.action, "downgrade", name)
      assert.equal(r.reason, "g4_identity_downgraded")
      assert.equal(r.doc?.scope, "private")
      assert.equal(r.doc?.ownerKey, OWNER)
    })
    it(`无 ownerKey 则丢：${name}`, () => {
      const r = applyMemoryGates(candidate, sharedCtx)
      assert.equal(r.action, "drop", name)
      assert.equal(r.reason, "g4_no_owner")
      assert.equal(r.doc, undefined)
    })
  }
  it("private 命中邮箱不降级（仅 shared 适用 G4）", () => {
    const r = applyMemoryGates(
      base({ scope: "private", self_score: 3, description: "用户 tina.chen@example.com 偏好此风格" }),
      sharedCtx,
    )
    assert.equal(r.action, "accept")
  })
  it("G3 先于 G4：敏感 shared 直接丢而非降级", () => {
    const r = applyMemoryGates(base({ body: "sk-test-abcdef12345 且 tina@example.com" }), ownerCtx)
    assert.equal(r.action, "drop")
    assert.equal(r.reason, "g3_secret")
  })
})

describe("stripJsonFence 三态", () => {
  it("无围栏原样（trim）", () => {
    assert.equal(stripJsonFence('  {"a":1}\n'), '{"a":1}')
  })
  it("```json 围栏剥除", () => {
    assert.equal(stripJsonFence('```json\n{"a":1}\n```'), '{"a":1}')
  })
  it("``` 无语言围栏剥除", () => {
    assert.equal(stripJsonFence('```\n{"a":1}\n```'), '{"a":1}')
  })
})
