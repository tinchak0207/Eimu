// eimu-guard plugin D1（重复呼叫断路器）＋ D6（输出上限／重读去重）单元测试。
// 这些是工具层的确定性护栏，不靠提示词自律：必须有测试锁住语义（尤其「轮询豁免」——
// 2026-10-02 使用者裁定保留轮询，断路器不得把轮询工具禁掉）。
// 环境变数须在载入 plugin 前设定（常数在模组载入时求值），故用动态 import。
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"

process.env.LOOP_BREAKER_N = "3"
process.env.LOOP_BREAKER_HARD_DELTA = "5" // 第 9 次（>8）触发强制收尾
process.env.TOOL_OUTPUT_MAX_CHARS = "100"
process.env.READ_DEDUPE = "1"

const { EimuGuard } = await import("../opencode-runtime/plugin/eimu-guard")
// 工具侧自检闸（read_image/run_py 在 execute 内自己呼叫的那一支）：真正决定生产症状的是它。
const { checkAgentPath } = await import("../opencode-runtime/lib/sandbox")

const loopBreakerCalls: unknown[] = []
/** 测试要的 gateway 可信归属查询结果：opencode sessionID → upload_owner（未列＝查无）。 */
const ownerByOc: Record<string, string> = {}
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
  if (url.includes("/internal/session-key")) {
    let sid = ""
    try {
      sid = String((JSON.parse(init?.body ?? "{}") as { session_id?: string }).session_id ?? "")
    } catch {
      /* 坏 body ＝查无 */
    }
    const owner = ownerByOc[sid]
    return new Response(JSON.stringify(owner ? { ok: true, upload_owner: owner } : { ok: true }), { status: 200 })
  }
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
// 还原必须放在 afterAll——档案顶层最后一行会在测试执行前就跑完，届时 mock 已被还原。
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

describe("D1 回圈断路器", () => {
  beforeEach(() => {
    loopBreakerCalls.length = 0
  })

  test("同一参数连续 N 次内放行、第 N+1 次挡下并给可执行文案", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const call = () => before({ tool: "custom_tool", sessionID: "s-loop" }, beforeOut({ x: 1 }))
    await call() // 1
    await call() // 2
    await call() // 3（=N，仍放行）
    await expect(call()).rejects.toThrow(/连续调用 4 次/) // 第 4 次 > N
  })

  test("换参数即归零（连续判定，不误杀周期性呼叫）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const call = (x: number) => before({ tool: "custom_tool", sessionID: "s-reset" }, beforeOut({ x }))
    await call(1)
    await call(1)
    await call(2) // 换参数 → 计数归 1
    await call(2)
    await call(2)
    await expect(call(2)).rejects.toThrow(/连续调用 4 次/)
  })

  test("轮询工具豁免：subagent_status 同参数 10 次不挡（保留轮询）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    for (let i = 0; i < 10; i++) {
      await before({ tool: "subagent_status", sessionID: "s-poll" }, beforeOut({ subagent_id: "latest" }))
    }
    expect(loopBreakerCalls.length).toBe(0)
  })

  test("达硬上限（第 9 次）→ 呼叫 gateway 强制收尾端点并抛止", async () => {
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
    // 1..3 放行；4..8 一般断流；第 9 次达硬上限（强制收尾 + gateway 通知）。
    expect(outcomes.slice(0, 3)).toEqual(["ok", "ok", "ok"])
    expect(outcomes[3]).toMatch(/连续调用 4 次/)
    expect(outcomes[8]).toMatch(/强制结束本轮/)
    expect(loopBreakerCalls.length).toBeGreaterThan(0)
    expect((loopBreakerCalls[0] as { tool: string }).tool).toBe("custom_tool")
  })
})

