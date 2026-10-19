// H11/H14 测试（node:test，与 collaborate-gate.test.ts 同型）。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

process.env.GATEWAY_DB_PATH = join(mkdtempSync(join(tmpdir(), "h11h14-")), "gw.db")

const { isSystemWakeText, markSystemWakeMessage } = await import("./opencode-event-handler.ts")
const { handleSessionTasks } = await import("./internal-http.ts")

const req = (b: unknown) => new Request("http://x/internal/session-tasks", { method: "POST", body: JSON.stringify(b) })

test("H11 session-tasks：查无会话回 200 + tasks:[]（不再 404）", async () => {
  const r = await handleSessionTasks(req({ session_id: "nope-nope" }))
  assert.equal(r.status, 200)
  const j: any = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.session_found, false)
  assert.deepEqual(j.tasks, [])
})

test("H11 session-tasks：缺 session_id 仍 400", async () => {
  assert.equal((await handleSessionTasks(req({}))).status, 400)
})

test("H14 唤醒文本识别", () => {
  assert.equal(isSystemWakeText("【子代理完成·系统自动唤醒】subagent abc"), true)
  assert.equal(isSystemWakeText("【子代理失败·系统自动唤醒】x"), true)
  assert.equal(isSystemWakeText("帮我画一只猫"), false)
})

test("H14 唤醒讯息 role 由 user 改记 system，且只标一次", () => {
  const state: any = { messageRole: new Map([["m1", "user"], ["m2", "user"]]), sessionId: "s", replayBuffer: [], clients: new Set(), eventCounter: 0 }
  assert.equal(markSystemWakeMessage(state, "m1", "【子代理完成·系统自动唤醒】x"), true)
  assert.equal(state.messageRole.get("m1"), "system")
  assert.equal(markSystemWakeMessage(state, "m1", "【子代理完成·系统自动唤醒】x"), false)
  assert.equal(markSystemWakeMessage(state, "m2", "真用户一句话"), false)
  assert.equal(state.messageRole.get("m2"), "user")
})
