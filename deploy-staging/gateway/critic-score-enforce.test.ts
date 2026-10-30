// critic-score-enforce.test.ts（2026-10-03）
//
// 验收：evaluateCriticScoreThreshold（此前生产路径零呼叫）接上机器 critic 判决——
//   (a) 开关 CRITIC_SCORE_ENFORCE 未设 → 即使 measured 低分也不强制（回归保护）。
//   (b) 开关="1" 且 measured 低分 → 走既有 reject→重派链（CRITIC_REJECT_MARK），且每会话
//       只触发一次（既有 critic-pass 硬帽；不新增第二条重派路径、不动 reworkCount）。
//   (c) 来源非 measured（model_self）低分 → 不强制（模型自评非验收 oracle）。
//   (d) 无量测（score=null）→ 不强制（未知≠失败）。
//
// 量测模组以 mock 替换：真实 ffprobe / 媒体下载不进单测。
// DB 路径在 import subagent（连带 persistence）之前指向临时档，不碰生产 sessions.db。

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "critic-score-"))
process.env.SESSIONS_DB_PATH = join(TEST_DB_DIR, "sessions.db")

const MEASURED_MARK = "【技术硬检·measured】"
// 可控量测结果：每个测试设定 mockScore（null＝量测失败/无量测）。
let mockScore: number | null = 3
mock.module("./media-quality.ts", () => ({
  measureMediaScore: async () =>
    mockScore === null ? null : { score: mockScore, detail: `技术分 ${mockScore}/10（mock 硬检）`, artifacts: 1 },
  mediaQualityGateEnabled: () => true,
  MEDIA_QUALITY_MEASURED_MARK: MEASURED_MARK,
}))

const sg = await import("./subagent.ts")
const dg = await import("./delivery-gate.ts")
const persistence = await import("./persistence.ts")
persistence.initPersistence()

const { initSubagent, handleSubagentDispatch, handleSubagentEvent, maybeRunMachineCriticPass, criticScoreEnforcementEnabled, shouldForceCriticRejectByScore } = sg
const { CRITIC_PASS_MARK, CRITIC_REJECT_MARK, CRITIC_SCORE_THRESHOLD_POLICY } = dg

// ── 极简 gateway harness（同 subagent.test.ts 口径，mock fetch） ─────────────────
const parents = new Map<string, { sessionId: string; opencodeSessionId: string; turnGen: number }>()
const wakes: Array<{ id: string; summary: string }> = []
const emitted: Array<{ name: string; data: any }> = []
const createdChildren: string[] = []
const childKind = new Map<string, string>()
let sessionSeq = 0
let parentSeq = 0

