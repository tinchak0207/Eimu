// H6：/workflow/generate 在工作流已執行中時必須如實回 ok:false（already_running），
// 不得回 approved/running 假成功，也不得彈新確認卡。
// 跑法：timeout 120 bun run deploy-staging/gateway/workflow-generate-reject.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { SessionState } from "./types-gateway.ts"

const dir = mkdtempSync(join(tmpdir(), "wf-gen-reject-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.PLATFORM_BASE = "http://127.0.0.1:1"
process.env.QUOTA_URL = "http://127.0.0.1:1/v1/quota"
process.env.OPENCODE_URL = "http://127.0.0.1:1"

async function run(): Promise<void> {
  const assert = await import("node:assert/strict")
  const gw = await import("./workflow-gw.ts")
  const { templatePlaceholderContent } = await import("./workflow-templates")
  const state = {
    sessionId: "h6-sess", apiKey: "sk-h6", opencodeSessionId: "oc_h6", clients: new Set(),
    pendingConfirms: new Map(), pendingQuestions: new Map(), resolvedConfirms: new Map(),
    eventCounter: 0, replayBuffer: [], lastActivityAt: Date.now(), turnTerminalNodes: [],
    partTextEmitted: new Map(), partStripState: new Map(), announcedUrls: new Set(),
    toolStatusSeen: new Set(), toolInvokeSeen: new Set(), stepCostLogged: new Set(),
    messageRole: new Map(), suppressedParts: new Set(), canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(), sessionTasks: new Map(), turnGen: 1,
  } as unknown as SessionState
  const r = gw.workflowService.startFast("shortdrama_visual", templatePlaceholderContent("shortdrama_visual") as never, state)
  if (!("workflowId" in r)) throw new Error("startFast failed")
  const wfid = r.workflowId
  // 模擬引擎已有執行循環在跑
  ;(gw.workflowService as unknown as { generateLoops: Set<string> }).generateLoops.add(wfid)
  const res = await gw.handleWorkflowInternal(
    new Request("http://x/internal/workflow/generate", { method: "POST", body: JSON.stringify({ workflow_id: wfid }) }),
    state,
  )
  const j = (await res.json()) as Record<string, unknown>
  assert.equal(res.status, 409)
  assert.equal(j.ok, false)
  assert.equal(j.reason, "already_running")
  assert.notEqual(j.status, "approved")
  assert.notEqual(j.status, "running")
  assert.equal(state.pendingConfirms.size, 0, "不得彈新確認卡")
  assert.equal(gw.workflowService.isGenerating(wfid), true)
  console.log("  ✓ H6 already_running 如實拒絕")
  process.exit(0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  test("workflow-generate-reject", { skip: "需 bun 執行" }, () => {})
} else {
  run().catch((e) => { console.error(e); process.exit(1) })
}
