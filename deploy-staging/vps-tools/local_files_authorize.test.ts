// local_files_authorize 工具契約測試（W6 本機檔案橋的授權落地工具）。
//
// 測試對象是 opencode-runtime 的唯一真源 `tools/local_files_authorize.ts`。
// 與 local_files.test.ts 同法：本機沒有 `@opencode-ai/plugin`（只裝在生產 VPS），
// 故用 `mock.module` 注入等價的 `tool`（identity + schema=zod），fetch 全程以注入的 mock
// 取代，絕不連 127.0.0.1:8081（更不會碰任何真實裝置、不落任何規則）。
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"

mock.module("@opencode-ai/plugin/tool", () => ({
  tool: Object.assign((input: unknown) => input, { schema: z }),
}))

const authorize = (await import("../opencode-runtime/tools/local_files_authorize")).default as any

type ToolResult = { title: string; output: string }
const parse = (r: unknown): any => JSON.parse((r as ToolResult).output)
const ctx = { sessionID: "ses_authorize_test" } as any

// ── fetch 注入（絕不出網）──────────────────────────────────────────────
const calls: Array<{ url: string; init?: any }> = []
const realFetch = globalThis.fetch
let handler: ((url: string, init?: any) => any) | null = null

globalThis.fetch = (async (url: unknown, init?: any) => {
  calls.push({ url: String(url), init })
  if (handler) return handler(String(url), init)
  return jsonResponse({ ok: true })
}) as unknown as typeof fetch

afterAll(() => {
  globalThis.fetch = realFetch
})
beforeEach(() => {
  calls.length = 0
  handler = null
})

