// 2026-10-02 三缺陷注入验收（真行为，非源码字串断言）。
//   1) settleWorkflowCharges：job succeeded 但 cost_coins 先 0、约 10 秒后才 130
//      → 不得记出假退款（refunded_coins 必须为 0，charged 必须为 130）。
//   2) capacity_saturated：换道门槛（WORKFLOW_QUEUE_SWITCH_MS=300000）内必须
//      __queueSwitches ≥ 1 且画布提示帧原文含「5 分钟」。
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

  // ── 缺陷 1：假退款不再发生（cost_coins 延迟落地）────────────────────────
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
        // 控面投影延迟：前两次查询 cost_coins 仍为 0，约 10 秒后才落帐 130。
        const cost = Date.now() - started >= 9_000 ? 130 : 0
        return json({ status: "succeeded", cost_coins: cost })
      }
      return json({}, 404)
    }) as typeof fetch
    try {
      const report = await gw.settleWorkflowCharges(state, wfid)
      const billing = gw.workflowBilling.get(wfid)!
      console.log(`  [1] report.charged=${report.charged} unresolved=${report.unresolved} refunded_coins=${billing.refunded_coins}`)
      assert.equal(report.charged, 130, "实扣应等到 130（不再把「还没查到」当 0）")
      assert.equal(report.unresolved, 0, "延迟落地后不应残留 unresolved")
      assert.equal(billing.refunded_coins, 0, "不得记出假退款")
      assert.equal(billing.billing_status, "confirmed", "无退款则状态不得翻 refunded")
      console.log("  ✓ [1] 假退款不再发生（cost 延迟 10s 仍结算到 130、退款 0）")
    } finally {
      globalThis.fetch = realFetch
    }
  }

  // ── 缺陷 2：capacity_saturated 在门槛内先换道并提示 5 分钟 ───────────────
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
        // 第二次轮询时把虚拟时钟推过 5 分钟换道门槛（门槛字面仍为 300000 → 文案 5 分钟）。
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
      assert.equal(r.ok, true, "换道后应成功")
      assert.ok(switches >= 1, `capacity_saturated 应触发换道，实得 __queueSwitches=${switches}`)
      assert.ok(hintFrames.length >= 1, "应有换道提示帧")
      assert.match(hintFrames[0], /5 分钟/, "提示帧原文须含门槛分钟数「5 分钟」")
      console.log("  ✓ [2] capacity_saturated 门槛内换同价通道 + 5 分钟提示")
    } finally {
      globalThis.fetch = realFetch
      Date.now = realNow
    }
  }

  console.log("ALL PASS: workflow-gw 2026-10-02 三缺陷注入验收")
  process.exit(0)
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  console.error("需以 bun 执行")
  process.exit(2)
} else {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
