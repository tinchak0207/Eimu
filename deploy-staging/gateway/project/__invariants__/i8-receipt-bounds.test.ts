// I8（设计文档 §8 第八行）：回执大小——满量样本（256 op 补丁、200 节点 get）序列化 ≤ 契约字节数；
// 截断后 more 计数正确，失败/漂移不被截。
//
// 独立期望来源 = 契约常量（1024 / 6144 / 4096 / 2048，本档手写），不 import 被测实现的 LIMITS。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

process.env.HARNESS_INTERNAL_TOKEN = "s18-i8-token"

const PATCH_RECEIPT_BYTES = 1024
const DIGEST_BYTES = 6144
const NODE_VIEW_BYTES = 4096
const EVENTS_BYTES = 2048
const TOKEN = "s18-i8-token"

const { buildPatchReceipt, utf8Bytes } = await import("../receipt.ts")
const routes = await import("../routes.ts")
const { ensureProject } = await import("../store.ts")

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8")
const sessionId = "s18_i8_receipts"
const state: any = {
  sessionId,
  apiKey: "sk-i8-test-only",
  opencodeSessionId: `oc-${sessionId}`,
  pendingConfirms: new Map(),
  resolvedConfirms: new Map(),
  pendingQuestions: new Map(),
  projectMode: true,
  // 画布 pump 的 SSE 出口字段（假 state 也要有，避免 GET 时刷错误日志）。
  replayBuffer: [] as { id: number; frame: Uint8Array; strippable?: boolean }[],
  clients: new Set(),
  eventCounter: 0,
}

let restore: (() => void) | null = null

beforeAll(() => {
  restore = routes.configureProjectRoutes({
    state: (id: string) => (id === sessionId ? state : undefined),
    owned: (key: string, id: string) => (key === "sk-owner" && id === sessionId ? state : undefined),
    actor: () => ({ kind: "agent" }) as never,
    deps: () => ({
      session: state,
      ledger: { write: async () => {} },
      submitGeneration: async () => ({ ok: false, code: "bad_input", message: "unused", retryable: false }),
      execBridge: {
        call: async () => ({ ok: false, code: "bridge_unavailable", message: "unused", retryable: false }),
        result: async () => ({ state: "unknown" }),
      },
    }) as never,
    authorized: async () => true,
    confirm: () => undefined,
  })
})

afterAll(() => {
  restore?.()
})

