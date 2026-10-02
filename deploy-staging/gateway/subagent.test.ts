// subagent.ts 修復單元測試（2026-10-02）
// 修 1：critic 被並發上限擠掉時入隊、槽位釋放後補跑；verdict（含 PASS）回灌父會話。
// 修 2：subagent_status 精確查詢——完整 run id 精確命中 / label 多前綴回候選 / 零命中 404。
// D2（2026-10-02）：派工錯誤必帶 code 與缺欄清單；D4：latest 別名 + not_found 附最近 run。
// 全程 mock globalThis.fetch，不依賴真實網路或上游；完成的 run 之落盤檔在 afterAll 精確清除。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { CRITIC_PASS_MARK } from "./delivery-gate"
import { CONTINUATION_DIRECTIVE_MARK, ORPHAN_TOOL_USE_MARK } from "./error-classify.ts"
import {
  handleSubagentDispatch,
  handleSubagentEvent,
  handleSubagentStatus,
  initSubagent,
  maybeRunMachineCriticPass,
  handleLoopBreaker,
} from "./subagent.ts"
import { handleOpencodeEvent } from "./opencode-event-handler.ts"
import { sessions } from "./sessions-core.ts"

// ── 捕獲：子代理 done 幀（需求1）、主路徑 prompt_async 注入體（需求2）──────────
const emitted: Array<{ name: string; data: any }> = []
const promptBodies: Array<Record<string, unknown>> = []
// 需求1 用：讓 /message 回一段可控的「多則 assistant＋tool 噪音」假執行結果。
let messageFixture: unknown[] | null = null

// ── mock fetch：/session 建會話、prompt_async 記角色、message 回文本 ──────────
const realFetch = globalThis.fetch
const childKind = new Map<string, string>()
const createdChildren: string[] = []
let sessionSeq = 0

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}
function childOf(url: string): string | undefined {
  return /\/session\/(ses_[^/]+)/.exec(url)?.[1]
}
function assistantText(kind: string | undefined): string {
  if (kind === "music") {
    return "emotion_contract: 温暖\nlyrics: 歌词\nmelody_notation: 1 2 3\naudio_url: file:///m/1.mp3\nduration_source: ffprobe\nqc: ok"
  }
  if (kind === "critic") {
    return "verdict：通过\nissues：[]\nevidence：逐栏核验完毕\nqc：签名"
  }
  return "填充完成"
}

globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input)
  const method = (init?.method ?? "GET").toUpperCase()
  if (method === "POST" && /\/session$/.test(url)) {
    sessionSeq += 1
    const id = `ses_test_${sessionSeq}`
    createdChildren.push(id)
    return json({ id })
  }
  if (url.includes("/prompt_async")) {
    const cid = childOf(url)
    let agent = ""
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
      agent = (parsed.agent as string) ?? ""
    } catch {
      agent = ""
    }
    promptBodies.push(parsed)
    if (cid) childKind.set(cid, agent)
    return json({})
  }
  if (url.includes("/abort")) return json({})
  if (method === "DELETE") return json({})
  if (url.includes("/message")) {
    if (messageFixture) return json(messageFixture)
    const cid = childOf(url)
    return json([{ info: { role: "assistant" }, parts: [{ type: "text", text: assistantText(cid ? childKind.get(cid) : undefined) }] }])
  }
  return json({})
}) as typeof fetch

// ── deps 與工具 ─────────────────────────────────────────────────────────────
const parents = new Map<string, { sessionId: string; opencodeSessionId: string; turnGen: number }>()
const wakes: Array<{ id: string; summary: string }> = []

