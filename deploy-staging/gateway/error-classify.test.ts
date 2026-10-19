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

// 设计取自 Claude Code「错误讯息即模型上下文」（续写指示 / 孤儿 tool_use 补 is_error），
// 未复制其程式码。纯字串断言——注入通道的「使用者不可见」由 subagent.test.ts 的真事件序列验。
describe("错误讯息即模型上下文：注入文本建构器", () => {
  it("buildContinuationDirective：直接续写、勿道歉、勿复述、拆小步骤", () => {
    const d = buildContinuationDirective()
    assert.match(d, /【系统续写指示】/)
    assert.match(d, /不要道歉/)
    assert.match(d, /不要复述/)
    assert.match(d, /拆成更小的步骤/)
    assert.match(d, /不要重复已完成的步骤/)
  })

  it("buildOrphanToolUseDirective：逐项点名工具＋is_error 语义；空/无名回空串", () => {
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

  it("buildFailoverInjection：有中断处→续写＋孤儿补注；零产出且无孤儿→空串", () => {
    const withOrphan = buildFailoverInjection({ hadOutput: true, orphanTools: [{ id: "c9", name: "bash" }] })
    assert.match(withOrphan, /【系统续写指示】/)
    assert.match(withOrphan, /【工具结果缺失·系统补注】/)
    assert.match(withOrphan, /bash/)
    // 续写指示在前、孤儿补注在后（模型先知道要续写，再知道哪些工具要重做）。
    assert.ok(withOrphan.indexOf("【系统续写指示】") < withOrphan.indexOf("【工具结果缺失·系统补注】"))
    // 零产出、无孤儿 → 不注入（没有中断处可续，重投原任务书即可）。
    assert.equal(buildFailoverInjection({ hadOutput: false }), "")
  })
})
