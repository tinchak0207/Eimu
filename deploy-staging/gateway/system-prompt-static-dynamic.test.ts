/**
 * system-prompt-static-dynamic.test.ts — 静态／动态 system prompt 分界＋黏著 latch 的真值验收
 *（2026-10-02，能力建设：稳定可快取前缀）。设计取自 Claude Code SYSTEM_PROMPT_DYNAMIC_BOUNDARY
 *／systemPromptSection／DANGEROUS_uncachedSystemPromptSection（未复制程式码）。
 *
 * 跑法：bash deploy-staging/vps-tools/run-tests.sh system-prompt-static-dynamic.test.ts
 * 真值断言＝喂真实输入（真实 section 组装结果）→ 检查真实输出字串；不断言原始码字串或
 * 函数调用次数（守门件不算验收）。
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

/** 模拟 handleSendMessage 的 system 段组装（authority 两截＋动态段），供逐轮/逐会话比较。 */
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
  ;(opts.memory ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`memory-${i}`, t, "每轮重算")))
  ;(opts.onboarding ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`onboarding-${i}`, t, "首轮一次性")))
  ;(opts.directive ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`directive-${i}`, t, "首轮一次性")))
  ;(opts.adapt ?? []).forEach((t, i) => s.push(dangerousUncachedSystemSection(`adapt-${i}`, t, "设定每轮重读")))
  if (opts.aborted) s.push(dangerousUncachedSystemSection("turn-aborted-hint", opts.aborted, "随中止状态"))
  if (opts.plan) s.push(dangerousUncachedSystemSection("prior-plan-fact", opts.plan, "随计画状态"))
  return s
}

describe("authority 静态头／会话尾：逐位元还原", () => {
  test("head+tail 逐位元等于原 authorityRule", () => {
    for (const n of [NONCE_A, NONCE_B, "ffffffffffff"]) {
      expect(authorityRuleStaticHead() + authorityRuleSessionTail(n)).toBe(authorityRule(n))
    }
  })
  test("静态头不含任何 session 级凭证", () => {
    expect(authorityRuleStaticHead()).not.toContain(NONCE_A)
    // 只允许出现凭证锚点前缀「⟦gw:」，不得出现带值的完整凭证。
    expect(authorityRuleStaticHead()).not.toMatch(/⟦gw:[0-9a-f]+⟧/)
    expect(authorityRuleSessionTail(NONCE_A)).toContain(NONCE_A)
    expect(authorityRuleStaticHead() + authorityRuleSessionTail(NONCE_A)).toContain(`⟦gw:${NONCE_A}⟧`)
  })
})

