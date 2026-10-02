// search_web 工具 coverage_notice 真行为测试（本輪分流培訓的反向提示）。
//
// 真行为断言（mock fetch，不真连）：成功回执**恒带** coverage_notice，内容指向
// search_aggregate（平台站内），且既有字段（result_count/results）语义不变。
// description 断言只是守門件（源碼字符串掃描），不算验收——验收在 loopback 真回合。
//
// 跑法：bash deploy-staging/vps-tools/run-tests.sh ../vps-tools/web-search.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { EXA_SEARCH_URL, webSearchTool } from "../opencode-runtime/lib/web_search_impl"

let originalFetch: typeof fetch
let originalKey: string | undefined

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalKey = process.env.EXA_API_KEY
  process.env.EXA_API_KEY = "test-key-123"
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.EXA_API_KEY
  else process.env.EXA_API_KEY = originalKey
})

function mockOk(body: unknown): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(typeof url === "string" ? url : url.toString())
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return calls
}

function out(res: { output: string }): Record<string, unknown> {
  return JSON.parse(res.output) as Record<string, unknown>
}

describe("search_web coverage_notice", () => {
  test("成功回执恒带 coverage_notice，反向提示 search_aggregate", async () => {
    const calls = mockOk({ results: [{ title: "t", url: "https://x", highlights: ["h"] }] })
    const r = await webSearchTool.execute({ query: "澳门 陈天泽" })
    const parsed = out(r)
    expect(calls).toEqual([EXA_SEARCH_URL])
    expect(parsed.ok).toBe(true)
    expect(typeof parsed.coverage_notice).toBe("string")
    expect(parsed.coverage_notice as string).toContain("search_aggregate")
    // 既有字段名称与语义不变
    expect(parsed.result_count).toBe(1)
    expect(Array.isArray(parsed.results)).toBe(true)
  })

  test("空结果时 notice 仍在（不因无结果省略）", async () => {
    mockOk({ results: [] })
    const parsed = out(await webSearchTool.execute({ query: "q" }))
    expect(parsed.result_count).toBe(0)
    expect(parsed.coverage_notice as string).toContain("search_aggregate")
  })

  test("description 开门见山是预设通用网页搜索（守門件，不算验收）", () => {
    expect(webSearchTool.description).toContain("预设通用网页搜索工具")
    expect(webSearchTool.description).toContain("不要优先挑平台工具")
  })
})
