/**
 * error-classify.test.ts — 451 legal_error 合规拦截规则 + 不误伤断言。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/error-classify.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyUpstreamError, ERROR_RULES, buildContinuationDirective, buildOrphanToolUseDirective, buildFailoverInjection } from "./error-classify.ts"

describe("upstream-compliance-rejection (451 legal_error)", () => {
  it("e2e 实锤消息 → content / 不可重试 / 人话含 451 与审查", () => {
    const r = classifyUpstreamError(
      'Video generation rejected by upstream compliance filter (451 legal_error). Permanent rejection: prompt failed content review OR account/region lacks video entitlement. Detail: {"error_code":"legal_error","message":"{}"}',
    )
    assert.equal(r.class, "content")
    assert.equal(r.retryable, false)
    assert.ok(r.human.includes("451"))
    assert.ok(r.human.includes("审查"))
  })

  it("排在 timeout-legacy 之前（顺序即优先序，防被通用 timeout 误配）", () => {
    const names = ERROR_RULES.map((r) => r.name)
    const complianceIdx = names.indexOf("upstream-compliance-rejection")
    const timeoutIdx = names.indexOf("timeout-legacy")
    assert.ok(complianceIdx !== -1, "规则存在")
    assert.ok(timeoutIdx !== -1, "timeout-legacy 存在")
    assert.ok(complianceIdx < timeoutIdx, "合规条目必须在通用 timeout 之前")
  })

  it("不误伤：普通 network timeout 消息不命中本条", () => {
    const r = classifyUpstreamError("network timeout while fetching upstream")
    assert.notEqual(r.class, "content")
    assert.ok(!r.human.includes("451"))
    assert.equal(r.class, "timeout")
  })

  it("不误伤：无关键字的普通错误回 unknown / 空人话", () => {
    const r = classifyUpstreamError("something went wrong")
    assert.equal(r.class, "unknown")
    assert.equal(r.retryable, false)
    assert.equal(r.human, "")
  })
})

// 設計取自 Claude Code「錯誤訊息即模型上下文」（續寫指示 / 孤兒 tool_use 補 is_error），
// 未複製其程式碼。純字串斷言——注入通道的「使用者不可見」由 subagent.test.ts 的真事件序列驗。
describe("錯誤訊息即模型上下文：注入文本建構器", () => {
  it("buildContinuationDirective：直接續寫、勿道歉、勿複述、拆小步驟", () => {
    const d = buildContinuationDirective()
    assert.match(d, /【系统续写指示】/)
    assert.match(d, /不要道歉/)
    assert.match(d, /不要复述/)
    assert.match(d, /拆成更小的步骤/)
    assert.match(d, /不要重复已完成的步骤/)
  })

  it("buildOrphanToolUseDirective：逐項點名工具＋is_error 語義；空/無名回空串", () => {
    const d = buildOrphanToolUseDirective([
      { id: "call_1", name: "bash" },
      { id: "call_2", name: "read" },
    ])
    assert.match(d, /【工具结果缺失·系统补注】/)
    assert.match(d, /is_error=true/)
    assert.match(d, /bash（调用 call_1）/)
    assert.match(d, /read（调用 call_2）/)
    assert.equal(buildOrphanToolUseDirective([]), "")
    assert.equal(buildOrphanToolUseDirective([{ name: "" }]), "")
  })

  it("buildFailoverInjection：有中斷處→續寫＋孤兒補注；零產出且無孤兒→空串", () => {
    const withOrphan = buildFailoverInjection({ hadOutput: true, orphanTools: [{ id: "c9", name: "bash" }] })
    assert.match(withOrphan, /【系统续写指示】/)
    assert.match(withOrphan, /【工具结果缺失·系统补注】/)
    assert.match(withOrphan, /bash/)
    // 續寫指示在前、孤兒補注在後（模型先知道要續寫，再知道哪些工具要重做）。
    assert.ok(withOrphan.indexOf("【系统续写指示】") < withOrphan.indexOf("【工具结果缺失·系统补注】"))
    // 零產出、無孤兒 → 不注入（沒有中斷處可續，重投原任務書即可）。
    assert.equal(buildFailoverInjection({ hadOutput: false }), "")
  })
})
