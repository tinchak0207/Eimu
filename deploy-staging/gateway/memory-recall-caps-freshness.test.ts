/**
 * memory-recall-caps-freshness.test.ts — 2026-10-02 召回上限／session 累计位元组帽／新鲜度标示。
 *
 * 三组真值断言（守门件不算，全部验真行为）：
 *  1. 每次查询召回 ≤ RECALL_K_MAX(5)，预设 3；clampRecallK 收敛。
 *  2. 单 session 累计注入位元组 ≤ 60KB；超限降级（不抛错）。
 *  3. 新鲜度：今日/昨日/N 天前标示与 >1 天过期警示；年龄不改变分数与排序。
 * 跑法：bash deploy-staging/vps-tools/run-tests.sh memory-recall-caps-freshness.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  BM25_DEFAULT_K,
  RECALL_K_DEFAULT,
  RECALL_K_MAX,
  bm25Score,
  clampRecallK,
  clipToUtf8Bytes,
  memoryAgeDays,
  memoryAgeLabel,
  memoryFreshnessWarning,
  recallTop,
  renderRecallPrefix,
  utf8ByteLength,
  type RecallableDoc,
} from "./memory-recall.ts"
import {
  MEMORY_RECALL_SESSION_BYTE_BUDGET,
  memoryRecallPrefetch,
  memoryRecallSessionUsed,
  memoryRecallSessionBytes,
  resetMemoryRecallSessionUsage,
  takeMemoryRecallPrefix,
} from "./memory-wiring.ts"

// ── 语料：6 条命中 query "alpha"（罕见词 → BM25 过 1.0 门槛），其余为 filler。
const hitDocs: RecallableDoc[] = Array.from({ length: 6 }, (_, i) => ({
  domain: "d",
  slug: `hit-${i}`,
  description: "alpha",
  body: "alpha",
}))
const fillerDocs: RecallableDoc[] = Array.from({ length: 24 }, (_, i) => ({
  domain: "d",
  slug: `fill-${i}`,
  description: "filler",
  body: "filler",
}))
const bigCorpus = [...hitDocs, ...fillerDocs]

describe("每次查询召回上限（RECALL_K_MAX=5，预设 3）", () => {
  it("预设回 BM25_DEFAULT_K=3 条", () => {
    assert.equal(BM25_DEFAULT_K, RECALL_K_DEFAULT)
    const hits = recallTop("alpha", bigCorpus)
    assert.equal(hits.length, 3)
    for (const h of hits) assert.ok(h.score >= 1.0)
  })

  it("k=50 超帽 → 结构上 ≤ RECALL_K_MAX=5", () => {
    const hits = recallTop("alpha", bigCorpus, { k: 50 })
    assert.equal(hits.length, RECALL_K_MAX)
    assert.ok(hits.length <= 5)
  })

  it("k=4 → 4；k=1 → 1（帽内原样）", () => {
    assert.equal(recallTop("alpha", bigCorpus, { k: 4 }).length, 4)
    assert.equal(recallTop("alpha", bigCorpus, { k: 1 }).length, 1)
  })

  it("候选远多于上限时回传条数仍 ≤ 上限", () => {
    for (const k of [5, 8, 100, 9999]) {
      const hits = recallTop("alpha", bigCorpus, { k })
      assert.ok(hits.length <= RECALL_K_MAX, `k=${k} 回 ${hits.length} 条`)
    }
  })

  it("clampRecallK：非法/未给回预设 3；超帽收敛 5", () => {
    assert.equal(clampRecallK(undefined), 3)
    assert.equal(clampRecallK(""), 3)
    assert.equal(clampRecallK(0), 3)
    assert.equal(clampRecallK(-3), 3)
    assert.equal(clampRecallK(NaN), 3)
    assert.equal(clampRecallK(2), 2)
    assert.equal(clampRecallK("4"), 4)
    assert.equal(clampRecallK(99), RECALL_K_MAX)
    assert.equal(clampRecallK("5"), RECALL_K_MAX)
  })
})

describe("单 session 累计注入位元组上限（60KB，超限降级不抛错）", () => {
  it("多轮注入累计位元组 ≤ 上限且不抛错", () => {
    const sid = "sess-budget-1"
    resetMemoryRecallSessionUsage(sid)
    memoryRecallSessionBytes.delete(sid)
    // 每轮 prefix 为 1800 字 CJK ≈ 5400 bytes（renderRecallPrefix 的实际上界），
    // 跑 30 轮远超 60KB 帽值。
    const roundPrefix = renderRecallPrefix([
      { domain: "d", slug: "fat", description: "肥", body: "影".repeat(1700) },
    ])
    assert.ok(utf8ByteLength(roundPrefix) > 3000, `单轮 prefix 应够大：${utf8ByteLength(roundPrefix)}B`)
    let injected = 0
    let degraded = 0
    for (let i = 0; i < 30; i++) {
      memoryRecallPrefetch.set(sid, { prefix: roundPrefix, docRefs: [{ domain: "d", slug: "fat" }], at: Date.now() })
      const rec = takeMemoryRecallPrefix(sid)
      assert.ok(rec !== null, `第 ${i} 轮不应为 null（降级而非报错）`)
      injected += utf8ByteLength(rec.prefix)
      if (rec.prefix.length < roundPrefix.length) degraded += 1
    }
    assert.ok(injected <= MEMORY_RECALL_SESSION_BYTE_BUDGET, `累计 ${injected}B 应 ≤ ${MEMORY_RECALL_SESSION_BYTE_BUDGET}B`)
    assert.ok(degraded > 0, "应至少有一轮被降级裁切/跳过")
    assert.equal(memoryRecallSessionUsed(sid), injected)
    resetMemoryRecallSessionUsage(sid)
  })

  it("帽用尽后整段不注入（prefix 空，不抛错）", () => {
    const sid = "sess-budget-2"
    memoryRecallSessionBytes.set(sid, MEMORY_RECALL_SESSION_BYTE_BUDGET)
    memoryRecallPrefetch.set(sid, { prefix: "任何内容", docRefs: [{ domain: "d", slug: "x" }], at: Date.now() })
    const rec = takeMemoryRecallPrefix(sid)
    assert.ok(rec !== null)
    assert.equal(rec!.prefix, "")
    resetMemoryRecallSessionUsage(sid)
  })

  it("TTL 过期的预取不注入也不记帐", () => {
    const sid = "sess-budget-3"
    resetMemoryRecallSessionUsage(sid)
    memoryRecallPrefetch.set(sid, {
      prefix: "旧候选",
      docRefs: [{ domain: "d", slug: "x" }],
      at: Date.now() - 6 * 60 * 1000,
    })
    assert.equal(takeMemoryRecallPrefix(sid), null)
    assert.equal(memoryRecallSessionUsed(sid), 0)
  })
})

describe("记忆新鲜度标示（不做数值衰减）", () => {
  const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()
  const doc = (slug: string, daysAgo: number | null): RecallableDoc => ({
    domain: "领域",
    slug,
    description: "x",
    body: "正文内容。",
    ...(daysAgo === null ? {} : { updatedAt: iso(daysAgo) }),
  })

  it("今日无警示、昨日无警示、5 天前有过期警示", () => {
    const today = renderRecallPrefix([doc("t", 0)], { nowMs: NOW })
    const yesterday = renderRecallPrefix([doc("y", 1)], { nowMs: NOW })
    const old = renderRecallPrefix([doc("o", 5)], { nowMs: NOW })
    assert.ok(today.includes("（今日更新）"))
    assert.ok(!today.includes("过期警示"))
    assert.ok(yesterday.includes("（昨日更新）"))
    assert.ok(!yesterday.includes("过期警示"))
    assert.ok(old.includes("（5 天前更新）"))
    assert.ok(old.includes("过期警示"))
    assert.ok(old.includes("5 天前"))
    assert.ok(old.includes("断言前先以现场工具验证"))
  })

  it(">1 天才警示（2 天前；1 天前＝噪音不警示）", () => {
    assert.equal(memoryFreshnessWarning(1), "")
    assert.equal(memoryFreshnessWarning(0), "")
    assert.ok(memoryFreshnessWarning(2).includes("2 天前"))
  })

  it("无时间栏位／非法时间戳 → 不加任何时间标示（不编造）", () => {
    const none = renderRecallPrefix([doc("n", null)], { nowMs: NOW })
    assert.ok(none.includes("- [领域] n\n  正文内容。\n"))
    assert.ok(!none.includes("更新）"))
    assert.ok(!none.includes("过期警示"))
    assert.equal(memoryAgeDays(undefined), null)
    assert.equal(memoryAgeDays("not-a-date"), null)
    assert.equal(memoryAgeLabel(null), null)
  })

  it("未来时间戳夹为 0（今日，无警示）", () => {
    assert.equal(memoryAgeDays(iso(-3), NOW), 0)
    assert.equal(memoryAgeLabel(0), "今日")
  })

  it("分数相同时年龄不影响排序（renderRecallPrefix 保持输入序，不按年龄重排）", () => {
    const a = doc("old", 5)
    const b = doc("mid", 1)
    const c = doc("new", 0)
    const out = renderRecallPrefix([a, b, c], { nowMs: NOW })
    const posOld = out.indexOf("old")
    const posMid = out.indexOf("mid")
    const posNew = out.indexOf("new")
    assert.ok(posOld < posMid && posMid < posNew, `输出序 ${posOld}/${posMid}/${posNew} 应维持输入序`)
  })

  it("年龄不进入 BM25 分数（仅时间栏位不同 → 分数全等）", () => {
    const base = { domain: "d", slug: "s", description: "alpha", body: "alpha" }
    const fresh: RecallableDoc = { ...base, updatedAt: iso(0) }
    const stale: RecallableDoc = { ...base, updatedAt: iso(400) }
    const scores = bm25Score("alpha", [fresh, stale])
    assert.equal(scores[0], scores[1])
    // 同分稳定排序：输入序保留
    const hits = recallTop("alpha", [fresh, stale], { k: 2, minScore: 0 })
    assert.deepEqual(hits.map((h) => h.doc), [fresh, stale])
  })
})

describe("UTF-8 位元组裁切（session 帽降级用）", () => {
  it("utf8ByteLength 以位元组计", () => {
    assert.equal(utf8ByteLength("记"), 3)
    assert.equal(utf8ByteLength("ab"), 2)
  })
  it("clipToUtf8Bytes 不切坏多位元组字元", () => {
    const s = "记忆体" // 9 bytes
    assert.equal(utf8ByteLength(clipToUtf8Bytes(s, 4)), 3)
    assert.equal(clipToUtf8Bytes(s, 4), "记")
    assert.equal(clipToUtf8Bytes(s, 0), "")
    assert.equal(clipToUtf8Bytes(s, 99), s)
  })
  it("clipToUtf8Bytes 不切开代理对（emoji）", () => {
    const s = "a😀b" // a(1) + 😀(4) + b(1) = 6 bytes
    const clipped = clipToUtf8Bytes(s, 3)
    assert.equal(clipped, "a")
    assert.ok(!clipped.includes("\ufffd"))
  })
})
