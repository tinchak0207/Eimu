// I2（设计文档 §8 第二行）：每轮目标卡与用户原话逐字一致（含 emoji、换行、>12000 字截断标记），
// 折叠场景首条与最近 N 条仍逐字。
//
// 独立期望来源 = 本档自己发送的用户消息字符串（不读 brief[] 实现、不读 renderGoalCard 的内部常量）。
// 反例：把卡片里一条原话改一个空格，检验器必须报错。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { beforeAll, describe, expect, test } from "bun:test"

const GOAL_CARD_TAG = "<eimu-goal-card>"
const BRIEF_ENTRY_CHARS = 12000 // 设计文档 §3：单条用户原话上限

let brief: typeof import("../brief.ts")
let ctx: typeof import("../context.ts")

beforeAll(async () => {
  brief = await import("../brief.ts")
  ctx = await import("../context.ts")
})

const T0 = Date.parse("2026-10-28T00:00:00.000Z")
const at = (i: number) => new Date(T0 + i * 1000).toISOString()

interface CardBody {
  n: number
  total: number
  text: string
}

function parseCard(card: string): { bodies: CardBody[]; earlierFolded: number; laterFolded: number } {
  const bodies: CardBody[] = []
  for (const m of card.matchAll(/<user-message n="(\d+)\/(\d+)">\n([\s\S]*?)\n<\/user-message>/g)) {
    bodies.push({ n: Number(m[1]), total: Number(m[2]), text: m[3] })
  }
  const earlier = [...card.matchAll(/（此处折叠 (\d+) 条较早的用户消息）/g)].reduce((n, m) => n + Number(m[1]), 0)
  const later = [...card.matchAll(/（此后折叠 (\d+) 条用户消息）/g)].reduce((n, m) => n + Number(m[1]), 0)
  return { bodies, earlierFolded: earlier, laterFolded: later }
}