function jsonResponse(body: any, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const authorizeCalls = () => calls.filter((c) => c.url.includes("/internal/device/authorize"))

// ── 工具宣告面 ────────────────────────────────────────────────────────
describe("local_files_authorize：args 契約", () => {
  test("scope 恰好接受 once/session/permanent、拒非法值；root 必填 string；tool 選填", () => {
    for (const s of ["once", "session", "permanent"]) {
      expect(authorize.args.scope.safeParse(s).success).toBe(true)
    }
    expect(authorize.args.scope.safeParse("always").success).toBe(false)
    expect(authorize.args.scope.safeParse(undefined).success).toBe(false)
    expect(authorize.args.root.safeParse(undefined).success).toBe(false)
    expect(authorize.args.root.safeParse("/home/u/D").success).toBe(true)
    expect(authorize.args.tool.safeParse(undefined).success).toBe(true)
  })

  test("非法 scope / 空 root 本地擋下且不打網路", async () => {
    let r = parse(await authorize.execute({ scope: "always", root: "/x" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("bad_request")
    r = parse(await authorize.execute({ scope: "once", root: "   " } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("bad_request")
    expect(calls.length).toBe(0)
  })

  test("description：只在使用者同意後、原樣傳 scope、不得升級 permanent", () => {
    const d: string = authorize.description
    expect(d).toContain("只在使用者明確同意之後才可呼叫")
    expect(d).toContain("原樣")
    expect(d).toContain("不得")
    expect(d).toContain("permanent")
    expect(d).toContain("永久允許")
  })
})

// ── 三種 scope 走通（送出的就是使用者選的）────────────────────────────
describe("local_files_authorize：三種 scope 走通、原樣下發", () => {
  for (const scope of ["once", "session", "permanent"]) {
    test(`scope=${scope} → POST body 原樣帶出 ${scope}`, async () => {
      handler = () =>
        jsonResponse({ ok: true, applied: { scope, root: "/home/u/D" }, rules: [{ scope, root: "/home/u/D" }] })
      const r = parse(await authorize.execute({ scope, root: "/home/u/D" } as any, ctx))
      expect(r.ok).toBe(true)
      expect(r.applied.scope).toBe(scope)
      expect(JSON.parse(authorizeCalls()[0].init.body)).toEqual({ scope, root: "/home/u/D" })
      expect(authorizeCalls()[0].url).toContain("session_id=ses_authorize_test")
    })
  }

  test("permanent 成功帶出 persist_on_device=true 與提示；once 不帶該欄", async () => {
    handler = () =>
      jsonResponse({ ok: true, applied: { scope: "permanent", root: "/x" }, persist_on_device: true, rules: [] })
    let r = parse(await authorize.execute({ scope: "permanent", root: "/x" } as any, ctx))
    expect(r.persist_on_device).toBe(true)
    expect(r.note).toContain("自動放行")
    expect(r.note).toContain("once 為一次性")

    calls.length = 0
    handler = () => jsonResponse({ ok: true, applied: { scope: "once", root: "/x" }, rules: [] })
    r = parse(await authorize.execute({ scope: "once", root: "/x" } as any, ctx))
    expect(r.persist_on_device).toBeUndefined()
  })

  test("tool 選填：帶了才下發", async () => {
    handler = () => jsonResponse({ ok: true, applied: { scope: "session", root: "/x" }, rules: [] })
    await authorize.execute({ scope: "session", root: "/x", tool: "read_file" } as any, ctx)
    expect(JSON.parse(authorizeCalls()[0].init.body)).toEqual({ scope: "session", root: "/x", tool: "read_file" })

    calls.length = 0
    await authorize.execute({ scope: "session", root: "/x" } as any, ctx)
    expect(JSON.parse(authorizeCalls()[0].init.body)).toEqual({ scope: "session", root: "/x" })
  })
})

// ── 錯誤碼映射 ────────────────────────────────────────────────────────
describe("local_files_authorize：錯誤碼映射成人話", () => {
  const cases: Array<[string, string]> = [
    ["root_too_broad", "範圍太寬"],
    ["denylisted_root", "不能授權"],
    ["root_not_absolute", "絕對路徑"],
    ["bad_request", "格式不正確"],
  ]
  for (const [code, frag] of cases) {
    test(`${code} → 映射含「${frag}」，不吞原文`, async () => {
      handler = () => jsonResponse({ ok: false, error: { code, message: `raw:${code}` } }, 400)
      const r = parse(await authorize.execute({ scope: "once", root: "/x" } as any, ctx))
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe(code)
      expect(r.error.hint).toContain(frag)
      expect(r.error.hint).not.toContain(`raw:${code}`)
    })
  }

  test("session_unknown 有專屬引導；未知碼原樣帶出 message", async () => {
    handler = () => jsonResponse({ ok: false, error: { code: "session_unknown", message: "raw" } }, 404)
    let r = parse(await authorize.execute({ scope: "once", root: "/x" } as any, ctx))
    expect(r.error.code).toBe("session_unknown")
    expect(r.error.hint).toContain("重新開始對話")

    handler = () => jsonResponse({ ok: false, error: { code: "weird_code", message: "raw:weird" } }, 500)
    r = parse(await authorize.execute({ scope: "once", root: "/x" } as any, ctx))
    expect(r.error.code).toBe("weird_code")
    expect(r.error.hint).toContain("raw:weird")
  })

  test("網路失敗 → internal_error，不外拋", async () => {
    handler = () => {
      throw new Error("boom")
    }
    const r = parse(await authorize.execute({ scope: "once", root: "/x" } as any, ctx))
    expect(r.error.code).toBe("internal_error")
    expect(r.error.hint).toContain("boom")
  })

  test("全程只打注入的 fetch、只指向 gateway internal 端點，絕不出網", async () => {
    handler = () => jsonResponse({ ok: true, applied: {}, rules: [] })
    await authorize.execute({ scope: "session", root: "/x" } as any, ctx)
    expect(calls.length).toBe(1)
    expect(calls[0].url.startsWith("http://127.0.0.1:8081/internal/device/authorize")).toBe(true)
  })
})