function internal(pathname: string, body: unknown): Promise<Response> {
  return routes.handleProjectInternal(
    new Request(`http://127.0.0.1${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": TOKEN },
      body: JSON.stringify(body),
    }),
    pathname,
  )
}

const NODE = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: "keyframe", intent: "", params: { prompt: "p", model: "m" }, inputs: {}, refs: [], pinned: null,
  status: "done", signature: `sig_${id}`, lastRun: null, outputs: [], rev: 1, ...over,
})

async function make200NodeProject(): Promise<void> {
  const { store } = await ensureProject(sessionId)
  await store.update((g: any) => {
    for (let i = 0; i < 200; i++) {
      const id = `n${String(i).padStart(3, "0")}`
      g.nodes[id] = NODE(id, i % 29 === 0
        ? { status: "failed", error: { code: "provider_error", message: "上游 500：模型不可用", retryable: true, at: new Date(0).toISOString() } }
        : {})
      g.order.push(id)
    }
    for (let i = 0; i < 8; i++) {
      const id = `pin${i}`
      g.nodes[id] = NODE(id, { pinned: { by: "user", at: new Date(0).toISOString(), outputsSha: ["ab".repeat(32)], signatureAtPin: `sig_${id}` } })
      g.order.push(id)
    }
  })
  await store.appendEvents(
    Array.from({ length: 30 }, (_, i) => ({
      kind: "node_status",
      node: `n${String(i).padStart(3, "0")}`,
      data: { status: "done", note: `事件 ${i} ${"细节".repeat(20)}` },
    })) as never,
  )
}

describe("I8 回执字节上限与截断计数", () => {
  test("满量补丁回执（256 op）：≤1024B，more 计数 = 总数 - 展示数，失败/漂移不被截空", () => {
    const rejected = Array.from({ length: 256 }, (_, i) => ({ i, code: "BAD_VALUE" as const, node: `n${i}`, msg: `参数不合法：${"细节".repeat(30)}` }))
    const changed = Array.from({ length: 256 }, (_, i) => ({ node: `c${i}`, fields: ["prompt", "model", "size", "n"] }))
    const stale = Array.from({ length: 256 }, (_, i) => `s${i}`)
    const drift = Array.from({ length: 256 }, (_, i) => `d${i}`)
    const warnings = Array.from({ length: 256 }, (_, i) => `警告 ${i}：${"长".repeat(100)}`)
    const receipt = buildPatchReceipt({ ok: false, version: 9, applied: 0, rejected, changed, stale, drift, warnings })
    expect(utf8Bytes(receipt)).toBeLessThanOrEqual(PATCH_RECEIPT_BYTES)
    expect(bytes(receipt)).toBeLessThanOrEqual(PATCH_RECEIPT_BYTES)
    if (!receipt.more) throw new Error("满量样本必须有 more 计数")
    expect(receipt.rejected.length + (receipt.more.rejected ?? 0)).toBe(256)
    expect(receipt.changed.length + (receipt.more.changed ?? 0)).toBe(256)
    expect(receipt.stale.length + (receipt.more.stale ?? 0)).toBe(256)
    expect(receipt.drift.length + (receipt.more.drift ?? 0)).toBe(256)
    // 「出事了」的信号永不被截空：至少留一条失败与一条漂移。
    expect(receipt.rejected.length).toBeGreaterThan(0)
    expect(receipt.drift.length).toBeGreaterThan(0)
  })

  test("只有 drift：8 条全留、无 more；20 条 → 8 条 + more.drift=12", () => {
    const eight = buildPatchReceipt({ ok: true, version: 2, applied: 1, rejected: [], changed: [], stale: [], drift: ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"], warnings: [] })
    expect(eight.drift).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"])
    expect(eight.more?.drift).toBeUndefined()
    expect(bytes(eight)).toBeLessThanOrEqual(PATCH_RECEIPT_BYTES)

    const twenty = buildPatchReceipt({ ok: true, version: 2, applied: 1, rejected: [], changed: [], stale: [], drift: Array.from({ length: 20 }, (_, i) => `d${i}`), warnings: [] })
    expect(twenty.drift.length).toBe(8)
    expect(twenty.more?.drift).toBe(12)
    expect(bytes(twenty)).toBeLessThanOrEqual(PATCH_RECEIPT_BYTES)
  })

  test("200 节点 get：digest ≤6144B；node 视图 ≤4096B；events ≤2048B 且 ≤20 行", async () => {
    await make200NodeProject()
    const digestRes = await internal("/internal/project/get", { session_id: sessionId, view: "digest" })
    expect(digestRes.status).toBe(200)
    const digestBody = (await digestRes.json()) as any
    expect(bytes(digestBody)).toBeLessThanOrEqual(DIGEST_BYTES)
    expect(typeof digestBody.digest).toBe("string")
    // 摘要必须真的覆盖 200 个节点（不是空摘要达标）。
    const failedIds = Array.from({ length: 200 }, (_, i) => `n${String(i).padStart(3, "0")}`).filter((_, i) => i % 29 === 0)
    for (const id of failedIds) expect(digestBody.digest).toContain(id)
    for (let i = 0; i < 8; i++) expect(digestBody.digest).toContain(`pin${i}`)

    const nodeRes = await internal("/internal/project/get", { session_id: sessionId, view: "node", node: "n000", detail: "full" })
    const nodeBody = (await nodeRes.json()) as any
    expect(bytes(nodeBody)).toBeLessThanOrEqual(NODE_VIEW_BYTES)
    expect(nodeBody.node?.id).toBe("n000")

    const eventsRes = await internal("/internal/project/get", { session_id: sessionId, view: "events", since: 0 })
    const eventsBody = (await eventsRes.json()) as any
    expect(bytes(eventsBody)).toBeLessThanOrEqual(EVENTS_BYTES)
    expect(Array.isArray(eventsBody.events)).toBe(true)
    expect(eventsBody.events.length).toBeLessThanOrEqual(20)
    expect(eventsBody.truncated).toBe(true)
  })

  test("反例：跳过截断的 40KB 回执必须被契约字节闸拒绝", () => {
    const raw = { ok: false, version: 1, applied: 0, rejected: Array.from({ length: 200 }, (_, i) => ({ i, code: "BAD_VALUE", msg: "长".repeat(100) })), changed: [], stale: [], drift: [], warnings: [] }
    expect(() => {
      if (bytes(raw) > PATCH_RECEIPT_BYTES) throw new Error("回执超过契约字节数")
    }).toThrow(/契约字节数/)
    // 同一输入过 buildPatchReceipt 必须落到上限内。
    const fitted = buildPatchReceipt(raw as never)
    expect(bytes(fitted)).toBeLessThanOrEqual(PATCH_RECEIPT_BYTES)
    expect(fitted.rejected.length + (fitted.more?.rejected ?? 0)).toBe(200)
  })
})