describe("组装路径不改既有语义（逐位元等于旧 join）", () => {
  test("代表案例：assembly === 旧逐步 join", () => {
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

  test("每个原段落仍在输出中、且相对顺序不变", () => {
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

  test("空动态段不产生多余分隔（等同 filter(Boolean)）", () => {
    expect(assembleSystemPromptSections(buildSections({ nonce: NONCE_A })).system).toBe(authorityRule(NONCE_A))
  })
})

describe("(a) 同一 session 连组两轮：静态段逐位元相同", () => {
  test("同 session、动态每轮不同 → staticPrefix 不变", () => {
    const nonce = NONCE_A
    const turn1 = assembleSystemPromptSections(buildSections({ nonce, memory: ["首轮连续性块", "L1 目录"], onboarding: ["ONB"], adapt: ["A1"] }))
    const turn2 = assembleSystemPromptSections(buildSections({ nonce, memory: ["第二轮只剩 L1"], adapt: ["A1", "A2"], plan: "未兑现事实" }))
    expect(turn1.staticPrefix).toBe(turn2.staticPrefix)
    expect(turn1.boundaryIndex).toBe(turn2.boundaryIndex)
  })

  test("session 级 latch 冻结于起点：compute 再变也回旧值", () => {
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

describe("(b) 不同 session：静态段仍逐位元相同（真的 session-invariant）", () => {
  test("两个不同 nonce 的 session → staticPrefix 相同、dynamicSuffix 因凭证而异", () => {
    const s1 = assembleSystemPromptSections(buildSections({ nonce: NONCE_A, adapt: ["A1"] }))
    const s2 = assembleSystemPromptSections(buildSections({ nonce: NONCE_B, adapt: ["A1"] }))
    expect(s1.staticPrefix).toBe(s2.staticPrefix)
    expect(s1.dynamicSuffix).not.toBe(s2.dynamicSuffix)
    expect(s1.staticPrefix).toBe(authorityRuleStaticHead())
  })
})

describe("(c) 动态段变化不改静态段在字串中的位置（前缀稳定性）", () => {
  test("各种动态组合下，system 永远以同一 staticPrefix 开头、长度固定", () => {
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
      expect(a.system).not.toContain(SYSTEM_STATIC_DYNAMIC_BOUNDARY) // 标记不进模型可见正文
    }
  })
})

describe("DANGEROUS 标记：故意不稳定的段必须写理由", () => {
  test("缺理由抛错、有理由通过", () => {
    expect(() => dangerousUncachedSystemSection("x", "t", "")).toThrow()
    expect(() => dangerousUncachedSystemSection("x", "t", "   ")).toThrow()
    const s = dangerousUncachedSystemSection("x", "t", "因为每轮重算")
    expect(s.stability).toBe("turn")
    expect(s.cacheBreakReason).toBe("因为每轮重算")
  })
})

describe("尾端注入块（appendSystemPayloadToTurnTail）格式与位置不变", () => {
  test("附在最后一个 text part 尾端、带会话凭证、同 byte 不重贴", () => {
    const state = { gwNonce: NONCE_A, lastTailPayloadHash: undefined } as unknown as SessionState
    const parts = [{ type: "text", text: "USER" }]
    const pb = { parts } as { parts: { type: string; text: string }[]; system?: string }
    appendSystemPayloadToTurnTail(state, pb, "PAYLOAD", "【标签】")
    expect(pb.parts.length).toBe(1)
    expect(pb.parts[0].text).toBe(`USER${TAIL_PAYLOAD_MARKER}⟦gw:${NONCE_A}⟧ 【标签】\nPAYLOAD`)
    // 同 hash 再贴 → 不重复（内容已在历史中）
    const before = pb.parts[0].text
    appendSystemPayloadToTurnTail(state, pb, "PAYLOAD", "【标签】")
    expect(pb.parts[0].text).toBe(before)
  })
})

// ── 环境事实段接线（2026-10-04）：userId 真的流进 collectRuntimeEnvironment ──────
//
// 缺口：messages-gw 的组装处过去呼叫 collectRuntimeEnvironment 没传 userId ⇒ 生产永远
// 落到 localBridge=unknown（且 unknown 稳定度=session，会被 latch 黏住）。本组断言证明
// userId 由 resolver 拿到的**实际值**被传进搜集（用假的 env 状态当独立 oracle），并证明
// 稳定度契约真的生效（非 unknown ⇒ turn 不黏著；unknown ⇒ session 可黏著）。
describe("(d) 环境事实段接线：userId 进 collectRuntimeEnvironment，稳定度据此生效", () => {
  /** 注入假 resolver 与搜集 spy；collect 收到真实 inputs 后用受控装置桥状态跑真搜集。 */
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
          // roots 依 userId 事实回报：证明查询吃的是传进来的 userId，而非常数。
          authorizedRootCount: u === 42 ? (opts.roots ?? 1) : 0,
        }),
      })
    }
    return { seen, collect }
  }

  test("有 userId ⇒ 值真的传进搜集；localBridge 具体 ⇒ 整段 turn，不黏著", async () => {
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
    // resolver 被以本回合 key 呼叫（既有正典化身分路径）
    expect(calledWith).toBe("sk-biz-canonical")
    // 核心接线断言：resolver 回传的 42 真的进了搜集输入（值来自独立 stub，非被测实作）
    expect(seen.length).toBe(1)
    expect(seen[0].userId).toBe(42)
    // 具体 localBridge ⇒ turn（每轮重算），不得走 session latch
    expect(section.stability).toBe("turn")
    expect(section.cacheBreakReason).toBeTruthy()
    expect(section.text).toContain("本机文件通道：在线可用")
  })

  test("取不到 userId ⇒ 维持 unknown（不得猜）且回落 session latch", async () => {
    const { seen, collect } = harness({ roots: 3 })
    const section = await buildEnvironmentSection({
      state: {},
      key: "k",
      plane: "creator",
      resolveUserId: async () => null,
      collect,
    })
    expect(seen[0].userId).toBeNull()
    // 即使装置桥会回报 online，缺身分一律 unknown（unknown ≠ 没有）
    expect(section.stability).toBe("session")
    expect(section.cacheBreakReason).toBeUndefined()
    expect(section.text).toContain("本机文件通道：未知（本轮无法判定）")
  })

  test("resolver 抛错 ⇒ fail-safe 维持 unknown，不得猜", async () => {
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

  test("端点：unknown 先被黏著，一有 userId 即转 turn 端出即时事实（不被旧 latch 黏死）", async () => {
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
    // 同一 state 下一轮拿到 userId：必须走 turn、端出线上事实，而非回旧的 unknown 快取
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
    // 且装置授权根数改变（2→0）会改变渲染（证明来源是查询，非常数）
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
