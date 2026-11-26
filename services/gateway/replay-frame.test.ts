import { expect, test } from "bun:test"
import { appendReplayFrame, MergedReplayFrame, isStrippableReplayEntry } from "./replay-frame.ts"

const enc = new TextEncoder()
const dec = new TextDecoder()
const plain = (name: string, data: object, id: number) =>
  enc.encode(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify({ ...data, event_id: id })}\n\n`)
function feed(frames: [string, object][]) {
  const buf: { id: number; frame: Uint8Array }[] = []
  frames.forEach(([n, d], i) => appendReplayFrame(buf, n, d, i + 1, plain(n, d, i + 1)))
  return buf
}
const dataOf = (f: Uint8Array) => JSON.parse(dec.decode(f).split("\n").find((l) => l.startsWith("data: "))!.slice(6))

test("连续同名文字帧合并，非文字帧切段", () => {
  const buf = feed([
    ["reasoning.delta", { text: "想" }], ["reasoning.delta", { text: "一想" }],
    ["message.delta", { text: "答" }], ["message.delta", { text: "案" }],
    ["tool.invoke", { tool: "x" }], ["message.delta", { text: "后" }],
  ])
  expect(buf.length).toBe(4)
  expect(dataOf(buf[0].frame)).toEqual({ text: "想一想", event_id: 2 })
  expect(buf[0].id).toBe(2)
  expect(dataOf(buf[1].frame)).toEqual({ text: "答案", event_id: 4 })
  expect(dec.decode(buf[2].frame)).toContain("event: tool.invoke")
  expect(buf[3].id).toBe(6)
})

test("Last-Event-ID 落在合并段中间：只补后缀，不丢不重", () => {
  const buf = feed([["reasoning.delta", { text: "A" }], ["reasoning.delta", { text: "B" }], ["reasoning.delta", { text: "C" }]])
  const m = buf[0] as MergedReplayFrame
  expect(m.firstId).toBe(1)
  expect(dataOf(m.suffixFrame(1)).text).toBe("BC")
  expect(dataOf(m.suffixFrame(2)).text).toBe("C")
  expect(dataOf(m.suffixFrame(0)).text).toBe("ABC")
})

test("带额外栏位的文字帧不合并", () => {
  const buf = feed([["message.delta", { text: "a" }], ["message.delta", { text: "b", kind: "x" }]])
  expect(buf.length).toBe(2)
})

test("持久化往返还原段界", () => {
  const buf = feed([["reasoning.delta", { text: "你好" }], ["reasoning.delta", { text: "世界" }]])
  const m = buf[0] as MergedReplayFrame
  const back = MergedReplayFrame.fromPersisted(dec.decode(m.frame), m.toPersisted())!
  expect(back.id).toBe(2)
  expect(dataOf(back.suffixFrame(1)).text).toBe("世界")
  expect(MergedReplayFrame.fromPersisted(dec.decode(m.frame), { name: "reasoning.delta", ids: [1], lens: [9] })).toBeNull()
})

// ── 2026-10-02 工作流终态通报耐久化（wf_muqfkhw7_1 事故）──
// 网关主动通报与模型正文共用 message.delta；N2 strip 曾把所有 message.delta 一律剥除，
// 导致晚重连的 client 看不到含成片连结与实扣币数的通报。以下锁住修复契约。

const durableNotice = "【工作流部分完成】\n成片：https://cdn.example/film.mp4\n费用（以控制面账本为准）：实扣 130 币\n"

test("网关耐久帧（strippable=false）独立成条目、不与模型文字合并、不被 strip 剥除", () => {
  const buf: { id: number; frame: Uint8Array; strippable?: boolean }[] = []
  appendReplayFrame(buf, "message.delta", { text: "模型前缀" }, 1, plain("message.delta", { text: "模型前缀" }, 1))
  appendReplayFrame(buf, "message.delta", { text: durableNotice }, 2, plain("message.delta", { text: durableNotice }, 2), false)
  appendReplayFrame(buf, "message.delta", { text: "模型后缀" }, 3, plain("message.delta", { text: "模型后缀" }, 3))
  // 耐久帧自成条目：前后模型帧各自合并成独立 MergedReplayFrame，通报不被并吞。
  expect(buf.length).toBe(3)
  expect((buf[0] as MergedReplayFrame).texts.join("")).toBe("模型前缀")
  expect(buf[1].strippable).toBe(false)
  expect(dec.decode(buf[1].frame)).toContain("以控制面账本为准")
  expect(dec.decode(buf[1].frame)).toContain("film.mp4")
  expect(buf[2]).toBeInstanceOf(MergedReplayFrame)

  // strip 判定：模型帧可剥，耐久帧不可剥。
  expect(isStrippableReplayEntry(buf[0])).toBe(true)
  expect(isStrippableReplayEntry(buf[1])).toBe(false)
  expect(isStrippableReplayEntry(buf[2])).toBe(true)
})

test("耐久通报经过 N2 strip 后仍在 replay 中（重连可取回）", () => {
  const buf: { id: number; frame: Uint8Array; strippable?: boolean }[] = []
  appendReplayFrame(buf, "reasoning.delta", { text: "旧思考" }, 1, plain("reasoning.delta", { text: "旧思考" }, 1))
  appendReplayFrame(buf, "message.delta", { text: durableNotice }, 2, plain("message.delta", { text: durableNotice }, 2), false)
  appendReplayFrame(buf, "message.delta", { text: "旧正文" }, 3, plain("message.delta", { text: "旧正文" }, 3))
  const kept = buf.filter((f) => !isStrippableReplayEntry(f))
  expect(kept.length).toBe(1)
  expect(dec.decode(kept[0].frame)).toContain("以控制面账本为准")
  expect(dec.decode(kept[0].frame)).toContain("实扣 130 币")
})
