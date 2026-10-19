// subagent.ts 修复单元测试（2026-10-02）
// 修 1：critic 被并发上限挤掉时入队、槽位释放后补跑；verdict（含 PASS）回灌父会话。
// 修 2：subagent_status 精确查询——完整 run id 精确命中 / label 多前缀回候选 / 零命中 404。
// D2（2026-10-02）：派工错误必带 code 与缺栏清单；D4：latest 别名 + not_found 附最近 run。
// 全程 mock globalThis.fetch，不依赖真实网路或上游；完成的 run 之落盘档在 afterAll 精确清除。
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

// ── 捕获：子代理 done 帧（需求1）、主路径 prompt_async 注入体（需求2）──────────
const emitted: Array<{ name: string; data: any }> = []
const promptBodies: Array<Record<string, unknown>> = []
// 需求1 用：让 /message 回一段可控的「多则 assistant＋tool 噪音」假执行结果。
let messageFixture: unknown[] | null = null

// ── mock fetch：/session 建会话、prompt_async 记角色、message 回文本 ──────────
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

// ── deps 与工具 ─────────────────────────────────────────────────────────────
const parents = new Map<string, { sessionId: string; opencodeSessionId: string; turnGen: number }>()
const wakes: Array<{ id: string; summary: string }> = []

let parentSeq = 0
function makeParent(id: string) {
  // 2026-10-02: parent id 每次执行必须唯一——critic_passes 是持久表，固定 id
  // 会让第二次以后的执行被「每会话 ≤1 次」持久旗标挡住（假失败）。
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
      prompt: "【任务】产出交付物（预期 5 分钟）。",
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

// 精确清除本次测试写入的落盘档（档名规则 = <runId>-<safeLabel>.md）
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
      rmSync(join("/opt/eimu-harness/workspace/outputs/subagent", `${w.id}-${safeLabel(w.label)}.md`), { force: true })
    } catch {
      /* best-effort 清理，不影响测试结果 */
    }
  }
})

