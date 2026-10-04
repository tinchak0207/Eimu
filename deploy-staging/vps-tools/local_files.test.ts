// local_files 工具契约测试（W6 本机档案桥的云端侧工具）。
//
// 测试对象是 opencode-runtime 的唯一真源 `tools/local_files.ts`。
// 本机没有 `@opencode-ai/plugin`（只装在生产 VPS），故用 `mock.module` 注入
// 等价的 `tool`（identity + schema=zod，与 plugin/dist/tool.js 逐字同形），
// 让本档可在**不连 VPS**的前提下本地跑；fetch 全程以注入的 mock 取代，
// 绝不连 127.0.0.1:8081（更不会碰任何真实装置）。
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"

mock.module("@opencode-ai/plugin/tool", () => ({
  tool: Object.assign((input: unknown) => input, { schema: z }),
}))

const localFiles = (await import("../opencode-runtime/tools/local_files")).default as any

type ToolResult = { title: string; output: string }
const parse = (r: unknown): any => JSON.parse((r as ToolResult).output)
const ctx = { sessionID: "ses_local_files_test" } as any

// ── fetch 注入（绝不出网）──────────────────────────────────────────────
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

function invokeError(code: string, status = 400) {
  return jsonResponse({ ok: false, error: { code, message: `raw:${code}` } }, status)
}

/** invoke 回指定错误码；若码会触发 status 补根，status 端点回 provided device。 */
function withInvokeError(code: string, status: number, device: any = null) {
  handler = (url) =>
    url.includes("/internal/device/status") ? jsonResponse({ ok: true, device }) : invokeError(code, status)
}

const statusCalls = () => calls.filter((c) => c.url.includes("/internal/device/status"))
const invokeCalls = () => calls.filter((c) => c.url.includes("/internal/device/invoke"))

