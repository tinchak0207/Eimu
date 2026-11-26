import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
process.env.GATEWAY_DB_PATH = join(mkdtempSync(join(tmpdir(), "h11fill-")), "gw.db")
const { slimHistoryMessages } = await import("./sessions-http.ts")
const { registerWorkflowTask } = await import("./workflow-gw.ts")

test("H14 历史回放：唤醒讯息呈现为 system，普通 user 不变", () => {
  const out: any[] = slimHistoryMessages([
    { info: { id: "a", role: "user" }, parts: [{ type: "text", text: "【子代理完成·系统自动唤醒】x" }] },
    { info: { id: "b", role: "user" }, parts: [{ type: "text", text: "画猫" }] },
  ])
  assert.equal(out[0].info.role, "system")
  assert.equal(out[1].info.role, "user")
})

test("进度回报和回报队列不进客户端历史", () => {
  const out: any[] = slimHistoryMessages([
    { info: { id: "q", role: "user" }, parts: [{ type: "text", text: "【子代理回报队列·系统事实】父会话上次被唤醒以来\n【子代理进度回报·系统自动唤醒】还在排队" }] },
    { info: { id: "p", role: "user" }, parts: [{ type: "text", text: "【子代理进度回报·系统自动唤醒】还在画" }] },
    { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "画猫" }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].info.role, "user")
  assert.equal(out[0].parts[0].text, "画猫")
})

test("队列顶在完成宣告前时，历史只从完成宣告起", () => {
  const out: any[] = slimHistoryMessages([
    { info: { id: "m", role: "user" }, parts: [{ type: "text", text: "【子代理回报队列·系统事实】旧进度\n\n【子代理完成·系统自动唤醒】「封面」这一路已完成。" }] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].info.role, "system")
  assert.equal(out[0].parts[0].text.startsWith("【子代理完成·系统自动唤醒】"), true)
  assert.equal(String(out[0].parts[0].text).includes("回报队列"), false)
})

test("H11 workflow 任务登记进 sessionTasks 并可转态", () => {
  const st: any = { sessionTasks: new Map() }
  registerWorkflowTask(st, "t1", "n1", "queued")
  registerWorkflowTask(st, "t1", "n1", "succeeded", "http://u/x.png")
  const t = st.sessionTasks.get("t1")
  assert.equal(t.status, "succeeded")
  assert.equal(t.url, "http://u/x.png")
  registerWorkflowTask({} as any, "t2", "n", "queued") // 无 Map 兜底不抛
})
