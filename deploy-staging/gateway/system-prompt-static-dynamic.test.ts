/**
 * system-prompt-static-dynamic.test.ts — 靜態／動態 system prompt 分界＋黏著 latch 的真值驗收
 *（2026-10-02，能力建設：穩定可快取前綴）。設計取自 Claude Code SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 *／systemPromptSection／DANGEROUS_uncachedSystemPromptSection（未複製程式碼）。
 *
 * 跑法：bash deploy-staging/vps-tools/run-tests.sh system-prompt-static-dynamic.test.ts
 * 真值斷言＝餵真實輸入（真實 section 組裝結果）→ 檢查真實輸出字串；不斷言原始碼字串或
 * 函數調用次數（守門件不算驗收）。
 */
import { expect, test, describe } from "bun:test"
import type { SessionState } from "./types-gateway.ts"
import {
  authorityRule,
  authorityRuleStaticHead,
  authorityRuleSessionTail,
  SYSTEM_STATIC_DYNAMIC_BOUNDARY,
  systemStaticSection,
  systemSessionSection,
  dangerousUncachedSystemSection,
  assembleSystemPromptSections,
  latchSystemSection,
  unfreezeSystemStaticSections,
  appendSystemPayloadToTurnTail,
  TAIL_PAYLOAD_MARKER,
  type SystemPromptSection,
} from "./messages-gw.ts"

const NONCE_A = "a1b2c3d4e5f6"
const NONCE_B = "0f9e8d7c6b5a"

/** 模擬 handleSendMessage 的 system 段組裝（authority 兩截＋動態段），供逐輪/逐會話比較。 */
function buildSections(opts: {
  nonce: string
  memory?: string[]
  onboarding?: string[]
  directive?: string[]
  adapt?: string[]
  aborted?: string
  plan?: string
}): SystemPromptSection[] {
  const s: SystemPromptSection[] = [
    systemStaticSection("authority-head", authorityRuleStaticHead(), ""),
    systemSessionSection("authority-credential", authorityRuleSessionTail(opts.nonce), ""),
  ]
  ;(opts.memory ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`memory-${i}`, t, "每輪重算")))
  ;(opts.onboarding ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`onboarding-${i}`, t, "首輪一次性")))
  ;(opts.directive ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`directive-${i}`, t, "首輪一次性")))
  ;(opts.adapt ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`adapt-${i}`, t, "設定每輪重讀")))
  if (opts.aborted) s.push(dangerousUncachedSystemSection("turn-aborted-hint", opts.aborted, "隨中止狀態"))
  if (opts.plan) s.push(dangerousUncachedSystemSection("prior-plan-fact", opts.plan, "隨計畫狀態"))
  return s
}

describe("authority 靜態頭／會話尾：逐位元還原", () => {
  test("head+tail 逐位元等於原 authorityRule", () => {
    for (const n of [NONCE_A, NONCE_B, "ffffffffffff"]) {
      expect(authorityRuleStaticHead() + authorityRuleSessionTail(n)).toBe(authorityRule(n))
    }
  })
  test("靜態頭不含任何 session 級憑證", () => {
    expect(authorityRuleStaticHead()).not.toContain(NONCE_A)
    // 只允許出現憑證錨點前綴「⟦gw:」，不得出現帶值的完整憑證。
    expect(authorityRuleStaticHead()).not.toMatch(/⟦gw:[0-9a-f]+⟧/)
    expect(authorityRuleSessionTail(NONCE_A)).toContain(NONCE_A)
    expect(authorityRuleStaticHead() + authorityRuleSessionTail(NONCE_A)).toContain(`⟦gw:${NONCE_A}⟧`)
  })
})

describe("組裝路徑不改既有語義（逐位元等於舊 join）", () => {
  test("代表案例：assembly === 舊逐步 join", () => {
    const opts = {
      nonce: NONCE_A,
      memory: ["M1", "M2"],
      onboarding: ["O1"],
      directive: ["D1"],
      adapt: ["A1", "A2"],
      aborted: "ABORTED",
      plan: "PLAN",
    }
    const legacy = [
      [authorityRule(NONCE_A), ...opts.memory, ...opts.onboarding, ...opts.directive].join("\n\n"),
      ...opts.adapt,
      opts.aborted,
      opts.plan,
    ].join("\n\n")
    expect(assembleSystemPromptSections(buildSections(opts)).system).toBe(legacy)
  })

  test("每個原段落仍在輸出中、且相對順序不變", () => {
    const opts = { nonce: NONCE_A, memory: ["MEM"], onboarding: ["ONB"], directive: ["DIR"], adapt: ["ADP"], aborted: "ABT", plan: "PLN" }
    const sys = assembleSystemPromptSections(buildSections(opts)).system
    const order = [authorityRuleStaticHead(), NONCE_A, "MEM", "ONB", "DIR", "ADP", "ABT", "PLN"]
    let prev = -1
    for (const seg of order) {
      const idx = sys.indexOf(seg)
      expect(idx).toBeGreaterThan(prev)
      prev = idx
    }
  })

  test("空動態段不產生多餘分隔（等同 filter(Boolean)）", () => {
    expect(assembleSystemPromptSections(buildSections({ nonce: NONCE_A })).system).toBe(authorityRule(NONCE_A))
  })
})