describe("上传归属水合（原生自检闸 read_image/run_py）", () => {
  // 2026-10-02 生产实锤：read_image 未列在 PATH_TOOLS ⇒ plugin 的惰性水合不跑 ⇒ 工具内的
  // checkAgentPath 拿到空 owner 集合，对**本会话自己的附件**也回 path_denied。
  // 这里用真 plugin 的 before hook ＋真 sandbox 闸验行为（不是扫源码字串）。
  const OWN = "133630c0-5769-4459-b2cf-d4e90cc26dce"
  const FOREIGN = "00000000-0000-4000-8000-000000000000"
  ownerByOc["s-img"] = OWN

  test("read_image 读本会话上传：hook 水合后，工具内自检闸也放行（生产症状回归）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const p = `uploads/${OWN}/my-image.png`
    await expect(before({ tool: "read_image", sessionID: "s-img" }, beforeOut({ image_path: p }))).resolves.toBeUndefined()
    // 这一行才是生产症状：hook 不水合时这里是 { ok:false, reason:"foreign_upload" }。
    expect(checkAgentPath(p, "s-img")).toEqual({ ok: true })
  })

  test("read_image 读他会话上传：水合后仍挡（不放宽归属）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    await expect(
      before({ tool: "read_image", sessionID: "s-img" }, beforeOut({ image_path: `uploads/${FOREIGN}/x.png` })),
    ).rejects.toThrow(/不属于当前会话/)
    expect(checkAgentPath(`uploads/${FOREIGN}/x.png`, "s-img")).toEqual({ ok: false, reason: "foreign_upload" })
  })

  test("run_py 的 stdin_path 同款：本会话放行", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const p = `uploads/${OWN}/in.txt`
    await expect(before({ tool: "run_py", sessionID: "s-img" }, beforeOut({ code: "print(1)", stdin_path: p }))).resolves.toBeUndefined()
    expect(checkAgentPath(p, "s-img")).toEqual({ ok: true })
  })

  test("未水合到归属（gateway 查无）＝fail-closed 挡下", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    const p = `uploads/${OWN}/my-image.png`
    await expect(before({ tool: "read_image", sessionID: "s-unknown" }, beforeOut({ image_path: p }))).rejects.toThrow(
      /不属于当前会话/,
    )
    expect(checkAgentPath(p, "s-unknown")).toEqual({ ok: false, reason: "foreign_upload" })
  })

  test("纯 URL 读图不受 owner 影响（image_path 缺席＝不进路径闸）", async () => {
    const h = await hooks()
    const before = h["tool.execute.before"] as (i: { tool: string; sessionID: string }, o: unknown) => Promise<void>
    await expect(
      before({ tool: "read_image", sessionID: "s-unknown" }, beforeOut({ image_url: "https://example.com/a.png" })),
    ).resolves.toBeUndefined()
  })
})

describe("D6 上下文经济", () => {
  test("输出超上限 → 截断并附可执行提示", async () => {
    const h = await hooks()
    const after = h["tool.execute.after"] as (i: { tool: string; sessionID: string; args: unknown }, o: { output: string }) => Promise<void>
    const out = { output: "x".repeat(250) }
    await after({ tool: "bash", sessionID: "s-cap", args: {} }, out)
    expect(out.output.length).toBeLessThan(250)
    expect(out.output).toContain("[已截断")
  })

  test("未超上限不动输出", async () => {
    const h = await hooks()
    const after = h["tool.execute.after"] as (i: { tool: string; sessionID: string; args: unknown }, o: { output: string }) => Promise<void>
    const out = { output: "short" }
    await after({ tool: "bash", sessionID: "s-cap2", args: {} }, out)
    expect(out.output).toBe("short")
  })

  test("同档重读且内容未变更 → 第二次回摘要（显式 offset/limit 为逃生门）", async () => {
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
    // 带 offset 一律放行（逃生门）。
    const ranged = { output: "hello world" }
    await after({ tool: "read", sessionID: "s-read", args: { filePath: file, offset: 1, limit: 5 } }, ranged)
    expect(ranged.output).toBe("hello world")
  })
})