// ── 修 2 ─────────────────────────────────────────────────────────────────────
describe("修 2 subagent_status 精确查询", () => {
  test("完整 run id 精确命中该 run（不误回 not_found）", async () => {
    const p = makeParent("gw-fix2-a")
    const a = await dispatch(p, "甲研一")
    await dispatch(p, "甲研二")
    const s = await status(a.subagent_id)
    expect(s.code).toBe(200)
    expect(s.body.done).toBe(false)
    expect(s.body.label).toBe("甲研一")
  })

  test("label 前缀命中多笔 → 回候选清单（每笔含 runId/label/status）", async () => {
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

  test("label 前缀唯一命中 → 回该 run", async () => {
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
    const s = await status("zzz-查无此代理-zzz")
    expect(s.code).toBe(404)
    expect(s.body.ok).toBe(false)
  })
})

// ── 修 1 ─────────────────────────────────────────────────────────────────────
describe("修 1 critic 排队重试 + verdict 回灌", () => {
  test("槽位满→入队；槽位释放→补跑；critic PASS verdict 回灌父会话；只触发一次", async () => {
    const p = makeParent("gw-fix1")
    const filler1 = await dispatch(p, "填充甲")
    await dispatch(p, "填充乙")
    const expert = await dispatch(p, "音乐交付", { expert: "music" })
    // Expert 子会话正常收尾（idle）→ 登记待审 critic 目标、释放一个槽位
    await handleSubagentEvent({ type: "session.idle" }, expert.childId)
    await settle()
    // 补满 3 路并发
    await dispatch(p, "填充丙")
    const beforeQueue = createdChildren.length

    // 槽位满 → critic 不入队即被丢弃的旧行为已修：回 false 且已入队（尚未派遣）
    expect(maybeRunMachineCriticPass(p, false)).toBe(false)
    expect(createdChildren.length).toBe(beforeQueue)

    // 一个在跑代理完成（填充甲 idle）→ 释放槽位 → drain 补跑 critic
    await handleSubagentEvent({ type: "session.idle" }, filler1.childId)
    await settle()
    expect(createdChildren.length).toBe(beforeQueue + 1)

    // 修 2 顺带验证：critic run 可用 label 查到（在跑）
    const st = await status("机器审核")
    expect(st.code).toBe(200)
    expect(st.body.done).toBe(false)
    expect(st.body.label).toBe("机器审核")

    // critic 正常收尾（verdict=PASS）→ 以正常完成仪式回灌父会话
    const criticChild = createdChildren[createdChildren.length - 1]
    expect(childKind.get(criticChild)).toBe("critic")
    const wakesBefore = wakes.length
    await handleSubagentEvent({ type: "session.idle" }, criticChild)
    await settle()
    expect(wakes.length).toBeGreaterThan(wakesBefore)
    const passWake = wakes.find((w) => w.summary.includes(CRITIC_PASS_MARK))
    expect(passWake).toBeTruthy()

    // 只触发一次语义：已用过 pass，再呼叫不再派遣
    expect(maybeRunMachineCriticPass(p, false)).toBe(false)

    // 记录本次确实落盘的档（afterAll 精确清除）
    writtenFiles.push({ id: filler1.subagent_id, label: "填充甲" })
    writtenFiles.push({ id: expert.subagent_id, label: "音乐交付" })
    writtenFiles.push({ id: (st.body.subagent_id as string) ?? "", label: "机器审核" })
  })
})

// ── D4（2026-10-02）：latest 别名 + not_found 附最近 run ──────────────────────
async function statusFor(sessionId: string, id: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const res = await handleSubagentStatus(req("http://gw.test/internal/subagent/status", { session_id: sessionId, subagent_id: id }))
  return { code: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe("D4 latest 别名与过期 id 的可执行回馈", () => {
  test("latest → 取本会话最近一次 run", async () => {
    const p = makeParent("gw-d4-latest")
    await dispatch(p, "D4甲")
    await settle(5)
    const b = await dispatch(p, "D4乙")
    const s = await statusFor(p.sessionId, "latest")
    expect(s.code).toBe(200)
    expect(s.body.done).toBe(false)
    expect(s.body.subagent_id).toBe(b.subagent_id)
  })

  test("本会话零 run → latest 回 404 + code=not_found（不是空话）", async () => {
    const p = makeParent("gw-d4-empty")
    const s = await statusFor(p.sessionId, "latest")
    expect(s.code).toBe(404)
    expect(s.body.code).toBe("not_found")
  })

  test("不存在 id → 404 附 code 与最近 3 笔 run（可直接改用）", async () => {
    const p = makeParent("gw-d4-recent")
    await dispatch(p, "D4近一")
    await dispatch(p, "D4近二")
    const s = await statusFor(p.sessionId, "zzz-查无此代理-zzz")
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

// ── D2（2026-10-02）：派工错误码与缺栏清单 ──────────────────────────────────
describe("D2 派工硬化：失败必带 code 与缺栏", () => {
  test("缺 label/prompt → 400 code=missing_required_args + missing 清单", async () => {
    const res = await handleSubagentDispatch(
      req("http://gw.test/internal/subagent/dispatch", { sessionId: "ses_whatever" }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; missing: string[] }
    expect(body.code).toBe("missing_required_args")
    expect(body.missing).toEqual(["label", "prompt"])
  })

  test("父会话不存在 → 404 code=session_not_found", async () => {
    const res = await handleSubagentDispatch(
      req("http://gw.test/internal/subagent/dispatch", { sessionId: "gw-nonexistent", label: "x", prompt: "y" }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("session_not_found")
  })

  test("并发上限 → code=concurrency_limit 且附在跑清单", async () => {
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

// ── D1（2026-10-02）：回圈断路器收尾端点 ────────────────────────────────────
describe("D1 loop-breaker 端点", () => {
  test("缺 session_id → 400 code=missing_required_args", async () => {
    const res = await handleLoopBreaker(req("http://gw.test/internal/session/loop-breaker", {}))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("missing_required_args")
  })

  test("合法会话 → 中止该会话并回 aborted=true", async () => {
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

// ── 需求1（2026-10-02 能力片）：子代理回传契约收敛 ─────────────────────────────
// 设计取自 Claude Code 同步子代理回传（只取最后一则 assistant 的 text 区块＋用量），
// 未复制其程式码。真值断言：喂「多则 assistant＋中间 tool 噪音」的假执行结果；
// 并验明确字数上限（SUBAGENT_SUMMARY_MAX_CHARS=4000，换行边界截断＋「已截断」提示）。
// 从摘要中剥出「行内正文」：去落盘指标前缀、去截断提示与用量行。
function inlineOf(summary: string): string {
  return summary
    .replace(/^\[[^\]]*\]\s*/, "")
    .split("\n\n[已截断")[0]!
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

describe("需求1 子代理回传契约：最后一则 assistant 文字＋用量计数", () => {
  test("(a) 末则 200 字 → inline 摘要逐字等于它（非全文前 600）＋ usage；既有 done 栏不变", async () => {
    const p = makeParent("gw-req1a")
    const lastText = "Q".repeat(199) + "|END" // 200 字，< 上限 → 不截
    const { a, d } = await runChildAndGetDone(p, "契约甲", [
      // 第一则 assistant：有文字＋一个 tool（旧码「全文」会把它拼进去）
      { info: { role: "assistant", tokens: { input: 100, output: 50 } }, parts: [{ type: "text", text: "第一则：先做准备" }, { type: "tool", tool: "bash", callID: "c0" }] },
      // 中间 tool 噪音：纯 tool、零文字（loop 停在 tool_use 的形态 → 必须回退）
      { info: { role: "assistant", tokens: { input: 1, output: 2 } }, parts: [{ type: "tool", tool: "read", callID: "c1" }] },
      // 最后一则 assistant：真结果（200 字）
      { info: { role: "assistant", tokens: { input: 7, output: 3, cache: { read: 5, write: 0 } } }, parts: [{ type: "text", text: lastText }] },
    ])
    // 既有栏语义一字不变
    expect(d.id).toBe(a.subagent_id)
    expect(d.status).toBe("ok")
    // inline 摘要逐字等于末则讯息；未触发截断
    expect(inlineOf(d.summary)).toBe(lastText)
    expect(d.summary.includes("[已截断")).toBe(false)
    // 第一则文字与中间 tool 噪音不得被拼进摘要（取最后一则，不回顾拼接）
    expect(d.summary.includes("第一则：先做准备")).toBe(false)
    // 用量栏位：tool part 共 2 个；token＝最后一则 assistant 的 input+output+cache
    expect(d.usage?.tool_calls).toBe(2)
    expect(d.usage?.tokens).toBe(15)
    expect(d.usage?.duration_ms).toBeGreaterThanOrEqual(0)
    // 键集比对：既有三键必在；其余只能是允许的新/可选键（一字不改既有栏名）
    const keys = Object.keys(d)
    expect(keys).toContain("id")
    expect(keys).toContain("status")
    expect(keys).toContain("summary")
    for (const k of keys) expect(["id", "status", "summary", "delivery_gate", "usage"]).toContain(k)
  })

  test("(b) 末则 12,000+ 字 → inline 摘要 ≤4000＋截断提示，且含该则开头（证明取末则）", async () => {
    const p = makeParent("gw-req1b")
    // 每行 ~98 字、150 行 ≈ 14,700 字，远超 4000；带换行让截断发生在换行边界。
    const longText = Array.from({ length: 150 }, (_, i) => `LINE${i}-` + "X".repeat(90)).join("\n")
    expect(longText.length).toBeGreaterThan(12000)
    const { d } = await runChildAndGetDone(p, "契约乙", [
      { info: { role: "assistant", tokens: { input: 10, output: 5 } }, parts: [{ type: "text", text: longText }] },
    ])
    const inline = inlineOf(d.summary)
    expect(inline.length).toBeLessThanOrEqual(4000)
    expect(d.summary.includes("[已截断")).toBe(true)
    // 取的是「末则」的开头（不是别的讯息、不是尾部）
    expect(inline.startsWith("LINE0-")).toBe(true)
    expect(longText.startsWith(inline)).toBe(true)
    // 截断提示带实际被截字数
    expect(d.summary).toMatch(/\[已截断 \d+ 字元；完整结果见落盘指标\]/)
  })
})

// ── 需求2（2026-10-02 能力片）：错误讯息即模型上下文（真事件序列＋真 emit 路径）────
// 「模型可见 but 使用者不可见」的通道＝既有 prompt_async 文本 part（opencode 存成
// user-role message）。此处驱动 handleOpencodeEvent 真序列，并用真 emitToSession 的
// 客户端 enqueue 验证注入文本不会上使用者流。
describe("需求2 failover 注入：串流中断续写＋孤儿 tool_use 补 is_error", () => {
  test("中断＋在跑工具 → prompt_async 注入续写指示与孤儿补注；使用者流不含注入", async () => {
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
      lastPromptBody: { parts: [{ type: "text", text: "原始任务" }] },
    }
    sessions.set(state.sessionId, state)

    // (0) control：assistant 正文确实会上使用者流（证明后面的「不含」不是管线坏掉）
    handleOpencodeEvent({ type: "message.updated", properties: { sessionID: oc, info: { id: "ma", role: "assistant" } } })
    handleOpencodeEvent({ type: "message.part.updated", properties: { sessionID: oc, part: { type: "text", id: "pa", messageID: "ma", text: "可见正文\n" } } })
    expect(clientFrames.some((f) => f.includes("event: message.delta") && f.includes("可见正文"))).toBe(true)

    // (1) 真事件序列：assistant 起一个工具（running，未完成）→ 上游错误 → idle 收尾
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
    // failover 走 TURN_RETRY_DELAY_MS（预设 1500ms）后才投递 prompt_async
    await settle(2300)

    // (a) 注入内容正确（模型可见）
    const injected = promptBodies.slice(before).find((b) => JSON.stringify(b).includes(CONTINUATION_DIRECTIVE_MARK))
    expect(injected).toBeTruthy()
    const injectedText = String((injected!.parts as Array<{ text?: string }>)[0]?.text ?? "")
    expect(injectedText.includes(CONTINUATION_DIRECTIVE_MARK)).toBe(true)
    expect(injectedText.includes(ORPHAN_TOOL_USE_MARK)).toBe(true)
    expect(injectedText.includes("bash")).toBe(true)
    expect(injectedText.includes("call_x")).toBe(true)

    // (b) 使用者可见流不含它——喂入「注入讯息（user-role）」的真事件，真 emit 路径必须挡掉
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
