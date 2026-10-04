// local_files 工具契約測試（W6 本機檔案橋的雲端側工具）。
//
// 測試對象是 opencode-runtime 的唯一真源 `tools/local_files.ts`。
// 本機沒有 `@opencode-ai/plugin`（只裝在生產 VPS），故用 `mock.module` 注入
// 等價的 `tool`（identity + schema=zod，與 plugin/dist/tool.js 逐字同形），
// 讓本檔可在**不連 VPS**的前提下本地跑；fetch 全程以注入的 mock 取代，
// 絕不連 127.0.0.1:8081（更不會碰任何真實裝置）。
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { z } from "zod"

mock.module("@opencode-ai/plugin/tool", () => ({
  tool: Object.assign((input: unknown) => input, { schema: z }),
}))

const localFiles = (await import("../opencode-runtime/tools/local_files")).default as any

type ToolResult = { title: string; output: string }
const parse = (r: unknown): any => JSON.parse((r as ToolResult).output)
const ctx = { sessionID: "ses_local_files_test" } as any

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

function invokeError(code: string, status = 400) {
  return jsonResponse({ ok: false, error: { code, message: `raw:${code}` } }, status)
}

/** invoke 回指定錯誤碼；若碼會觸發 status 補根，status 端點回 provided device。 */
function withInvokeError(code: string, status: number, device: any = null) {
  handler = (url) =>
    url.includes("/internal/device/status") ? jsonResponse({ ok: true, device }) : invokeError(code, status)
}

const statusCalls = () => calls.filter((c) => c.url.includes("/internal/device/status"))
const invokeCalls = () => calls.filter((c) => c.url.includes("/internal/device/invoke"))

