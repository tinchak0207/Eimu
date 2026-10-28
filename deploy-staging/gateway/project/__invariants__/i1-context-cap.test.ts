// I1（设计文档 §8 第一行）：200 步合成会话，每轮发给模型的总字节 ≤ 65536。
//
// 独立期望来源：
//   * 65536 / 6 是设计文档常量（本档手写，不 import 被测实现的 LIMITS）；
//   * 字节数在 fake opencode 收到的**原始请求体**上量（recorder 记录，不读 plan.bytes）；
//   * 200 步、21 条用户原话由本档自己生成（fixtures/session.ts），期望就是这些写死的字符串。
//
// 双侧（不可牺牲）：同一轮必须同时含目标卡、摘要、最近 6 步；摘要把全部 failed/blocked/pinned
// 节点一个不少地列出来。
import "./fixtures/env"
import "./fixtures/fake-platform"
import "./fixtures/recorder"
import { beforeAll, describe, expect, test } from "bun:test"
import {
  USER_TEXTS,
  applyContextPlan,
  buildLongSession,
  isPlan,
  sendModelInput,
  stepCount,
  syntheticOf,
  userTextsInRequest,
} from "./fixtures/session"
import { makeDigestGraph, makeDigestInputs } from "./fixtures/graph"

/** 设计文档 §3 常量表：INPUT_CAP_BYTES=65536，CONTEXT_WINDOW_STEPS=6。 */
const INPUT_CAP_BYTES = 65536
const CONTEXT_WINDOW_STEPS = 6
const GOAL_CARD_TAG = "<eimu-goal-card>"
const DIGEST_TAG = "<eimu-project-digest>"

let ctx: typeof import("../context.ts")

beforeAll(async () => {
  ctx = await import("../context.ts")
})

function briefsUpTo(session: ReturnType<typeof buildLongSession>, upto: number) {
  return session.texts.slice(0, upto + 1).map((text, i) => ({
    id: `b${i + 1}`,
    at: new Date(Date.parse("2026-10-28T00:00:00.000Z") + i * 1000).toISOString(),
    messageId: session.messageIds[i],
    text,
  }))
}

/** 测试自己的字节闸：喂超限请求必须拒绝（反例用，不依赖被测实现）。 */
function assertWithinCap(bytes: number): void {
  if (bytes > INPUT_CAP_BYTES) throw new Error(`模型输入 ${bytes} 字节超过上限 ${INPUT_CAP_BYTES}`)
}

describe("I1 上下文字节上限（200 步）", () => {
  test("200 步会话每轮最终请求 ≤65536 字节，且同轮含目标卡+摘要+最近 6 步", async () => {
    const session = buildLongSession()
    expect(stepCount(session.messages)).toBe(200)
    expect(session.rounds.length).toBe(USER_TEXTS.length)

    let maxBytes = 0
    let maxRound = -1
    const observed: number[] = []
    for (let ri = 0; ri < session.rounds.length; ri++) {
      const round = session.rounds[ri]
      const messages = JSON.parse(JSON.stringify(session.messages.slice(0, round + 1)))
      const graph = makeDigestGraph()
      graph.brief = briefsUpTo(session, ri)

      const plan = ctx.projectContextResponse(graph, messages, { digestInputs: makeDigestInputs() })
      expect(isPlan(plan)).toBe(true)
      if (!isPlan(plan)) throw new Error("projectContextResponse 未返回工程模式计划")
      const assembled = applyContextPlan(messages, plan)

      // ① 字节：在 fake opencode 收到的原始体上量。
      const raw = await sendModelInput("ses_inv", assembled, ctx.buildStaticSystem(false))
      const bytes = Buffer.byteLength(raw, "utf8")
      observed.push(bytes)
      assertWithinCap(bytes)
      if (bytes > maxBytes) {
        maxBytes = bytes
        maxRound = ri
      }

      // ② 同一轮必须含目标卡 + 摘要（首轮只有一条原话且就是当前消息：卡片按既有规则省略，原文本身在场）。
      const synthetic = syntheticOf(assembled)
      expect(synthetic).toContain(DIGEST_TAG)
      if (ri === 0) {
        expect(synthetic).not.toContain(GOAL_CARD_TAG)
        expect(userTextsInRequest(assembled)).toEqual([session.texts[0]])
      } else {
        expect(synthetic).toContain(GOAL_CARD_TAG)
        expect(synthetic).toContain(session.texts[0])
        // 超长单条按目标卡折叠规则只保留头尾：头尾逐字在场即算「最近一条在场」。
        const latest = session.texts[ri]
        if (synthetic.includes(latest)) {
          expect(synthetic).toContain(latest)
        } else {
          expect(synthetic).toContain(latest.slice(0, 60))
          expect(synthetic).toContain(latest.slice(-60))
        }
      }

      // ③ 最近 6 步（首轮之前没有步）。
      const assistants = assembled.filter((m) => m.info.role === "assistant")
      expect(assistants.length).toBe(Math.min(CONTEXT_WINDOW_STEPS, ri * 10))
      if (ri > 0) {
        expect(assistants.length).toBe(CONTEXT_WINDOW_STEPS)
        // tool_use/tool_result 成对：留下的每条回执都能找到对应调用。
        const uses = new Set<string>()
        for (const m of assembled) {
          if (m.info.role !== "assistant") continue
          for (const p of m.parts) if (p.type === "tool") uses.add(String(p.callID ?? p.id))
        }
        for (const m of assembled) {
          if (m.info.role !== "tool") continue
          for (const p of m.parts) expect(uses.has(String(p.callID ?? p.id))).toBe(true)
        }
      }

      // ④ 摘要：failed / blocked / pinned 一个不少。
      for (const node of Object.values(graph.nodes)) {
        if (["failed", "blocked"].includes(node.status) || node.pinned) expect(synthetic).toContain(node.id)
      }
    }
    expect(observed.length).toBe(session.rounds.length)
    expect(maxBytes).toBeGreaterThan(0)
    console.log(`[I1] rounds=${observed.length} maxBytes=${maxBytes}@round=${maxRound}`)
  }, 60_000)

  test("反例：70KB 构造请求必须被字节闸拒绝（闸会咬人）", () => {
    expect(() => assertWithinCap(INPUT_CAP_BYTES + 1)).toThrow(/超过上限/)
    const huge = "长".repeat(Math.ceil(70_000 / 3))
    const bad = JSON.stringify({ session_id: "ses_inv", messages: [{ parts: [{ type: "text", text: huge }] }] })
    expect(Buffer.byteLength(bad, "utf8")).toBeGreaterThan(INPUT_CAP_BYTES)
    expect(() => assertWithinCap(Buffer.byteLength(bad, "utf8"))).toThrow()
  })
})
