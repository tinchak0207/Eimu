// MODEL-SELECT：minimax-h3（斷路器 open / 0 交付）被排除，seedance 被選中；已存在節點寫死 minimax-h3 在生成前被替換。
// 跑法：timeout 120 bun run deploy-staging/gateway/video-model-select.test.ts
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const dir = mkdtempSync(join(tmpdir(), "wf-ms-"))
process.env.SESSIONS_DB_PATH = join(dir, "sessions.db")
process.env.PLATFORM_BASE = "http://127.0.0.1:1"
process.env.QUOTA_URL = "http://127.0.0.1:1/v1/quota"
process.env.OPENCODE_URL = "http://127.0.0.1:1"

const MODELS = [
  { id: "minimax-h3", media_type: "video", availability: "available", last_24h: { jobs: 6, delivered: 0, success_rate: 0 } },
  { id: "metaso-video", media_type: "video", availability: "available" },
  { id: "seedance-2.0", media_type: "video", availability: "available", last_24h: { jobs: 4, delivered: 3, success_rate: 0.75 } },
  { id: "grok-video-1.5", media_type: "video", availability: "unavailable", last_24h: { jobs: 5, delivered: 5, success_rate: 1 } },
  { id: "pixai-tsubaki2", media_type: "image", availability: "available" },
]

async function run(): Promise<void> {
  const assert = await import("node:assert/strict")
  const sel = await import("./video-model-select.ts")
  const gw = await import("./workflow-gw.ts")

  // 1. 純選型：minimax-h3 0 交付被排除；proven 的 seedance 勝；unavailable 的不選
  const ranked = sel.rankVideoModels(MODELS)
  assert.deepEqual(ranked.map((r) => r.id), ["seedance-2.0", "metaso-video"])
  assert.ok(!ranked.some((r) => r.id === "minimax-h3"))
  console.log("  ✓ rank: seedance-2.0(proven) 優先，minimax-h3/unavailable 排除")

  // 2. 斷路器 open 欄位也排除；無樣本者 seedance 優先
  const onlyUnproven = sel.pickVideoModel([
    { id: "minimax-h3", media_type: "video", availability: "available", breaker_state: "open" },
    { id: "metaso-video", media_type: "video", availability: "available" },
    { id: "seedance-2.0", media_type: "video", availability: "available" },
  ])
  assert.equal(onlyUnproven?.id, "seedance-2.0")
  assert.equal(onlyUnproven?.proven, false)
  assert.equal(sel.pickVideoModel([{ id: "minimax-h3", media_type: "video", availability: "available", breaker_state: "open" }]), null)
  console.log("  ✓ breaker open 排除；無證據者 seedance 優先；無人可選回 null")

  // 3. 已存在節點寫死 minimax-h3：生成前被替換並留回執
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ models: MODELS }), { status: 200 })) as typeof fetch
  try {
    const node = { id: "n1", kind: "video", role: "shot", title: "x", metadata: { model: "minimax-h3" } } as never
    const r = await gw.resolveActiveModel("minimax-h3", "video", "sk-test", node)
    assert.equal(r.switched, true)
    assert.equal(r.model, "seedance-2.0")
    assert.match(r.note ?? "", /minimax-h3.*seedance-2\.0/)
    const swap = (node as { metadata: Record<string, unknown> }).metadata.model_swap as { from: string; to: string }
    assert.equal(swap.from, "minimax-h3")
    assert.equal(swap.to, "seedance-2.0")
    console.log("  ✓ resolveActiveModel：minimax-h3(available 但 0 交付) → seedance-2.0，metadata.model_swap 回執")

    // 4. 默認選型掛點
    // pickDefaultVideoModel 掛點與 pickVideoModel 同源（stateForWorkflow 由請求入口賦值，隔離測試不構造）
    assert.equal(sel.pickVideoModel(MODELS)?.id, "seedance-2.0")
    console.log("  ✓ 默認選型（pickDefaultVideoModel 同源）→ seedance-2.0")

    // 5. proven 的 seedance 不被動
    const n2 = { id: "n2", kind: "video", role: "shot", title: "x", metadata: {} } as never
    const r2 = await gw.resolveActiveModel("seedance-2.0", "video", "sk-test", n2)
    assert.equal(r2.switched, false)
    console.log("  ✓ 健康模型不被替換")
  } finally {
    globalThis.fetch = realFetch
  }
}

test("MODEL-SELECT", async () => {
  await run()
})