// ── 工具宣告面 ────────────────────────────────────────────────────────
describe("local_files：模型唯一的說明與 args 契約", () => {
  test("description 講清「使用者自己電腦」、非雲端、授權範圍、四個 op 與轉達引導語", () => {
    const d: string = localFiles.description
    expect(d).toContain("使用者自己電腦上")
    expect(d).toContain("不是雲端工作區")
    expect(d).toContain("明確授權過的資料夾")
    for (const op of ["list_dir", "read_file", "grep", "stat"]) expect(d).toContain(op)
    expect(d).toContain("照實轉達")
  })

  test("args：op 恰好接受四個值並拒第五個；path 必填、pattern/max_bytes/limit 選填", () => {
    for (const op of ["list_dir", "read_file", "grep", "stat"]) {
      expect(localFiles.args.op.safeParse(op).success).toBe(true)
    }
    expect(localFiles.args.op.safeParse("write_file").success).toBe(false)
    expect(localFiles.args.path.safeParse(undefined).success).toBe(false)
    for (const k of ["pattern", "max_bytes", "limit"]) {
      expect(localFiles.args[k].safeParse(undefined).success).toBe(true)
    }
  })

  test("不支援的 op 本地擋下，且不打網路", async () => {
    const r = parse(await localFiles.execute({ op: "write_file", path: "/x" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("bad_request")
    expect(calls.length).toBe(0)
  })
})

// ── 錯誤碼 → 引導語 ───────────────────────────────────────────────────
describe("local_files：錯誤碼映射成面向使用者的繁中引導語", () => {
  test("no_device_registered → 桌面版／對話內授權引導；不呼叫 status", async () => {
    withInvokeError("no_device_registered", 404)
    const r = parse(await localFiles.execute({ op: "list_dir", path: "/x" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("no_device_registered")
    expect(r.error.hint).toContain("桌面版")
    expect(r.error.hint).toContain("授權")
    expect(r.error.hint).toContain("對話")
    expect(r.error.hint).not.toContain("設定") // 設定→本機檔案 頁面已移除，引導不得再指向它
    expect(statusCalls().length).toBe(0)
  })

  test("device_offline → 請開啟桌面版；並補上目前授權的資料夾（root 併入）", async () => {
    withInvokeError("device_offline", 404, {
      online: false,
      roots: ["/home/u/project", "/home/u/Downloads"],
      last_heartbeat_ms: 1,
    })
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/Downloads/a.txt" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("device_offline")
    expect(r.error.hint).toContain("桌面版")
    expect(r.error.hint).toContain("目前已授權的資料夾")
    expect(r.error.hint).toContain("/home/u/project")
    expect(r.error.hint).toContain("/home/u/Downloads")
    expect(statusCalls().length).toBe(1)
    expect(statusCalls()[0].url).toContain("session_id=ses_local_files_test")
  })

  test("device_offline：status 失敗時不影響主引導語（不夾 root）", async () => {
    handler = (url) =>
      url.includes("/internal/device/status")
        ? jsonResponse({ ok: false, error: { code: "internal_error" } }, 500)
        : invokeError("device_offline", 404)
    const r = parse(await localFiles.execute({ op: "stat", path: "/x" } as any, ctx))
    expect(r.error.code).toBe("device_offline")
    expect(r.error.hint).toContain("桌面版目前沒連上")
    expect(r.error.hint).not.toContain("已授權的資料夾")
  })

  test("path_not_authorized → 授權範圍引導；device 為 null 時顯示尚未授權任何資料夾", async () => {
    withInvokeError("path_not_authorized", 403, null)
    const r = parse(await localFiles.execute({ op: "read_file", path: "/etc/passwd" } as any, ctx))
    expect(r.error.code).toBe("path_not_authorized")
    expect(r.error.hint).toContain("不在你已授權的資料夾內")
    expect(r.error.hint).toContain("目前尚未授權任何資料夾")
    expect(statusCalls().length).toBe(1)
  })

  test("device_ambiguous → 請只保留一台", async () => {
    withInvokeError("device_ambiguous", 409)
    const r = parse(await localFiles.execute({ op: "stat", path: "/x" } as any, ctx))
    expect(r.error.code).toBe("device_ambiguous")
    expect(r.error.hint).toContain("多台裝置")
    expect(r.error.hint).toContain("只保留一台")
    expect(statusCalls().length).toBe(0)
  })

  test("device_timeout → 裝置未在時間內回應", async () => {
    withInvokeError("device_timeout", 504)
    const r = parse(await localFiles.execute({ op: "grep", path: "/x", pattern: "a" } as any, ctx))
    expect(r.error.code).toBe("device_timeout")
    expect(r.error.hint).toContain("時間內回應")
  })

  test("sensitive_path → 敏感位置不讀取", async () => {
    withInvokeError("sensitive_path", 403)
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/.ssh/id_rsa" } as any, ctx))
    expect(r.error.code).toBe("sensitive_path")
    expect(r.error.hint).toContain("敏感位置")
    expect(statusCalls().length).toBe(0)
  })

  test("其餘錯誤碼原樣帶出，不吞 message", async () => {
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

// ── 成功路徑 ──────────────────────────────────────────────────────────
describe("local_files：成功路徑帶出 result / truncated / bytes", () => {
  test("read_file 成功：result 原樣回傳、bytes 帶出、truncated=false 不加截斷提醒", async () => {
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

  test("truncated=true：附上截斷提醒", async () => {
    handler = () =>
      jsonResponse({ ok: true, result: { path: "/a", text: "…" }, truncated: true, bytes: 262144 })
    const r = parse(await localFiles.execute({ op: "read_file", path: "/a" } as any, ctx))
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.note).toContain("截斷")
  })

  test("args 依 op 正確下發：grep 帶 pattern/max_bytes、read_file 帶 limit、list_dir 只帶 path", async () => {
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

  test("全程只打注入的 fetch，位址僅指向 gateway 的 internal 端點，絕不出網", async () => {
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

// ── needs_authorization：對話內授權引導（新契約，2026-10-04）────────────
describe("local_files：needs_authorization 回結構化授權引導（不當失敗）", () => {
  const needsAuth = (reason = "outside_roots") =>
    jsonResponse({
      ok: false,
      error: {
        code: "needs_authorization",
        message: "此路徑尚未授權。",
        root: "/home/u/Downloads",
        reason,
        options: [{ scope: "once" }, { scope: "session" }, { scope: "permanent" }],
      },
    })

  test("回 ok=true 結構化結果：op/path/root/reason 與三段式逐字文案、指令句", async () => {
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
      "允許一次",
      "本會話允許此目錄",
      "永久允許（加入本機授權清單）",
    ])
    expect(r.instruction).toBe(
      "把上面三個選項原樣列給使用者，等他回答後再呼叫 local_files_authorize；不要自行決定。",
    )
    // 不打 status（授權引導不需要目前根清單）
    expect(statusCalls().length).toBe(0)
    expect(invokeCalls().length).toBe(1)
  })

  test("結果不得含任何『自動允許／自動授權』暗示；指令句要求等他回答、不要自行決定", async () => {
    handler = () => needsAuth("mode_ask")
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/D/a.txt" } as any, ctx))
    const blob = JSON.stringify(r)
    for (const w of ["自動允許", "auto_allow", "自動授權", "已授權"]) expect(blob).not.toContain(w)
    expect(r.instruction).toContain("等他回答")
    expect(r.instruction).toContain("不要自行決定")
  })

  test("description 講明 needs_authorization 的正確行為與不得自行選 permanent", () => {
    const d: string = localFiles.description
    expect(d).toContain("needs_authorization")
    expect(d).toContain("逐字")
    expect(d).toContain("等他明確選一個")
    expect(d).toContain("不得未經同意選 permanent")
  })

  test("reason=denylist 不走 needs_authorization：sensitive_path 回硬錯且說不能授權", async () => {
    withInvokeError("sensitive_path", 403)
    const r = parse(await localFiles.execute({ op: "read_file", path: "/home/u/.ssh/id_rsa" } as any, ctx))
    expect(r.ok).toBe(false)
    expect(r.action_required).toBeUndefined()
    expect(r.error.code).toBe("sensitive_path")
    expect(r.error.hint).toContain("硬性禁止")
    expect(r.error.hint).toContain("不能授權")
    expect(statusCalls().length).toBe(0)
  })
})