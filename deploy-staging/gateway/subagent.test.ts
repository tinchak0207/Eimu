// subagent.ts 修復單元測試（2026-10-02）
// 修 1：critic 被並發上限擠掉時入隊、槽位釋放後補跑；verdict（含 PASS）回灌父會話。
// 修 2：subagent_status 精確查詢——完整 run id 精確命中 / label 多前綴回候選 / 零命中 404。
// D2（2026-10-02）：派工錯誤必帶 code 與缺欄清單；D4：latest 別名 + not_found 附最近 run。
// 全程 mock globalThis.fetch，不依賴真實網路或上游；完成的 run 之落盤檔在 afterAll 精確清除。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { CRITIC_PASS_MARK } from "./delivery-gate"
import {
  handleSubagentDispatch,
  handleSubagentEvent,
  handleSubagentStatus,
  initSubagent,
  maybeRunMachineCriticPass,
  handleLoopBreaker,
} from "./subagent.ts"

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
    try {
      agent = (JSON.parse(init?.body ?? "{}") as { agent?: string }).agent ?? ""
    } catch {
      agent = ""
    }
    if (cid) childKind.set(cid, agent)
    return json({})
  }
  if (url.includes("/abort")) return json({})
  if (method === "DELETE") return json({})
  if (url.includes("/message")) {
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
    emitToSession: () => {},
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
