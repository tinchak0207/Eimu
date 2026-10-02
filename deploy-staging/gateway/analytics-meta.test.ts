// analytics-meta.test.ts — 需求 1 的真值驗收：secret 出口遮罩（不使用任何真實憑證，全部假字串）。
//
// 驗的是行為：餵入含 secret 的字串 → 輸出不含原 secret、含遮罩標記；
// 反向：一般中文錯誤訊息不得被誤遮罩。另驗 redactMeta 的遞迴與 key 級遮罩。
import { describe, expect, test } from "bun:test"
import { redactForLog, redactMeta, REDACT_MARKER } from "./analytics-meta.ts"

// redactForLog 回傳型別是 LogSafeText(= never)，測試端以 as string 取出字面值比對。
const out = (s: unknown): string => redactForLog(s) as string

describe("redactForLog — secret 樣式遮罩", () => {
  test("Bearer token：輸出不含原 token、含遮罩標記", () => {
    const original = "Bearer sk-FAKE-1234"
    const r = out(original)
    expect(r).not.toContain(original)
    expect(r).not.toContain("sk-FAKE-1234")
    expect(r).toContain(REDACT_MARKER)
  })

  test("token=FAKEVALUE：值被遮罩、原值不復現", () => {
    const r = out("token=FAKEVALUE")
    expect(r).not.toContain("FAKEVALUE")
    expect(r).toContain(REDACT_MARKER)
  })

  test("假 JWT（三段 base64url）：整段被遮罩", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKESIGNATURE1234"
    const r = out(`auth failed: ${jwt}`)
    expect(r).not.toContain(jwt)
    expect(r).toContain(REDACT_MARKER)
  })

  test("sk- key、key=/secret=/password= 全部遮罩", () => {
    const raw = "sk-FAKE-ABCDEFG api_key=FAKEKEYVALUE secret:FAKESECRET password=FAKEPASS123"
    const r = out(raw)
    expect(r).not.toContain("sk-FAKE-ABCDEFG")
    expect(r).not.toContain("FAKEKEYVALUE")
    expect(r).not.toContain("FAKESECRET")
    expect(r).not.toContain("FAKEPASS123")
    expect(r).toContain(REDACT_MARKER)
  })

  test("長 base64 blob 被遮罩", () => {
    const blob = "QWxwaGFOaW5qYVRlc3RWYWx1ZUZha2UwMDEyMzQ1Njc4OQ"
    const r = out(`payload=${blob}`)
    expect(r).not.toContain(blob)
    expect(r).toContain(REDACT_MARKER)
  })

  test("反向：一般中文錯誤訊息不被誤遮罩（逐字不變）", () => {
    const msg = "对话失败：上游超时，请稍后重试 (code=UPSTREAM_TIMEOUT)"
    expect(out(msg)).toBe(msg)
  })

  test("非字串輸入（Error / 物件）不拋錯且可讀", () => {
    const r = out(new Error("boom token=FAKEVALUE"))
    expect(r).not.toContain("FAKEVALUE")
    expect(r).toContain("boom")
  })
})

describe("redactMeta — 結構遞迴遮罩", () => {
  test("字串值遮罩、數字/布林保留、secret 命名的鍵整值遮罩", () => {
    const m = redactMeta({
      provider: "openai",
      token: "FAKEVALUE-xyz",
      nested: { note: "Bearer sk-FAKE-9999" },
      n: 3,
      ok: true,
    }) as Record<string, any>
    expect(m.provider).toBe("openai")
    expect(m.token).not.toContain("FAKEVALUE-xyz")
    expect(m.nested.note).not.toContain("sk-FAKE-9999")
    expect(m.n).toBe(3)
    expect(m.ok).toBe(true)
  })

  test("circular 結構不無限遞迴", () => {
    const a: Record<string, unknown> = { name: "x" }
    a.self = a
    const r = redactMeta(a) as Record<string, unknown>
    expect(r.name).toBe("x")
    expect(r.self).toBe("[circular]")
  })
})
