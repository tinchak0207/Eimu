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
import { collectRuntimeEnvironment, type CollectEnvironmentInputs } from "./environment-facts.ts"
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
  buildEnvironmentSection,
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

// ── 環境事實段接線（2026-10-04）：userId 真的流進 collectRuntimeEnvironment ──────
//
// 缺口：messages-gw 的組裝處過去呼叫 collectRuntimeEnvironment 沒傳 userId ⇒ 生產永遠
// 落到 localBridge=unknown（且 unknown 穩定度=session，會被 latch 黏住）。本組斷言證明
// userId 由 resolver 拿到的**實際值**被傳進蒐集（用假的 env 狀態當獨立 oracle），並證明
// 穩定度契約真的生效（非 unknown ⇒ turn 不黏著；unknown ⇒ session 可黏著）。
describe("(d) 環境事實段接線：userId 進 collectRuntimeEnvironment，穩定度據此生效", () => {
  /** 注入假 resolver 與蒐集 spy；collect 收到真實 inputs 後用受控裝置橋狀態跑真蒐集。 */
  function harness(opts: { roots?: number; online?: boolean }) {
    const seen: CollectEnvironmentInputs[] = []
    const collect = (inputs: CollectEnvironmentInputs) => {
      seen.push(inputs)
      return collectRuntimeEnvironment({
        ...inputs,
        pathExists: () => false,
        workspaceDir: "/ws",
        uploadsDir: "/ws/uploads",
        deviceBridgeOn: () => true,
        deviceBridgeState: (u) => ({
          enabled: true,
          online: opts.online ?? true,
          deviceCount: 1,
          // roots 依 userId 事實回報：證明查詢吃的是傳進來的 userId，而非常數。
          authorizedRootCount: u === 42 ? (opts.roots ?? 1) : 0,
        }),
      })
    }
    return { seen, collect }
  }

  test("有 userId ⇒ 值真的傳進蒐集；localBridge 具體 ⇒ 整段 turn，不黏著", async () => {
    const { seen, collect } = harness({ roots: 1 })
    let calledWith: string | null = null
    const section = await buildEnvironmentSection({
      state: {},
      key: "sk-biz-canonical",
      plane: "creator",
      resolveUserId: async (k) => {
        calledWith = k
        return 42
      },
      collect,
    })
    // resolver 被以本回合 key 呼叫（既有正典化身分路徑）
    expect(calledWith).toBe("sk-biz-canonical")
    // 核心接線斷言：resolver 回傳的 42 真的進了蒐集輸入（值來自獨立 stub，非被測實作）
    expect(seen.length).toBe(1)
    expect(seen[0].userId).toBe(42)
    // 具體 localBridge ⇒ turn（每輪重算），不得走 session latch
    expect(section.stability).toBe("turn")
    expect(section.cacheBreakReason).toBeTruthy()
    expect(section.text).toContain("本机文件通道：在线可用")
  })

  test("取不到 userId ⇒ 維持 unknown（不得猜）且回落 session latch", async () => {
    const { seen, collect } = harness({ roots: 3 })
    const section = await buildEnvironmentSection({
      state: {},
      key: "k",
      plane: "creator",
      resolveUserId: async () => null,
      collect,
    })
    expect(seen[0].userId).toBeNull()
    // 即使裝置橋會回報 online，缺身分一律 unknown（unknown ≠ 沒有）
    expect(section.stability).toBe("session")
    expect(section.cacheBreakReason).toBeUndefined()
    expect(section.text).toContain("本机文件通道：未知（本轮无法判定）")
  })

  test("resolver 拋錯 ⇒ fail-safe 維持 unknown，不得猜", async () => {
    const { seen, collect } = harness({ roots: 3 })
    const section = await buildEnvironmentSection({
      state: {},
      key: "k",
      plane: "creator",
      resolveUserId: async () => {
        throw new Error("resolve-owner unavailable")
      },
      collect,
    })
    expect(seen[0].userId).toBeNull()
    expect(section.stability).toBe("session")
    expect(section.text).toContain("本机文件通道：未知（本轮无法判定）")
  })

  test("端點：unknown 先被黏著，一有 userId 即轉 turn 端出即時事實（不被舊 latch 黏死）", async () => {
    const state = {}
    const unknownHarness = harness({})
    const unknownSec = await buildEnvironmentSection({
      state,
      key: "k",
      plane: "creator",
      resolveUserId: async () => null,
      collect: unknownHarness.collect,
    })
    expect(unknownSec.stability).toBe("session")
    // 同一 state 下一輪拿到 userId：必須走 turn、端出線上事實，而非回舊的 unknown 快取
    const onlineHarness = harness({ roots: 2 })
    const onlineSec = await buildEnvironmentSection({
      state,
      key: "k",
      plane: "creator",
      resolveUserId: async () => 42,
      collect: onlineHarness.collect,
    })
    expect(onlineSec.stability).toBe("turn")
    expect(onlineSec.text).not.toBe(unknownSec.text)
    expect(onlineSec.text).toContain("本机文件通道：在线可用")
    // 且裝置授權根數改變（2→0）會改變渲染（證明來源是查詢，非常數）
    const noRootsHarness = harness({ roots: 0 })
    const noRootsSec = await buildEnvironmentSection({
      state,
      key: "k",
      plane: "creator",
      resolveUserId: async () => 42,
      collect: noRootsHarness.collect,
    })
    expect(noRootsSec.text).toContain("本机文件通道：在线，但未授权任何本机根目录")
    expect(noRootsSec.text).not.toBe(onlineSec.text)
  })
})