const FOLD_RE = /\n\[…单条过长[^\n]*\n/

/**
 * 检验器：卡片里每条正文必须与某条原话逐字相同；单条超长时只允许「头尾逐字 + 中段折叠标记」。
 * 不满足就抛错（反例用）。
 */
function assertVerbatim(card: string, sent: readonly string[]): CardBody[] {
  const { bodies } = parseCard(card)
  if (bodies.length === 0) throw new Error("目标卡没有任何 <user-message> 正文")
  for (const body of bodies) {
    if (FOLD_RE.test(body.text)) {
      const [head, tail] = body.text.split(FOLD_RE)
      const source = sent.find((t) => t.startsWith(head) && t.endsWith(tail))
      if (!source) throw new Error(`折叠条目头尾与任何用户原话都对不上：${head.slice(0, 20)}…`)
      continue
    }
    if (!sent.includes(body.text)) throw new Error(`目标卡正文不是用户原话：${JSON.stringify(body.text.slice(0, 60))}`)
  }
  return bodies
}

function cardOf(briefs: { id: string; at: string; messageId: string; text: string; truncated?: boolean }[]): string {
  return brief.renderGoalCard(briefs as never)
}

describe("I2 目标卡逐字", () => {
  test("emoji 与换行逐字；每轮（brief≥2）卡片正文 === 已发送原话", () => {
    const sent = ["帮我做 30 秒茶饮广告 😀\n主线：清晨窗边的杯子", "改成 16:9，不要竖屏 🌄", "旁白：\n「一杯茶的时间」\n（不许改）"]
    const briefs = sent.map((text, i) => ({ id: `b${i + 1}`, at: at(i), messageId: `msg_u${i}`, text }))
    for (let upto = 1; upto < sent.length; upto++) {
      const card = cardOf(briefs.slice(0, upto + 1))
      expect(card.startsWith(GOAL_CARD_TAG)).toBe(true)
      const bodies = assertVerbatim(card, sent.slice(0, upto + 1))
      expect(bodies.length).toBe(upto + 1)
      expect(bodies[bodies.length - 1].text).toBe(sent[upto])
    }
  })

  test(">12000 字：ingress 截断标记 + 卡片头尾逐字", () => {
    const long = `超长需求开头：${"细节".repeat(7000)}`
    expect([...long].length).toBeGreaterThan(BRIEF_ENTRY_CHARS)
    const entries: any[] = []
    const entry = brief.appendBriefEntry(entries, { at: at(1), messageId: "msg_long", text: long })!
    expect(entry.truncated).toBe(true)
    expect([...entry.text].length).toBe(BRIEF_ENTRY_CHARS)
    expect(entry.text).toBe([...long].slice(0, BRIEF_ENTRY_CHARS).join(""))

    const latest = "改完了，继续导出 mp4"
    entries.push({ id: "b2", at: at(2), messageId: "msg_latest", text: latest })
    const card = cardOf(entries)
    // 首条在卡片里可能被折叠（预算 4000 token）：头尾必须逐字，中段必须标折叠。
    assertVerbatim(card, [entry.text, latest])
    const bodies = parseCard(card).bodies
    const first = bodies.find((b) => b.n === 1)!
    expect(entry.text.startsWith(first.text.split(FOLD_RE)[0])).toBe(true)
    if (!FOLD_RE.test(first.text)) expect(first.text).toBe(entry.text)
    expect(bodies[bodies.length - 1].text).toBe(latest)
  })

  test("折叠：首条与最近 N 条逐字，折叠条数之和 + 展示条数 = 总数", () => {
    const sent = Array.from({ length: 200 }, (_, i) => `第 ${i} 条：镜头 ${i} 的构图描述（${"细".repeat(30)}）`)
    const briefs = sent.map((text, i) => ({ id: `b${i + 1}`, at: at(i), messageId: `msg_u${i}`, text }))
    const card = cardOf(briefs)
    const bodies = assertVerbatim(card, sent)
    expect(bodies[0].text).toBe(sent[0])
    expect(bodies[bodies.length - 1].text).toBe(sent[199])
    const { earlierFolded, laterFolded } = parseCard(card)
    expect(earlierFolded + laterFolded).toBeGreaterThan(0)
    expect(bodies.length + earlierFolded + laterFolded).toBe(200)
    expect(card).toContain("（此处折叠")
  })

  test("首轮只有一条原话且就是当前消息：卡片省略，原文本身逐字在场（既有规则，非省略判准）", () => {
    const sent = "只发一条：做一张茶饮海报 🍵\n竖版"
    const briefs = [{ id: "b1", at: at(0), messageId: "msg_u0", text: sent }]
    const messages = [
      { info: { id: "msg_u0", role: "user", sessionID: "ses_inv" }, parts: [{ type: "text", text: sent }] },
    ]
    const graph = {
      schema: 1, id: "ses_inv", sessionId: "ses_inv", version: 1, createdAt: at(0), updatedAt: at(0),
      brief: briefs, decisions: [], targets: null, defaults: {}, nodes: {}, order: [], budget: { capCoins: null, spentCoins: 0, savedCoins: 0 },
      activeRun: null, seq: 0,
    }
    const plan = ctx.projectContextResponse(graph as never, messages as never)
    expect(plan.project_mode).toBe(true)
    if (!plan.project_mode) throw new Error("unreachable")
    expect(plan.synthetic).not.toContain(GOAL_CARD_TAG)
    expect(plan.synthetic).toContain("<eimu-project-digest>")
    // 当前用户消息本体逐字（未被改写）
    expect(messages[0].parts[0].text).toBe(sent)
  })

  test("反例：卡片正文多一个空格必须被逐字检验器拒绝", () => {
    const sent = ["帮我做一支 30 秒的茶饮广告", "改成 16:9"]
    const briefs = sent.map((text, i) => ({ id: `b${i + 1}`, at: at(i), messageId: `msg_u${i}`, text }))
    const card = cardOf(briefs)
    const tampered = card.replace("改成 16:9", "改成 16:9 ")
    expect(() => assertVerbatim(tampered, sent)).toThrow(/不是用户原话/)
  })
})
