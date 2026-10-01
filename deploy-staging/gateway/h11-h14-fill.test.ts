import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
process.env.GATEWAY_DB_PATH = join(mkdtempSync(join(tmpdir(), "h11fill-")), "gw.db")
const { slimHistoryMessages } = await import("./sessions-http.ts")
const { registerWorkflowTask } = await import("./workflow-gw.ts")

test("H14 歷史回放：喚醒訊息呈現為 system，普通 user 不變", () => {
  const out: any[] = slimHistoryMessages([
    { info: { id: "a", role: "user" }, parts: [{ type: "text", text: "【子代理完成·系统自动唤醒】x" }] },
    { info: { id: "b", role: "user" }, parts: [{ type: "text", text: "畫貓" }] },
  ])
  assert.equal(out[0].info.role, "system")
  assert.equal(out[1].info.role, "user")
})

test("H11 workflow 任務登記進 sessionTasks 並可轉態", () => {
  const st: any = { sessionTasks: new Map() }
  registerWorkflowTask(st, "t1", "n1", "queued")
  registerWorkflowTask(st, "t1", "n1", "succeeded", "http://u/x.png")
  const t = st.sessionTasks.get("t1")
  assert.equal(t.status, "succeeded")
  assert.equal(t.url, "http://u/x.png")
  registerWorkflowTask({} as any, "t2", "n", "queued") // 無 Map 兜底不拋
})