const realFetch = globalThis.fetch
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })
}
function childOf(url: string): string | undefined {
  return /\/session\/(ses_[^/]+)/.exec(url)?.[1]
}
function assistantText(kind: string | undefined): string {
  if (kind === "music") {
    return "emotion_contract: 温暖\nlyrics: 歌词\nmelody_notation: 1 2 3\naudio_url: https://cdn.example.com/a.mp3\nduration_source: ffprobe\nqc: ok"
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
      agent = (JSON.parse(init?.body ?? "{}").agent as string) ?? ""
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

function makeParent(id: string) {
  const sid = `${id}-${Date.now().toString(36)}-${(parentSeq++).toString(36)}`
  const p = { sessionId: sid, opencodeSessionId: `ses_parent_${sid}`, turnGen: 1 }
  parents.set(sid, p)
  return p
}
function req(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}
async function dispatch(p: { sessionId: string }, label: string, extra: Record<string, unknown> = {}) {
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
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 走完整链：Expert(music) 终态 → 机器 critic 派遣 → critic 终态；回传 critic run id 与其 child。 */
async function runCriticFlow(p: { sessionId: string }): Promise<{ criticRunId: string; criticChild: string }> {
  const expert = await dispatch(p, "音乐交付", { expert: "music" })
  await handleSubagentEvent({ type: "session.idle" }, expert.childId)
  await settle()
  expect(maybeRunMachineCriticPass(p, false)).toBe(true)
  await settle()
  const criticChild = createdChildren[createdChildren.length - 1]
  expect(childKind.get(criticChild)).toBe("critic")
  const startEvt = [...emitted].reverse().find((e) => e.name === "subagent.started" && e.data?.label === "机器审核")
  const criticRunId = String(startEvt?.data?.id ?? "")
  expect(criticRunId).not.toBe("")
  await handleSubagentEvent({ type: "session.idle" }, criticChild)
  await settle()
  return { criticRunId, criticChild }
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
  try {
    rmSync(TEST_DB_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// ── 纯函数：开关语义（必须字面 "1"）＋三条件判定 ────────────────────────────────
describe("开关与阈值判定（纯函数）", () => {
  const restore = process.env.CRITIC_SCORE_ENFORCE
  afterAll(() => {
    if (restore === undefined) delete process.env.CRITIC_SCORE_ENFORCE
    else process.env.CRITIC_SCORE_ENFORCE = restore
  })

  test('开关语义：只有字面 "1" 为真；未设/其他值一律 false', () => {
    delete process.env.CRITIC_SCORE_ENFORCE
    expect(criticScoreEnforcementEnabled()).toBe(false)
    for (const v of ["true", "on", "yes", "TRUE", "01", "1x", " 1"]) {
      process.env.CRITIC_SCORE_ENFORCE = v
      expect(criticScoreEnforcementEnabled()).toBe(false)
    }
    process.env.CRITIC_SCORE_ENFORCE = "1"
    expect(criticScoreEnforcementEnabled()).toBe(true)
  })

  test("(c) 来源 model_self 低分 → 不强制（非 oracle）", () => {
    expect(shouldForceCriticRejectByScore({ value: 2, source: "model_self" }, true)).toBe(false)
    expect(shouldForceCriticRejectByScore({ value: 2, source: "human" }, true)).toBe(false)
    expect(shouldForceCriticRejectByScore({ value: 2, source: null }, true)).toBe(false)
  })

  test("(d) score=null → 不强制（未知≠失败）", () => {
    expect(shouldForceCriticRejectByScore({ value: null, source: "measured" }, true)).toBe(false)
  })

  test("(a) 开关 false：measured 低分也不强制（回归保护）", () => {
    expect(shouldForceCriticRejectByScore({ value: 1, source: "measured" }, false)).toBe(false)
  })

  test("(b-单元) 开关 true + measured 低分 → 强制；达标/边界不强制", () => {
    const below = CRITIC_SCORE_THRESHOLD_POLICY.reworkBelow
    expect(shouldForceCriticRejectByScore({ value: below - 1, source: "measured" }, true)).toBe(true)
    expect(shouldForceCriticRejectByScore({ value: below, source: "measured" }, true)).toBe(false)
    expect(shouldForceCriticRejectByScore({ value: 9, source: "measured" }, true)).toBe(false)
  })
})

// ── 端到端：强制退回与否取决于开关 + measured 分 ──────────────────────────────
describe("machine critic 判决：measured 阈值接入既有 reject 链", () => {
  const restore = process.env.CRITIC_SCORE_ENFORCE
  afterAll(() => {
    if (restore === undefined) delete process.env.CRITIC_SCORE_ENFORCE
    else process.env.CRITIC_SCORE_ENFORCE = restore
  })

  test("(a) 开关未设 + 低分 measured → 不强制，PASS 回灌（零回归）", async () => {
    delete process.env.CRITIC_SCORE_ENFORCE
    mockScore = 2
    const p = makeParent("gw-score-a")
    const { criticRunId } = await runCriticFlow(p)
    const w = wakes[wakes.length - 1]
    expect(w.summary).toContain(CRITIC_PASS_MARK)
    expect(w.summary).not.toContain(CRITIC_REJECT_MARK)
    // 未启用＝不 await 量测；fire-and-forget 旁路仍照写 measured 供观测。
    await settle()
    const v = persistence.getCriticVerdictByRun(criticRunId)
    if (v) expect(v.score_source === "measured" || v.score_source === "model_self").toBe(true)
  })

  test("(b) 开关=1 + 低分 measured → 强制退回（既有 reject→重派链）；每会话只一次", async () => {
    process.env.CRITIC_SCORE_ENFORCE = "1"
    mockScore = 2
    const p = makeParent("gw-score-b")
    const { criticRunId } = await runCriticFlow(p)
    const w = wakes[wakes.length - 1]
    expect(w.summary).toContain(CRITIC_REJECT_MARK)
    // measured 落库：score=2、来源 measured、判决 reject（供审计与下游 join）。
    const v = persistence.getCriticVerdictByRun(criticRunId)
    expect(v?.score).toBe(2)
    expect(v?.score_source).toBe("measured")
    expect(v?.verdict).toBe("reject")
    // 既有硬帽：critic pass 每会话 ≤1 次 → 强制退回不可能连触发（未新增第二条重派路径/未动 reworkCount）。
    expect(maybeRunMachineCriticPass(p, false)).toBe(false)
  })

  test("(d-端到端) 开关=1 但量测回 null → 不强制，PASS 回灌", async () => {
    process.env.CRITIC_SCORE_ENFORCE = "1"
    mockScore = null
    const p = makeParent("gw-score-d")
    const { criticRunId } = await runCriticFlow(p)
    const w = wakes[wakes.length - 1]
    expect(w.summary).toContain(CRITIC_PASS_MARK)
    expect(w.summary).not.toContain(CRITIC_REJECT_MARK)
    const v = persistence.getCriticVerdictByRun(criticRunId)
    // 无量测 → 诚实 null 分、来源 model_self（自评只作筛子，永不触发阈值）。
    expect(v?.score).toBeNull()
    expect(v?.score_source).toBe("model_self")
  })
})
