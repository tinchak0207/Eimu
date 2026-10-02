// eimu-guard plugin D1（重複呼叫斷路器）＋ D6（輸出上限／重讀去重）單元測試。
// 這些是工具層的確定性護欄，不靠提示詞自律：必須有測試鎖住語義（尤其「輪詢豁免」——
// 2026-10-02 使用者裁定保留輪詢，斷路器不得把輪詢工具禁掉）。
// 環境變數須在載入 plugin 前設定（常數在模組載入時求值），故用動態 import。
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"

process.env.LOOP_BREAKER_N = "3"
process.env.LOOP_BREAKER_HARD_DELTA = "5" // 第 9 次（>8）觸發強制收尾
process.env.TOOL_OUTPUT_MAX_CHARS = "100"
process.env.READ_DEDUPE = "1"

const { EimuGuard } = await import("./eimu-guard")

const loopBreakerCalls: unknown[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
  if (url.includes("/internal/session/loop-breaker")) {
    try {
      loopBreakerCalls.push(JSON.parse(init?.body ?? "{}"))
    } catch {
      loopBreakerCalls.push({})
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  return new Response("{}", { status: 200 })
}) as typeof fetch
// 還原必須放在 afterAll——檔案頂層最後一行會在測試執行前就跑完，屆時 mock 已被還原。
afterAll(() => {
  globalThis.fetch = realFetch
})

const client = { session: { get: async () => ({ data: {} }) } } as never

async function hooks() {
  return await (EimuGuard as unknown as (ctx: { client: unknown }) => Promise<Record<string, unknown>>)({ client })
}
function beforeOut(args: Record<string, unknown>) {
  return { args } as { args: Record<string, unknown> }
}

describe("D1 迴圈斷路器", () => {
  beforeEach(() => {
    loopBreakerCalls.length = 0
  })

  test("同一參數連續 N 次內放行、第 N+1 次擋下並給可執行文案", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const call = () => before({ tool: "custom_tool", sessionID: "s-loop" }, beforeOut({ x: 1 }))
    await call() // 1
    await call() // 2
    await call() // 3（=N，仍放行）
    await expect(call()).rejects.toThrow(/连续调用 4 次/) // 第 4 次 > N
  })

  test("換參數即歸零（連續判定，不誤殺週期性呼叫）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const call = (x: number) => before({ tool: "custom_tool", sessionID: "s-reset" }, beforeOut({ x }))
    await call(1)
    await call(1)
    await call(2) // 換參數 → 計數歸 1
    await call(2)
    await call(2)
    await expect(call(2)).rejects.toThrow(/连续调用 4 次/)
  })

  test("輪詢工具豁免：subagent_status 同參數 10 次不擋（保留輪詢）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    for (let i = 0; i < 10; i++) {
      await before({ tool: "subagent_status", sessionID: "s-poll" }, beforeOut({ subagent_id: "latest" }))
    }
    expect(loopBreakerCalls.length).toBe(0)
  })

  test("達硬上限（第 9 次）→ 呼叫 gateway 強制收尾端點並拋止", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const call = () => before({ tool: "custom_tool", sessionID: "s-hard" }, beforeOut({ y: 7 }))
    const outcomes: string[] = []
    for (let i = 0; i < 9; i++) {
      try {
        await call()
        outcomes.push("ok")
      } catch (e) {
        outcomes.push((e as Error).message)
      }
    }
    // 1..3 放行；4..8 一般斷流；第 9 次達硬上限（強制收尾 + gateway 通知）。
    expect(outcomes.slice(0, 3)).toEqual(["ok", "ok", "ok"])
    expect(outcomes[3]).toMatch(/连续调用 4 次/)
    expect(outcomes[8]).toMatch(/强制结束本轮/)
    expect(loopBreakerCalls.length).toBeGreaterThan(0)
    expect((loopBreakerCalls[0] as { tool: string }).tool).toBe("custom_tool")
  })
})

describe("D6 上下文經濟", () => {
  test("輸出超上限 → 截斷並附可執行提示", async () => {
    const h = await hooks()
    const after = h["tool.execute.after"] as (i: { tool: string; sessionID: string; args: unknown }, o: { output: string }) => Promise<void>
    const out = { output: "x".repeat(250) }
    await after({ tool: "bash", sessionID: "s-cap", args: {} }, out)
    expect(out.output.length).toBeLessThan(250)
    expect(out.output).toContain("[已截断")
  })

  test("未超上限不動輸出", async () => {
    const h = await hooks()
    const after = h["tool.execute.after"] as (i: { tool: string; sessionID: string; args: unknown }, o: { output: string }) => Promise<void>
    const out = { output: "short" }
    await after({ tool: "bash", sessionID: "s-cap2", args: {} }, out)
    expect(out.output).toBe("short")
  })

  test("同檔重讀且內容未變更 → 第二次回摘要（顯式 offset/limit 為逃生門）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "d6-read-"))
    const file = join(dir, "a.txt")
    writeFileSync(file, "hello world")
    const h = await hooks()
    const after = h["tool.execute.after"] as (i: { tool: string; sessionID: string; args: unknown }, o: { output: string }) => Promise<void>
    const first = { output: "hello world" }
    await after({ tool: "read", sessionID: "s-read", args: { filePath: file } }, first)
    expect(first.output).toBe("hello world")
    const second = { output: "hello world" }
    await after({ tool: "read", sessionID: "s-read", args: { filePath: file } }, second)
    expect(second.output).toContain("已读取过该文件且内容未变更")
    // 帶 offset 一律放行（逃生門）。
    const ranged = { output: "hello world" }
    await after({ tool: "read", sessionID: "s-read", args: { filePath: file, offset: 1, limit: 5 } }, ranged)
    expect(ranged.output).toBe("hello world")
  })
})

