// 2026-10-02 三缺陷注入驗收（真行為，非源碼字串斷言）。
//   1) settleWorkflowCharges：job succeeded 但 cost_coins 先 0、約 10 秒後才 130
//      → 不得記出假退款（refunded_coins 必須為 0，charged 必須為 130）。
//   2) capacity_saturated：換道門檻（WORKFLOW_QUEUE_SWITCH_MS=300000）內必須
//      __queueSwitches ≥ 1 且畫布提示幀原文含「5 分钟」。
// 跑法：timeout 120 bun run deploy-staging/gateway/workflow-gw-1002-fixes.test.ts
process.env.PLATFORM_BASE = "http://test.local"
process.env.QUOTA_URL = "http://test.local/v1/quota"
process.env.OPENCODE_URL = "http://test.local"
process.env.WORKFLOW_QUEUE_SWITCH_MS = "300000"

import type { SessionState } from "./types-gateway.ts"

const TEST_BASE = "http://test.local"

function makeState(sessionId: string, captured: string[]): SessionState {
  return {
    sessionId,
    apiKey: "sk-test",
    opencodeSessionId: "oc_test",
    clients: new Set([{ controller: { enqueue: (f: Uint8Array) => captured.push(new TextDecoder().decode(f)) } }]),
    pendingConfirms: new Map(),
    pendingQuestions: new Map(),
    resolvedConfirms: new Map(),
    eventCounter: 0,
    replayBuffer: [],
    lastActivityAt: Date.now(),
    turnTerminalNodes: [],
    partTextEmitted: new Map(),
    partStripState: new Map(),
    announcedUrls: new Set(),
    toolStatusSeen: new Set(),
    toolInvokeSeen: new Set(),
    stepCostLogged: new Set(),
    messageRole: new Map(),
    suppressedParts: new Set(),
    canvasUnitByCall: new Map(),
    canvasUnitByTask: new Map(),
    sessionTasks: new Map(),
    turnGen: 1,
  } as unknown as SessionState
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function run(): Promise<void> {
  const assert = await import("node:assert/strict")
  const gw = await import("./workflow-gw.ts")

  // ── 缺陷 1：假退款不再發生（cost_coins 延遲落地）────────────────────────
  {
    const captured: string[] = []
    const state = makeState("sess-refund", captured)
    const wfid = "wf_fake_refund_1002"
    const jobId = "job_late_cost"
    gw.recordWorkflowApproval(wfid, 130)
    gw.workflowJobs.set(wfid, new Map([[jobId, { nodeId: "n1", kind: "video" }]]))

    const started = Date.now()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : (input as Request).url ?? input)
      if (url.includes(`/v1/videos/${jobId}`)) {
        // 控面投影延遲：前兩次查詢 cost_coins 仍為 0，約 10 秒後才落帳 130。
        const cost = Date.now() - started >= 9_000 ? 130 : 0
        return json({ status: "succeeded", cost_coins: cost })
      }
      return json({}, 404)
    }) as typeof fetch
    try {
      const report = await gw.settleWorkflowCharges(state, wfid)
      const billing = gw.workflowBilling.get(wfid)!
      console.log(`  [1] report.charged=${report.charged} unresolved=${report.unresolved} refunded_coins=${billing.refunded_coins}`)
      assert.equal(report.charged, 130, "實扣應等到 130（不再把「還沒查到」當 0）")
      assert.equal(report.unresolved, 0, "延遲落地後不應殘留 unresolved")
      assert.equal(billing.refunded_coins, 0, "不得記出假退款")
      assert.equal(billing.billing_status, "confirmed", "無退款則狀態不得翻 refunded")
      console.log("  ✓ [1] 假退款不再發生（cost 延遲 10s 仍結算到 130、退款 0）")
    } finally {
      globalThis.fetch = realFetch
    }
  }

  // ── 缺陷 2：capacity_saturated 在門檻內先換道並提示 5 分鐘 ───────────────
  {
    const captured: string[] = []
    const state = makeState("sess-switch", captured)
    const node = {
      id: "shot1-video-0",
      kind: "video",
      metadata: { model: "modelA", prompt: "a sunset shot", duration_seconds: 5, size: "720p" },
    }
    const graph = { nodes: [node], connections: [] as { from: string; to: string }[] }

    let jobACalls = 0
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : (input as Request).url ?? input)
      const method = (init?.method ?? (input as Request)?.method ?? "GET").toUpperCase()
      if (url.endsWith("/v1/model-status")) {
        return json({
          models: [
            { id: "modelA", media_type: "video", availability: "available", channel_id: "c1", last_24h: { success_rate: 0.9, delivered: 5 } },
            { id: "modelB", media_type: "video", availability: "available", channel_id: "c2", last_24h: { success_rate: 0.9, delivered: 5 } },
          ],
        })
      }
      if (url.endsWith("/v1/models")) {
        return json({ data: [
          { id: "modelA", x_coins_per_second: { "720": 5 } },
          { id: "modelB", x_coins_per_second: { "720": 5 } },
        ] })
      }
      if (url.includes("/v1/videos/generations") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string }
        return json({ task_id: body.model === "modelB" ? "jobB" : "jobA" }, 202)
      }
      if (url.includes("/v1/videos/jobA")) {
        jobACalls++
        // 第二次輪詢時把虛擬時鐘推過 5 分鐘換道門檻（門檻字面仍為 300000 → 文案 5 分钟）。
        if (jobACalls >= 2) offset = 300_001
        return json({ status: "queued", failure_class: "capacity_saturated: upstream concurrency limit" })
      }
      if (url.includes("/v1/videos/jobB")) {
        return json({ status: "succeeded", data: [{ url: `${TEST_BASE}/out.mp4` }], cost_coins: 25 })
      }
      if (url.includes("/api/generation-jobs/jobA") && method === "DELETE") {
        return json({ previous_status: "queued", refund: { amount: 25, full: true } })
      }
      return json({}, 404)
    }) as typeof fetch
    try {
      const r = await gw.submitWorkflowNode(state, node as never, new Map(), graph as never)
      const switches = Number((node.metadata as Record<string, unknown>).__queueSwitches ?? 0)
      const hintFrames = captured.filter((f) => f.includes("canvas.node.updated") && f.includes("排队"))
      console.log(`  [2] result.ok=${r.ok} content=${r.content} __queueSwitches=${switches} hintFrames=${hintFrames.length}`)
      console.log(`  [2] hint frame raw: ${hintFrames[0]?.trim().replace(/\n/g, " | ")}`)
      assert.equal(r.ok, true, "換道後應成功")
      assert.ok(switches >= 1, `capacity_saturated 應觸發換道，實得 __queueSwitches=${switches}`)
      assert.ok(hintFrames.length >= 1, "應有換道提示幀")
      assert.match(hintFrames[0], /5 分钟/, "提示幀原文須含門檻分鐘數「5 分钟」")
      console.log("  ✓ [2] capacity_saturated 門檻內換同價通道 + 5 分钟提示")
    } finally {
      globalThis.fetch = realFetch
      Date.now = realNow
    }
  }

  console.log("ALL PASS: workflow-gw 2026-10-02 三缺陷注入驗收")
  process.exit(0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  console.error("需以 bun 執行")
  process.exit(2)
} else {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
