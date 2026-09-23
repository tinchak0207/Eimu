/**
 * error-classify.test.ts — 451 legal_error 合规拦截规则 + 不误伤断言。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/error-classify.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyUpstreamError, ERROR_RULES } from "./error-classify.ts"

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