let parentSeq = 0
function makeParent(id: string) {
  // 2026-10-02: parent id 每次執行必須唯一——critic_passes 是持久表，固定 id
  // 會讓第二次以後的執行被「每會話 ≤1 次」持久旗標擋住（假失敗）。
  const sid = `${id}-${Date.now().toString(36)}-${(parentSeq++).toString(36)}`
  const p = { sessionId: sid, opencodeSessionId: `ses_parent_${sid}`, turnGen: 1 }
  parents.set(sid, p)
  return p
}
function req(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}
async function dispatch(
  p: { sessionId: string },
  label: string,
  extra: Record<string, unknown> = {},
): Promise<{ subagent_id: string; label: string; childId: string }> {
  const before = createdChildren.length
  const res = await handleSubagentDispatch(
    req("http://gw.test/internal/subagent/dispatch", {
      sessionId: p.sessionId,
      label,
      prompt: "【任務】产出交付物（预期 5 分钟）。",
      async: true,
      ...extra,
    }),
  )
  const body = (await res.json()) as { subagent_id: string; label: string }
  return { ...body, childId: createdChildren[before] }
}
async function status(id: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = await handleSubagentStatus(req("http://gw.test/internal/subagent/status", { session_id: "x", subagent_id: id }))
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function settle(ms = 25): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

// 精確清除本次測試寫入的落盤檔（檔名規則 = <runId>-<safeLabel>.md）
const writtenFiles: Array<{ id: string; label: string }> = []
function safeLabel(label: string): string {
  return label.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 40) || "subagent"
}

beforeAll(() => {
  initSubagent({
    emitToSession: (_state: unknown, name: string, data: unknown) => {
      emitted.push({ name, data })
    },
    resolveSession: (id: string) => parents.get(id),
    findSessionByOpenCodeId: (oc: string) => [...parents.values()].find((p) => p.opencodeSessionId === oc),
    openCodeUrl: "http://gw.test",
    openCodeHeaders: () => ({}),
    describeError: (e: unknown) => String(e),
    subagentModelChain: () => [{ providerID: "p", modelID: "m" }],
    beastMode: () => true,
    wakeParent: (_state: unknown, run: { id: string; summary: string }) => {
      wakes.push({ id: run.id, summary: run.summary })
    },
  })
})

afterAll(() => {
  globalThis.fetch = realFetch
  for (const w of writtenFiles) {
    try {
      rmSync(join("/opt/agent-harness/workspace/outputs/subagent", `${w.id}-${safeLabel(w.label)}.md`), { force: true })
    } catch {
      /* best-effort 清理，不影響測試結果 */
    }
  }
})

// ── 修 2 ─────────────────────────────────────────────────────────────────────
describe("修 2 subagent_status 精確查詢", () => {
  test("完整 run id 精確命中該 run（不誤回 not_found）", async () => {
    const p = makeParent("gw-fix2-a")
    const a = await dispatch(p, "甲研一")
    await dispatch(p, "甲研二")
    const s = await status(a.subagent_id)
    expect(s.code).toBe(200)
    expect(s.body.done).toBe(false)
    expect(s.body.label).toBe("甲研一")
  })

  test("label 前綴命中多筆 → 回候選清單（每筆含 runId/label/status）", async () => {
    const p = makeParent("gw-fix2-b")
    await dispatch(p, "丙研一")
    await dispatch(p, "丙研二")
    await dispatch(p, "丁写作")
    const s = await status("丙研")
    expect(s.code).toBe(200)
    expect(s.body.multiple).toBe(true)
    const cands = s.body.candidates as Array<{ runId: string; label: string; status: string }>
    expect(cands.length).toBe(2)
    for (const c of cands) {
      expect(typeof c.runId).toBe("string")
      expect(c.label.startsWith("丙研")).toBe(true)
      expect(c.status).toBe("running")
    }
  })

  test("label 前綴唯一命中 → 回該 run", async () => {
    const p = makeParent("gw-fix2-c")
    await dispatch(p, "戊写作")
    await dispatch(p, "庚研究")
    const s = await status("戊写作")
    expect(s.code).toBe(200)
    expect(s.body.multiple).toBeUndefined()
    expect(s.body.done).toBe(false)
    expect(s.body.label).toBe("戊写作")
  })

  test("真正零命中 → not_found(404)", async () => {
    const p = makeParent("gw-fix2-d")
    await dispatch(p, "辛研一")
    const s = await status("zzz-查無此代理-zzz")
    expect(s.code).toBe(404)
    expect(s.body.ok).toBe(false)
  })
})

