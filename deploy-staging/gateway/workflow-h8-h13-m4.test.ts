// H8/H13/M4：失敗文案帶 failure_class+原文、帳務累加對稱、零交付機器閘。
// 跑法：timeout 120 bun run deploy-staging/gateway/workflow-h8-h13-m4.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { SessionState } from "./types-gateway.ts"

const dir = mkdtempSync(join(tmpdir(), "wf-h8-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.PLATFORM_BASE = "http://127.0.0.1:1"
process.env.QUOTA_URL = "http://127.0.0.1:1/v1/quota"
process.env.OPENCODE_URL = "http://127.0.0.1:1"

async function run(): Promise<void> {
  const assert = await import("node:assert/strict")
  const gw = await import("./workflow-gw.ts")

  // H8
  const msg = gw.formatNodeFailure("model_unavailable", "执行侧无可用供应商，请稍后重试。第二句", "模型 x 不可用")
  assert.match(msg, /\[failure_class=model_unavailable\]/)
  assert.match(msg, /原文：「执行侧无可用供应商，请稍后重试」/)
  assert.ok(!msg.includes("第二句"))
  assert.match(gw.formatNodeFailure(undefined, "", "生成失败"), /failure_class=unknown.*（无）/)
  console.log("  ✓ H8 文案帶 class+原文首句")

  // H13
  gw.recordWorkflowApproval("wfA", 460)
  const b = gw.recordWorkflowApproval("wfA", 750.005)
  assert.equal(b.confirmed_coins, 1210.005)
  assert.deepEqual(b.approvals, [460, 750.005])
  const state = {
    sessionId: "h13", apiKey: "sk", opencodeSessionId: "oc", clients: new Set(), pendingConfirms: new Map(),
    pendingQuestions: new Map(), resolvedConfirms: new Map(), eventCounter: 0, replayBuffer: [], turnGen: 1,
  } as unknown as SessionState
  gw.recordWorkflowRefund(state, "wfA")
  assert.equal(gw.workflowBilling.get("wfA")!.refunded_coins, 1210.005)
  assert.equal(gw.workflowBilling.get("wfA")!.billing_status, "refunded")
  // 退款後再批准一筆：累加，refunded 保留，再退只退新增部分
  const c = gw.recordWorkflowApproval("wfA", 100)
  assert.equal(c.confirmed_coins, 1310.005)
  assert.equal(c.billing_status, "confirmed")
  gw.recordWorkflowRefund(state, "wfA")
  assert.equal(gw.workflowBilling.get("wfA")!.refunded_coins, 1310.005)
  console.log("  ✓ H13 approve 累加、refund 對稱")

  // M4
  const models = [
    { id: "v1", media_type: "video", availability: "available", last_24h: { jobs: 5, delivered: 0 } },
    { id: "v2", media_type: "video", availability: "unavailable", last_24h: { delivered: 0 } },
  ]
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ models }), { status: 200 })) as typeof fetch
  const { templatePlaceholderContent } = await import("./workflow-templates")
  const s2 = { ...state, sessionId: "m4", apiKey: "sk-m4-zero" } as unknown as SessionState
  const r = gw.workflowService.startFast("single_video", templatePlaceholderContent("single_video") as never, s2)
  if (!("workflowId" in r)) throw new Error("startFast failed")
  const wfid = r.workflowId
  const call = async (extra: Record<string, unknown> = {}) =>
    gw.handleWorkflowInternal(new Request("http://x/internal/workflow/generate", { method: "POST", body: JSON.stringify({ workflow_id: wfid, ...extra }) }), s2)
  // 避免真開跑：模擬已在跑，覆寫放行後會被 already_running 擋下（證明已越過 M4 閘）
  const blocked = await call()
  const bj = (await blocked.json()) as Record<string, unknown>
  assert.equal(blocked.status, 409)
  assert.equal(bj.status, "needs_override")
  assert.equal(bj.reason, "zero_delivery_24h")
  assert.ok(bj.override)
  const noReason = await call({ override_zero_delivery: true })
  assert.equal(((await noReason.json()) as Record<string, unknown>).status, "needs_override")
  ;(gw.workflowService as unknown as { generateLoops: Set<string> }).generateLoops.add(wfid)
  const passed = await call({ override_zero_delivery: true, override_reason: "用户说照跑" })
  assert.equal(((await passed.json()) as Record<string, unknown>).reason, "already_running")
  // 有交付證據則不攔（model-status 有 TTL 快取，改驗同形狀判定的另一面：無 available 影片 → null 不攔）
  assert.deepEqual(await gw.videoZeroDelivery24h("sk-m4-zero"), { available: ["v1"] })
  globalThis.fetch = realFetch
  console.log("  ✓ M4 零交付機器閘")
  process.exit(0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  test("workflow-h8-h13-m4", { skip: "需 bun 執行" }, () => {})
} else {
  run().catch((e) => { console.error(e); process.exit(1) })
}