// ── 工具宣告面 ────────────────────────────────────────────────────────
describe("local_files：模型唯一的说明与 args 契约", () => {
  test("description 讲清「使用者自己电脑」、非云端、授权范围、四个 op 与转达引导语", () => {
    const d: string = localFiles.description
    expect(d).toContain("使用者自己电脑上")
    expect(d).toContain("不是云端工作区")
    expect(d).toContain("明确授权过的资料夹")
    for (const op of ["list_dir", "read_file", "grep", "stat"]) expect(d).toContain(op)
    expect(d).toContain("照实转达")
  })

  test("args：op 恰好接受四个值并拒第五个；path 必填、pattern/max_bytes/limit 选填", () => {
    for (const op of ["list_dir", "read_file", "grep", "stat"]) {
      expect(localFiles.args.op.safeParse(op).success).toBe(true)
    }
    expect(localFiles.args.op.safeParse("write_file").success).toBe(false)
    expect(localFiles.args.path.safeParse(undefined).success).toBe(false)
    for (const k of ["pattern", "max_bytes", "limit"]) {
      expect(localFiles.args[k].safeParse(undefined).success).toBe(true)
    }
  })

  test("不支援的 op 本地挡下，且不打网路", async () => {
    const r = parse(await localFiles.execute({ op: "write_file", path: "/x" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("bad_request")
    expect(calls.length).toBe(0)
  })
})

// ── 错误码 → 引导语 ───────────────────────────────────────────────────
describe("local_files：错误码映射成面向使用者的繁中引导语", () => {
  test("no_device_registered → 桌面版／对话内授权引导；不呼叫 status", async () => {
    withInvokeError("no_device_registered", 404)
    const r = parse(await localFiles.execute({ op: "list_dir", path: "/x" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("no_device_registered")
    expect(r.error.hint).toContain("桌面版")
    expect(r.error.hint).toContain("授权")
    expect(r.error.hint).toContain("对话")
    expect(r.error.hint).not.toContain("设定") // 设定→本机档案 页面已移除，引导不得再指向它
    expect(statusCalls().length).toBe(0)
  })

  test("device_offline → 请开启桌面版；并补上目前授权的资料夹（root 并入）", async () => {
    withInvokeError("device_offline", 404, {
      online: false,
      roots: ["/home/u/project", "/home/u/Downloads"],
      last_heartbeat_ms: 1,
    })
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/Downloads/a.txt" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("device_offline")
    expect(r.error.hint).toContain("桌面版")
    expect(r.error.hint).toContain("目前已授权的资料夹")
    expect(r.error.hint).toContain("/home/u/project")
    expect(r.error.hint).toContain("/home/u/Downloads")
    expect(statusCalls().length).toBe(1)
    expect(statusCalls()[0].url).toContain("session_id=ses_local_files_test")
  })

  test("device_offline：status 失败时不影响主引导语（不夹 root）", async () => {
    handler = (url) =>
      url.includes("/internal/device/status")
        ? jsonResponse({ ok: false, error: { code: "internal_error" } }, 500)
        : invokeError("device_offline", 404)
    const r = parse(await localFiles.execute({ op: "stat", path: "/x" } as any, ctx))
    expect(r.error.code).toBe("device_offline")
    expect(r.error.hint).toContain("桌面版目前没连上")
    expect(r.error.hint).not.toContain("已授权的资料夹")
  })

  test("path_not_authorized → 授权范围引导；device 为 null 时显示尚未授权任何资料夹", async () => {
    withInvokeError("path_not_authorized", 403, null)
    const r = parse(await localFiles.execute({ op: "read_file", path: "/etc/passwd" } as any, ctx))
    expect(r.error.code).toBe("path_not_authorized")
    expect(r.error.hint).toContain("不在你已授权的资料夹内")
    expect(r.error.hint).toContain("目前尚未授权任何资料夹")
    expect(statusCalls().length).toBe(1)
  })

  test("device_ambiguous → 请只保留一台", async () => {
    withInvokeError("device_ambiguous", 409)
    const r = parse(await localFiles.execute({ op: "stat", path: "/x" } as any, ctx))
    expect(r.error.code).toBe("device_ambiguous")
    expect(r.error.hint).toContain("多台装置")
    expect(r.error.hint).toContain("只保留一台")
    expect(statusCalls().length).toBe(0)
  })

  test("device_timeout → 装置未在时间内回应", async () => {
    withInvokeError("device_timeout", 504)
    const r = parse(await localFiles.execute({ op: "grep", path: "/x", pattern: "a" } as any, ctx))
    expect(r.error.code).toBe("device_timeout")
    expect(r.error.hint).toContain("时间内回应")
  })

  test("sensitive_path → 敏感位置不读取", async () => {
    withInvokeError("sensitive_path", 403)
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/.ssh/id_rsa" } as any, ctx))
    expect(r.error.code).toBe("sensitive_path")
    expect(r.error.hint).toContain("敏感位置")
    expect(statusCalls().length).toBe(0)
  })

  test("其余错误码原样带出，不吞 message", async () => {
    for (const code of ["session_unknown", "bad_request", "tool_not_allowed", "internal_error", "weird_code"]) {
      calls.length = 0
      withInvokeError(code, 400)
      const r = parse(await localFiles.execute({ op: "stat", path: "/x" } as any, ctx))
      expect(r.ok).toBe(false)
      expect(r.error.code).toBe(code)
      expect(r.error.hint).toContain(`raw:${code}`)
      expect(statusCalls().length).toBe(0)
    }
  })
})

// ── 成功路径 ──────────────────────────────────────────────────────────
describe("local_files：成功路径带出 result / truncated / bytes", () => {
  test("read_file 成功：result 原样回传、bytes 带出、truncated=false 不加截断提醒", async () => {
    handler = () =>
      jsonResponse({
        ok: true,
        request_id: "req_1",
        tool: "read_file",
        result: { path: "/home/u/project/a.txt", text: "hello" },
        truncated: false,
        bytes: 5,
      })
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/project/a.txt" } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.op).toBe("read_file")
    expect(r.result.text).toBe("hello")
    expect(r.bytes).toBe(5)
    expect(r.truncated).toBe(false)
    expect(r.note).toBeUndefined()
    // 只打一次 invoke，不打 status
    expect(invokeCalls().length).toBe(1)
    expect(statusCalls().length).toBe(0)
  })

  test("truncated=true：附上截断提醒", async () => {
    handler = () =>
      jsonResponse({ ok: true, result: { path: "/a", text: "…" }, truncated: true, bytes: 262144 })
    const r = parse(await localFiles.execute({ op: "read_file", path: "/a" } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.note).toContain("截断")
  })

  test("args 依 op 正确下发：grep 带 pattern/max_bytes、read_file 带 limit、list_dir 只带 path", async () => {
    handler = () => jsonResponse({ ok: true, result: {}, truncated: false })
    await localFiles.execute({ op: "grep", path: "/p", pattern: "foo", max_bytes: 4096 } as any, ctx)
    expect(JSON.parse(invokeCalls()[0].init.body)).toEqual({
      op: "grep",
      path: "/p",
      pattern: "foo",
      max_bytes: 4096,
    })

    calls.length = 0
    await localFiles.execute({ op: "read_file", path: "/p/a", limit: 128 } as any, ctx)
    expect(JSON.parse(invokeCalls()[0].init.body)).toEqual({ op: "read_file", path: "/p/a", limit: 128 })

    calls.length = 0
    await localFiles.execute({ op: "list_dir", path: "/p" } as any, ctx)
    expect(JSON.parse(invokeCalls()[0].init.body)).toEqual({ op: "list_dir", path: "/p" })
  })

  test("全程只打注入的 fetch，位址仅指向 gateway 的 internal 端点，绝不出网", async () => {
    handler = () => jsonResponse({ ok: true, result: {}, truncated: false })
    await localFiles.execute({ op: "stat", path: "/p/a" } as any, ctx)
    withInvokeError("device_offline", 404, { online: false, roots: [] })
    await localFiles.execute({ op: "stat", path: "/p/a" } as any, ctx)
    expect(calls.length).toBe(3) // invoke + invoke + status
    for (const c of calls) {
      expect(c.url.startsWith("http://127.0.0.1:8081/internal/device/")).toBe(true)
    }
  })
})

// ── needs_authorization：对话内授权引导（新契约，2026-10-04）────────────
describe("local_files：needs_authorization 回结构化授权引导（不当失败）", () => {
  const needsAuth = (reason = "outside_roots") =>
    jsonResponse({
      ok: false,
      error: {
        code: "needs_authorization",
        message: "此路径尚未授权。",
        root: "/home/u/Downloads",
        reason,
        options: [{ scope: "once" }, { scope: "session" }, { scope: "permanent" }],
      },
    })

  test("回 ok=true 结构化结果：op/path/root/reason 与三段式逐字文案、指令句", async () => {
    handler = () => needsAuth()
    const r = parse(await localFiles.execute({ op: "list_dir", path: "/home/u/Downloads/x" } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.action_required).toBe("authorize_local_files")
    expect(r.op).toBe("list_dir")
    expect(r.path).toBe("/home/u/Downloads/x")
    expect(r.root).toBe("/home/u/Downloads")
    expect(r.reason).toBe("outside_roots")
    expect(r.options.map((o: any) => o.scope)).toEqual(["once", "session", "permanent"])
    expect(r.options.map((o: any) => o.label)).toEqual([
      "允许一次",
      "本会话允许此目录",
      "永久允许（加入本机授权清单）",
    ])
    expect(r.instruction).toBe(
      "把上面三个选项原样列给使用者，等他回答后再呼叫 local_files_authorize；不要自行决定。",
    )
    // 不打 status（授权引导不需要目前根清单）
    expect(statusCalls().length).toBe(0)
    expect(invokeCalls().length).toBe(1)
  })

  test("结果不得含任何『自动允许／自动授权』暗示；指令句要求等他回答、不要自行决定", async () => {
    handler = () => needsAuth("mode_ask")
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/D/a.txt" } as any, ctx))
    const blob = JSON.stringify(r)
    for (const w of ["自动允许", "auto_allow", "自动授权", "已授权"]) expect(blob).not.toContain(w)
    expect(r.instruction).toContain("等他回答")
    expect(r.instruction).toContain("不要自行决定")
  })

  test("description 讲明 needs_authorization 的正确行为与不得自行选 permanent", () => {
    const d: string = localFiles.description
    expect(d).toContain("needs_authorization")
    expect(d).toContain("逐字")
    expect(d).toContain("等他明确选一个")
    expect(d).toContain("不得未经同意选 permanent")
  })

  test("reason=denylist 不走 needs_authorization：sensitive_path 回硬错且说不能授权", async () => {
    withInvokeError("sensitive_path", 403)
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/.ssh/id_rsa" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.action_required).toBeUndefined()
    expect(r.error.code).toBe("sensitive_path")
    expect(r.error.hint).toContain("硬性禁止")
    expect(r.error.hint).toContain("不能授权")
    expect(statusCalls().length).toBe(0)
  })
})