// ── 修 1 ─────────────────────────────────────────────────────────────────────
describe("修 1 critic 排隊重試 + verdict 回灌", () => {
  test("槽位滿→入隊；槽位釋放→補跑；critic PASS verdict 回灌父會話；只觸發一次", async () => {
    const p = makeParent("gw-fix1")
    const filler1 = await dispatch(p, "填充甲")
    await dispatch(p, "填充乙")
    const expert = await dispatch(p, "音乐交付", { expert: "music" })
    // Expert 子會話正常收尾（idle）→ 登記待審 critic 目標、釋放一個槽位
    await handleSubagentEvent({ type: "session.idle" }, expert.childId)
    await settle()
    // 補滿 3 路並發
    await dispatch(p, "填充丙")
    const beforeQueue = createdChildren.length

    // 槽位滿 → critic 不入隊即被丟棄的舊行為已修：回 false 且已入隊（尚未派遣）
    expect(maybeRunMachineCriticPass(p, false)).toBe(false)
    expect(createdChildren.length).toBe(beforeQueue)

    // 一個在跑代理完成（填充甲 idle）→ 釋放槽位 → drain 補跑 critic
    await handleSubagentEvent({ type: "session.idle" }, filler1.childId)
    await settle()
    expect(createdChildren.length).toBe(beforeQueue + 1)

    // 修 2 順帶驗證：critic run 可用 label 查到（在跑）
    const st = await status("机器审核")
    expect(st.code).toBe(200)
    expect(st.body.done).toBe(false)
    expect(st.body.label).toBe("机器审核")

    // critic 正常收尾（verdict=PASS）→ 以正常完成儀式回灌父會話
    const criticChild = createdChildren[createdChildren.length - 1]
    expect(childKind.get(criticChild)).toBe("critic")
    const wakesBefore = wakes.length
    await handleSubagentEvent({ type: "session.idle" }, criticChild)
    await settle()
    expect(wakes.length).toBeGreaterThan(wakesBefore)
    const passWake = wakes.find((w) => w.summary.includes(CRITIC_PASS_MARK))
    expect(passWake).toBeTruthy()

    // 只觸發一次語義：已用過 pass，再呼叫不再派遣
    expect(maybeRunMachineCriticPass(p, false)).toBe(false)

    // 記錄本次確實落盤的檔（afterAll 精確清除）
    writtenFiles.push({ id: filler1.subagent_id, label: "填充甲" })
    writtenFiles.push({ id: expert.subagent_id, label: "音乐交付" })
    writtenFiles.push({ id: (st.body.subagent_id as string) ?? "", label: "机器审核" })
  })
})