describe("(a) 同一 session 連組兩輪：靜態段逐位元相同", () => {
  test("同 session、動態每輪不同 → staticPrefix 不變", () => {
    const nonce = NONCE_A
    const turn1 = assembleSystemPromptSections(buildSections({ nonce, memory: ["首輪連續性塊", "L1 目錄"], onboarding: ["ONB"], adapt: ["A1"] }))
    const turn2 = assembleSystemPromptSections(buildSections({ nonce, memory: ["第二輪只剩 L1"], adapt: ["A1", "A2"], plan: "未兌現事實" }))
    expect(turn1.staticPrefix).toBe(turn2.staticPrefix)
    expect(turn1.boundaryIndex).toBe(turn2.boundaryIndex)
  })

  test("session 級 latch 凍結於起點：compute 再變也回舊值", () => {
    const state = { gwNonce: NONCE_A }
    let v = "v1"
    const a = latchSystemSection(state, "authority-credential", () => v)
    v = "v2"
    const b = latchSystemSection(state, "authority-credential", () => v)
    expect(a).toBe("v1")
    expect(b).toBe("v1")
    unfreezeSystemStaticSections(state)
    expect(latchSystemSection(state, "authority-credential", () => v)).toBe("v2")
  })
})

describe("(b) 不同 session：靜態段仍逐位元相同（真的 session-invariant）", () => {
  test("兩個不同 nonce 的 session → staticPrefix 相同、dynamicSuffix 因憑證而異", () => {
    const s1 = assembleSystemPromptSections(buildSections({ nonce: NONCE_A, adapt: ["A1"] }))
    const s2 = assembleSystemPromptSections(buildSections({ nonce: NONCE_B, adapt: ["A1"] }))
    expect(s1.staticPrefix).toBe(s2.staticPrefix)
    expect(s1.dynamicSuffix).not.toBe(s2.dynamicSuffix)
    expect(s1.staticPrefix).toBe(authorityRuleStaticHead())
  })
})

describe("(c) 動態段變化不改靜態段在字串中的位置（前綴穩定性）", () => {
  test("各種動態組合下，system 永遠以同一 staticPrefix 開頭、長度固定", () => {
    const variants = [
      buildSections({ nonce: NONCE_A }),
      buildSections({ nonce: NONCE_A, memory: ["X".repeat(500)] }),
      buildSections({ nonce: NONCE_A, onboarding: ["O"], directive: ["D"], aborted: "ABT", plan: "PLN" }),
      buildSections({ nonce: NONCE_A, adapt: ["A1", "A2", "A3"] }),
    ]
    for (const v of variants) {
      const a = assembleSystemPromptSections(v)
      expect(a.system.startsWith(a.staticPrefix)).toBe(true)
      expect(a.staticPrefix).toBe(authorityRuleStaticHead())
      expect(a.boundaryIndex).toBe(authorityRuleStaticHead().length)
      expect(a.system.slice(0, a.boundaryIndex)).toBe(a.staticPrefix)
      expect(a.system).toBe(a.staticPrefix + a.dynamicSuffix)
      expect(a.system).not.toContain(SYSTEM_STATIC_DYNAMIC_BOUNDARY) // 標記不進模型可見正文
    }
  })
})

describe("DANGEROUS 標記：故意不穩定的段必須寫理由", () => {
  test("缺理由抛錯、有理由通過", () => {
    expect(() => dangerousUncachedSystemSection("x", "t", "")).toThrow()
    expect(() => dangerousUncachedSystemSection("x", "t", "   ")).toThrow()
    const s = dangerousUncachedSystemSection("x", "t", "因為每輪重算")
    expect(s.stability).toBe("turn")
    expect(s.cacheBreakReason).toBe("因為每輪重算")
  })
})

describe("尾端注入塊（appendSystemPayloadToTurnTail）格式與位置不變", () => {
  test("附在最後一個 text part 尾端、帶會話憑證、同 byte 不重貼", () => {
    const state = { gwNonce: NONCE_A, lastTailPayloadHash: undefined } as unknown as SessionState
    const parts = [{ type: "text", text: "USER" }]
    const pb = { parts } as { parts: { type: string; text: string }[]; system?: string }
    appendSystemPayloadToTurnTail(state, pb, "PAYLOAD", "【標籤】")
    expect(pb.parts.length).toBe(1)
    expect(pb.parts[0].text).toBe(`USER${TAIL_PAYLOAD_MARKER}⟦gw:${NONCE_A}⟧ 【標籤】\nPAYLOAD`)
    // 同 hash 再貼 → 不重複（內容已在歷史中）
    const before = pb.parts[0].text
    appendSystemPayloadToTurnTail(state, pb, "PAYLOAD", "【標籤】")
    expect(pb.parts[0].text).toBe(before)
  })
})
