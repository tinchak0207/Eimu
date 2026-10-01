import { expect, test } from "bun:test"
import { appendReplayFrame, MergedReplayFrame } from "./replay-frame.ts"

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

test("連續同名文字幀合併，非文字幀切段", () => {
  const buf = feed([
    ["reasoning.delta", { text: "想" }], ["reasoning.delta", { text: "一想" }],
    ["message.delta", { text: "答" }], ["message.delta", { text: "案" }],
    ["tool.invoke", { tool: "x" }], ["message.delta", { text: "後" }],
  ])
  expect(buf.length).toBe(4)
  expect(dataOf(buf[0].frame)).toEqual({ text: "想一想", event_id: 2 })
  expect(buf[0].id).toBe(2)
  expect(dataOf(buf[1].frame)).toEqual({ text: "答案", event_id: 4 })
  expect(dec.decode(buf[2].frame)).toContain("event: tool.invoke")
  expect(buf[3].id).toBe(6)
})

test("Last-Event-ID 落在合併段中間：只補後綴，不丟不重", () => {
  const buf = feed([["reasoning.delta", { text: "A" }], ["reasoning.delta", { text: "B" }], ["reasoning.delta", { text: "C" }]])
  const m = buf[0] as MergedReplayFrame
  expect(m.firstId).toBe(1)
  expect(dataOf(m.suffixFrame(1)).text).toBe("BC")
  expect(dataOf(m.suffixFrame(2)).text).toBe("C")
  expect(dataOf(m.suffixFrame(0)).text).toBe("ABC")
})

test("帶額外欄位的文字幀不合併", () => {
  const buf = feed([["message.delta", { text: "a" }], ["message.delta", { text: "b", kind: "x" }]])
  expect(buf.length).toBe(2)
})

test("持久化往返還原段界", () => {
  const buf = feed([["reasoning.delta", { text: "你好" }], ["reasoning.delta", { text: "世界" }]])
  const m = buf[0] as MergedReplayFrame
  const back = MergedReplayFrame.fromPersisted(dec.decode(m.frame), m.toPersisted())!
  expect(back.id).toBe(2)
  expect(dataOf(back.suffixFrame(1)).text).toBe("世界")
  expect(MergedReplayFrame.fromPersisted(dec.decode(m.frame), { name: "reasoning.delta", ids: [1], lens: [9] })).toBeNull()
})