// ── D4（2026-10-02）：latest 別名 + not_found 附最近 run ──────────────────────
async function statusFor(sessionId: string, id: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = await handleSubagentStatus(req("http://gw.test/internal/subagent/status", { session_id: sessionId, subagent_id: id }))
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe("D4 latest 別名與過期 id 的可執行回饋", () => {
  test("latest → 取本會話最近一次 run", async () => {
    const p = makeParent("gw-d4-latest")
    await dispatch(p, "D4甲")
    await settle(5)
    const b = await dispatch(p, "D4乙")
    const s = await statusFor(p.sessionId, "latest")
    expect(s.code).toBe(200)
    expect(s.body.done).toBe(false)
    expect(s.body.subagent_id).toBe(b.subagent_id)
  })

  test("本會話零 run → latest 回 404 + code=not_found（不是空話）", async () => {
    const p = makeParent("gw-d4-empty")
    const s = await statusFor(p.sessionId, "latest")
    expect(s.code).toBe(404)
    expect(s.body.code).toBe("not_found")
  })

  test("不存在 id → 404 附 code 與最近 3 筆 run（可直接改用）", async () => {
    const p = makeParent("gw-d4-recent")
    await dispatch(p, "D4近一")
    await dispatch(p, "D4近二")
    const s = await statusFor(p.sessionId, "zzz-查無此代理-zzz")
    expect(s.code).toBe(404)
    expect(s.body.code).toBe("not_found")
    const recent = s.body.recent_runs as Array<{ id: string; label: string; status: string }>
    expect(Array.isArray(recent)).toBe(true)
    expect(recent.length).toBe(2)
    expect(recent.some((r) => r.label === "D4近一")).toBe(true)
  })

  test("缺 subagent_id → 400 + code=missing_required_args", async () => {
    const s = await statusFor("x", "")
    expect(s.code).toBe(400)
    expect(s.body.code).toBe("missing_required_args")
  })
})

// ── D2（2026-10-02）：派工錯誤碼與缺欄清單 ──────────────────────────────────
describe("D2 派工硬化：失敗必帶 code 與缺欄", () => {
  test("缺 label/prompt → 400 code=missing_required_args + missing 清單", async () => {
    const res = await handleSubagentDispatch(
      req("http://gw.test/internal/subagent/dispatch", { sessionId: "ses_whatever" }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; missing: string[] }
    expect(body.code).toBe("missing_required_args")
    expect(body.missing).toEqual(["label", "prompt"])
  })

  test("父會話不存在 → 404 code=session_not_found", async () => {
    const res = await handleSubagentDispatch(
      req("http://gw.test/internal/subagent/dispatch", { sessionId: "gw-nonexistent", label: "x", prompt: "y" }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("session_not_found")
  })

  test("並發上限 → code=concurrency_limit 且附在跑清單", async () => {
    const p = makeParent("gw-d2-cap")
    await dispatch(p, "塞满甲")
    await dispatch(p, "塞满乙")
    await dispatch(p, "塞满丙")
    const res = await handleSubagentDispatch(
      req("http://gw.test/internal/subagent/dispatch", { sessionId: p.sessionId, label: "第四个", prompt: "任务（预期 5 分钟）" }),
    )
    const body = (await res.json()) as { code: string; running: unknown[] }
    expect(body.code).toBe("concurrency_limit")
    expect(Array.isArray(body.running)).toBe(true)
    expect(body.running.length).toBe(3)
  })
})

// ── D1（2026-10-02）：迴圈斷路器收尾端點 ────────────────────────────────────
describe("D1 loop-breaker 端點", () => {
  test("缺 session_id → 400 code=missing_required_args", async () => {
    const res = await handleLoopBreaker(req("http://gw.test/internal/session/loop-breaker", {}))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("missing_required_args")
  })

  test("合法會話 → 中止該會話並回 aborted=true", async () => {
    const p = makeParent("gw-d1-loop")
    const res = await handleLoopBreaker(
      req("http://gw.test/internal/session/loop-breaker", { session_id: p.sessionId, tool: "bash", count: 9 }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; aborted: boolean }
    expect(body.ok).toBe(true)
    expect(body.aborted).toBe(true)
  })
})

// ── 需求1（2026-10-02 能力片）：子代理回傳契約收斂 ─────────────────────────────
// 設計取自 Claude Code 同步子代理回傳（只取最後一則 assistant 的 text 區塊＋用量），
// 未複製其程式碼。真值斷言：餵「多則 assistant＋中間 tool 噪音」的假執行結果；
// 並驗明確字數上限（SUBAGENT_SUMMARY_MAX_CHARS=4000，換行邊界截斷＋「已截斷」提示）。
// 從摘要中剝出「行內正文」：去落盤指標前綴、去截斷提示與用量行。
function inlineOf(summary: string): string {
  return summary
    .replace(/^\[[^\]]*\]\s*/, "")
    .split("\n\n[已截斷")[0]!
    .split("\n\n[子代理用量]")[0]!
}
async function runChildAndGetDone(p: { sessionId: string }, label: string, fixture: unknown[]) {
  const a = await dispatch(p, label)
  messageFixture = fixture
  emitted.length = 0
  await handleSubagentEvent({ type: "session.idle" }, a.childId)
  await settle(80)
  messageFixture = null
  const done = emitted.find((e) => e.name === "subagent.done")
  expect(done).toBeTruthy()
  const d = done!.data as {
    id: string
    status: string
    summary: string
    usage?: { tool_calls: number; duration_ms: number; tokens: number }
  }
  writtenFiles.push({ id: a.subagent_id, label })
  return { a, d }
}

describe("需求1 子代理回傳契約：最後一則 assistant 文字＋用量計數", () => {
  test("(a) 末則 200 字 → inline 摘要逐字等於它（非全文前 600）＋ usage；既有 done 欄不變", async () => {
    const p = makeParent("gw-req1a")
    const lastText = "Q".repeat(199) + "|END" // 200 字，< 上限 → 不截
    const { a, d } = await runChildAndGetDone(p, "契約甲", [
      // 第一則 assistant：有文字＋一個 tool（舊碼「全文」會把它拼進去）
      { info: { role: "assistant", tokens: { input: 100, output: 50 } }, parts: [{ type: "text", text: "第一則：先做準備" }, { type: "tool", tool: "bash", callID: "c0" }] },
      // 中間 tool 噪音：純 tool、零文字（loop 停在 tool_use 的形態 → 必須回退）
      { info: { role: "assistant", tokens: { input: 1, output: 2 } }, parts: [{ type: "tool", tool: "read", callID: "c1" }] },
      // 最後一則 assistant：真結果（200 字）
      { info: { role: "assistant", tokens: { input: 7, output: 3, cache: { read: 5, write: 0 } } }, parts: [{ type: "text", text: lastText }] },
    ])
    // 既有欄語義一字不變
    expect(d.id).toBe(a.subagent_id)
    expect(d.status).toBe("ok")
    // inline 摘要逐字等於末則訊息；未觸發截斷
    expect(inlineOf(d.summary)).toBe(lastText)
    expect(d.summary.includes("[已截斷")).toBe(false)
    // 第一則文字與中間 tool 噪音不得被拼進摘要（取最後一則，不回顧拼接）
    expect(d.summary.includes("第一則：先做準備")).toBe(false)
    // 用量欄位：tool part 共 2 個；token＝最後一則 assistant 的 input+output+cache
    expect(d.usage?.tool_calls).toBe(2)
    expect(d.usage?.tokens).toBe(15)
    expect(d.usage?.duration_ms).toBeGreaterThanOrEqual(0)
    // 鍵集比對：既有三鍵必在；其餘只能是允許的新/可選鍵（一字不改既有欄名）
    const keys = Object.keys(d)
    expect(keys).toContain("id")
    expect(keys).toContain("status")
    expect(keys).toContain("summary")
    for (const k of keys) expect(["id", "status", "summary", "delivery_gate", "usage"]).toContain(k)
  })

  test("(b) 末則 12,000+ 字 → inline 摘要 ≤4000＋截斷提示，且含該則開頭（證明取末則）", async () => {
    const p = makeParent("gw-req1b")
    // 每行 ~98 字、150 行 ≈ 14,700 字，遠超 4000；帶換行讓截斷發生在換行邊界。
    const longText = Array.from({ length: 150 }, (_, i) => `LINE${i}-` + "X".repeat(90)).join("\n")
    expect(longText.length).toBeGreaterThan(12000)
    const { d } = await runChildAndGetDone(p, "契約乙", [
      { info: { role: "assistant", tokens: { input: 10, output: 5 } }, parts: [{ type: "text", text: longText }] },
    ])
    const inline = inlineOf(d.summary)
    expect(inline.length).toBeLessThanOrEqual(4000)
    expect(d.summary.includes("[已截斷")).toBe(true)
    // 取的是「末則」的開頭（不是別的訊息、不是尾部）
    expect(inline.startsWith("LINE0-")).toBe(true)
    expect(longText.startsWith(inline)).toBe(true)
    // 截斷提示帶實際被截字數
    expect(d.summary).toMatch(/\[已截斷 \d+ 字元；完整結果見落盤指標\]/)
  })
})

// ── 需求2（2026-10-02 能力片）：錯誤訊息即模型上下文（真事件序列＋真 emit 路徑）────
// 「模型可見 but 使用者不可見」的通道＝既有 prompt_async 文本 part（opencode 存成
// user-role message）。此處驅動 handleOpencodeEvent 真序列，並用真 emitToSession 的
// 客戶端 enqueue 驗證注入文本不會上使用者流。
describe("需求2 failover 注入：串流中斷續寫＋孤兒 tool_use 補 is_error", () => {
  test("中斷＋在跑工具 → prompt_async 注入續寫指示與孤兒補注；使用者流不含注入", async () => {
    const oc = "ses_req2_main_1"
    const clientFrames: string[] = []
    const state: any = {
      sessionId: "gw-req2-main",
      opencodeSessionId: oc,
      messageRole: new Map(),
      replayBuffer: [],
      clients: new Set([{ controller: { enqueue: (f: Uint8Array) => clientFrames.push(new TextDecoder().decode(f)) } }]),
      eventCounter: 0,
      suppressedParts: new Set(),
      partTextEmitted: new Map(),
      partStripState: new Map(),
      toolStatusSeen: new Set(),
      toolInvokeSeen: new Set(),
      pendingQuestions: new Set(),
      stepCostLogged: new Set(),
      compactionNotified: new Set(),
      turnTextChars: 0,
      turnReasoningChars: 0,
      turnRetries: 0,
      turnAborted: false,
      lastPromptBody: { parts: [{ type: "text", text: "原始任務" }] },
    }
    sessions.set(state.sessionId, state)

    // (0) control：assistant 正文確實會上使用者流（證明後面的「不含」不是管線壞掉）
    handleOpencodeEvent({ type: "message.updated", properties: { sessionID: oc, info: { id: "ma", role: "assistant" } } })
    handleOpencodeEvent({ type: "message.part.updated", properties: { sessionID: oc, part: { type: "text", id: "pa", messageID: "ma", text: "可见正文\n" } } })
    expect(clientFrames.some((f) => f.includes("event: message.delta") && f.includes("可见正文"))).toBe(true)

    // (1) 真事件序列：assistant 起一個工具（running，未完成）→ 上游錯誤 → idle 收尾
    handleOpencodeEvent({
      type: "message.part.updated",
      properties: {
        sessionID: oc,
        part: { type: "tool", id: "pt", callID: "call_x", tool: "bash", messageID: "ma", state: { status: "running", input: { command: "sleep 100" } } },
      },
    })
    handleOpencodeEvent({ type: "session.error", properties: { sessionID: oc, error: { name: "APIError", data: { message: "upstream stream reset" } } } })
    const before = promptBodies.length
    handleOpencodeEvent({ type: "session.idle", properties: { sessionID: oc } })
    // failover 走 TURN_RETRY_DELAY_MS（預設 1500ms）後才投遞 prompt_async
    await settle(2300)

    // (a) 注入內容正確（模型可見）
    const injected = promptBodies.slice(before).find((b) => JSON.stringify(b).includes(CONTINUATION_DIRECTIVE_MARK))
    expect(injected).toBeTruthy()
    const injectedText = String((injected!.parts as Array<{ text?: string }>)[0]?.text ?? "")
    expect(injectedText.includes(CONTINUATION_DIRECTIVE_MARK)).toBe(true)
    expect(injectedText.includes(ORPHAN_TOOL_USE_MARK)).toBe(true)
    expect(injectedText.includes("bash")).toBe(true)
    expect(injectedText.includes("call_x")).toBe(true)

    // (b) 使用者可見流不含它——餵入「注入訊息（user-role）」的真事件，真 emit 路徑必須擋掉
    const framesBefore = clientFrames.length
    handleOpencodeEvent({ type: "message.updated", properties: { sessionID: oc, info: { id: "inj", role: "user" } } })
    handleOpencodeEvent({ type: "message.part.updated", properties: { sessionID: oc, part: { type: "text", id: "pi", messageID: "inj", text: injectedText } } })
    handleOpencodeEvent({ type: "message.part.delta", properties: { sessionID: oc, field: "text", messageID: "inj", partID: "pi", delta: "续写中" } })
    const frames = clientFrames.slice(framesBefore)
    expect(frames.some((f) => f.includes("event: message.delta"))).toBe(false)
    expect(clientFrames.some((f) => f.includes(CONTINUATION_DIRECTIVE_MARK))).toBe(false)

    sessions.delete(state.sessionId)
  })
})
