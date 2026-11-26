import test from "node:test"
import assert from "node:assert/strict"
import { renderSubagentNoteQueueBlock, composeNoteWakeInjection, composeSubagentWakeInjection } from "./subagent-live.ts"

test("同一路进度折叠成最新一条，并截断长正文", () => {
  const long = "三张封面已提交，".repeat(40)
  const block = renderSubagentNoteQueueBlock([
    { run_id: "907fa549", kind: "progress", text: "第一报还在排队", at: 1 },
    { run_id: "907fa549", kind: "progress", text: long, at: 2 },
    { run_id: "aaaaaaaa", kind: "question", text: "用哪一版？", at: 3 },
  ])
  assert.match(block, /共 2 条/)
  assert.match(block, /略去 1 条较早进度/)
  assert.equal(block.includes("第一报还在排队"), false)
  assert.match(block, /用哪一版？/)
  const progressLine = block.split("\n").find((l) => l.includes("进度回报")) ?? ""
  assert.ok(progressLine.length < 220, progressLine)
})

test("回报唤醒在队列非空时不把触发正文再贴一遍；完成唤醒仍保留宣告", () => {
  const queue = renderSubagentNoteQueueBlock([{ run_id: "907fa549", kind: "progress", text: "还在排队", at: 1 }])
  const trigger = "【子代理进度回报·系统自动唤醒】全文再贴一遍，task_id 不该出现第二次"
  const noted = composeNoteWakeInjection(queue, trigger)
  assert.equal(noted.includes("全文再贴一遍"), false)
  assert.match(noted, /不要复述到用户屏幕/)
  const done = composeSubagentWakeInjection(queue, "【子代理完成·系统自动唤醒】这一路已完成。")
  assert.match(done, /这一路已完成/)
})
