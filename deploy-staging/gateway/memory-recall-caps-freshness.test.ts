/**
 * memory-recall-caps-freshness.test.ts — 2026-10-02 召回上限／session 累計位元組帽／新鮮度標示。
 *
 * 三組真值斷言（守門件不算，全部驗真行為）：
 *  1. 每次查詢召回 ≤ RECALL_K_MAX(5)，預設 3；clampRecallK 收斂。
 *  2. 單 session 累計注入位元組 ≤ 60KB；超限降級（不拋錯）。
 *  3. 新鮮度：今日/昨日/N 天前標示與 >1 天過期警示；年齡不改變分數與排序。
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

// ── 語料：6 條命中 query "alpha"（罕見詞 → BM25 過 1.0 門檻），其餘為 filler。
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

describe("每次查詢召回上限（RECALL_K_MAX=5，預設 3）", () => {
  it("預設回 BM25_DEFAULT_K=3 條", () => {
    assert.equal(BM25_DEFAULT_K, RECALL_K_DEFAULT)
    const hits = recallTop("alpha", bigCorpus)
    assert.equal(hits.length, 3)
    for (const h of hits) assert.ok(h.score >= 1.0)
  })

  it("k=50 超帽 → 結構上 ≤ RECALL_K_MAX=5", () => {
    const hits = recallTop("alpha", bigCorpus, { k: 50 })
    assert.equal(hits.length, RECALL_K_MAX)
    assert.ok(hits.length <= 5)
  })

  it("k=4 → 4；k=1 → 1（帽內原樣）", () => {
    assert.equal(recallTop("alpha", bigCorpus, { k: 4 }).length, 4)
    assert.equal(recallTop("alpha", bigCorpus, { k: 1 }).length, 1)
  })

  it("候選遠多於上限時回傳條數仍 ≤ 上限", () => {
    for (const k of [5, 8, 100, 9999]) {
      const hits = recallTop("alpha", bigCorpus, { k })
      assert.ok(hits.length <= RECALL_K_MAX, `k=${k} 回 ${hits.length} 條`)
    }
  })

  it("clampRecallK：非法/未給回預設 3；超帽收斂 5", () => {
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

describe("單 session 累計注入位元組上限（60KB，超限降級不拋錯）", () => {
  it("多輪注入累計位元組 ≤ 上限且不拋錯", () => {
    const sid = "sess-budget-1"
    resetMemoryRecallSessionUsage(sid)
    memoryRecallSessionBytes.delete(sid)
    // 每輪 prefix 為 1800 字 CJK ≈ 5400 bytes（renderRecallPrefix 的實際上界），
    // 跑 30 輪遠超 60KB 帽值。
    const roundPrefix = renderRecallPrefix([
      { domain: "d", slug: "fat", description: "肥", body: "影".repeat(1700) },
    ])
    assert.ok(utf8ByteLength(roundPrefix) > 3000, `單輪 prefix 應夠大：${utf8ByteLength(roundPrefix)}B`)
    let injected = 0
    let degraded = 0
    for (let i = 0; i < 30; i++) {
      memoryRecallPrefetch.set(sid, { prefix: roundPrefix, docRefs: [{ domain: "d", slug: "fat" }], at: Date.now() })
      const rec = takeMemoryRecallPrefix(sid)
      assert.ok(rec !== null, `第 ${i} 輪不應為 null（降級而非報錯）`)
      injected += utf8ByteLength(rec.prefix)
      if (rec.prefix.length < roundPrefix.length) degraded += 1
    }
    assert.ok(injected <= MEMORY_RECALL_SESSION_BYTE_BUDGET, `累計 ${injected}B 應 ≤ ${MEMORY_RECALL_SESSION_BYTE_BUDGET}B`)
    assert.ok(degraded > 0, "應至少有一輪被降級裁切/跳過")
    assert.equal(memoryRecallSessionUsed(sid), injected)
    resetMemoryRecallSessionUsage(sid)
  })

  it("帽用盡後整段不注入（prefix 空，不拋錯）", () => {
    const sid = "sess-budget-2"
    memoryRecallSessionBytes.set(sid, MEMORY_RECALL_SESSION_BYTE_BUDGET)
    memoryRecallPrefetch.set(sid, { prefix: "任何內容", docRefs: [{ domain: "d", slug: "x" }], at: Date.now() })
    const rec = takeMemoryRecallPrefix(sid)
    assert.ok(rec !== null)
    assert.equal(rec!.prefix, "")
    resetMemoryRecallSessionUsage(sid)
  })

  it("TTL 過期的預取不注入也不記帳", () => {
    const sid = "sess-budget-3"
    resetMemoryRecallSessionUsage(sid)
    memoryRecallPrefetch.set(sid, {
      prefix: "舊候選",
      docRefs: [{ domain: "d", slug: "x" }],
      at: Date.now() - 6 * 60 * 1000,
    })
    assert.equal(takeMemoryRecallPrefix(sid), null)
    assert.equal(memoryRecallSessionUsed(sid), 0)
  })
})

describe("記憶新鮮度標示（不做數值衰減）", () => {
  const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString()
  const doc = (slug: string, daysAgo: number | null): RecallableDoc => ({
    domain: "领域",
    slug,
    description: "x",
    body: "正文内容。",
    ...(daysAgo === null ? {} : { updatedAt: iso(daysAgo) }),
  })

  it("今日無警示、昨日無警示、5 天前有過期警示", () => {
    const today = renderRecallPrefix([doc("t", 0)], { nowMs: NOW })
    const yesterday = renderRecallPrefix([doc("y", 1)], { nowMs: NOW })
    const old = renderRecallPrefix([doc("o", 5)], { nowMs: NOW })
    assert.ok(today.includes("（今日更新）"))
    assert.ok(!today.includes("過期警示"))
    assert.ok(yesterday.includes("（昨日更新）"))
    assert.ok(!yesterday.includes("過期警示"))
    assert.ok(old.includes("（5 天前更新）"))
    assert.ok(old.includes("過期警示"))
    assert.ok(old.includes("5 天前"))
    assert.ok(old.includes("斷言前先以現場工具驗證"))
  })

  it(">1 天才警示（2 天前；1 天前＝噪音不警示）", () => {
    assert.equal(memoryFreshnessWarning(1), "")
    assert.equal(memoryFreshnessWarning(0), "")
    assert.ok(memoryFreshnessWarning(2).includes("2 天前"))
  })

  it("無時間欄位／非法時間戳 → 不加任何時間標示（不編造）", () => {
    const none = renderRecallPrefix([doc("n", null)], { nowMs: NOW })
    assert.ok(none.includes("- [领域] n\n  正文内容。\n"))
    assert.ok(!none.includes("更新）"))
    assert.ok(!none.includes("過期警示"))
    assert.equal(memoryAgeDays(undefined), null)
    assert.equal(memoryAgeDays("not-a-date"), null)
    assert.equal(memoryAgeLabel(null), null)
  })

  it("未來時間戳夾為 0（今日，無警示）", () => {
    assert.equal(memoryAgeDays(iso(-3), NOW), 0)
    assert.equal(memoryAgeLabel(0), "今日")
  })

  it("分數相同時年齡不影響排序（renderRecallPrefix 保持輸入序，不按年齡重排）", () => {
    const a = doc("old", 5)
    const b = doc("mid", 1)
    const c = doc("new", 0)
    const out = renderRecallPrefix([a, b, c], { nowMs: NOW })
    const posOld = out.indexOf("old")
    const posMid = out.indexOf("mid")
    const posNew = out.indexOf("new")
    assert.ok(posOld < posMid && posMid < posNew, `輸出序 ${posOld}/${posMid}/${posNew} 應維持輸入序`)
  })

  it("年齡不進入 BM25 分數（僅時間欄位不同 → 分數全等）", () => {
    const base = { domain: "d", slug: "s", description: "alpha", body: "alpha" }
    const fresh: RecallableDoc = { ...base, updatedAt: iso(0) }
    const stale: RecallableDoc = { ...base, updatedAt: iso(400) }
    const scores = bm25Score("alpha", [fresh, stale])
    assert.equal(scores[0], scores[1])
    // 同分穩定排序：輸入序保留
    const hits = recallTop("alpha", [fresh, stale], { k: 2, minScore: 0 })
    assert.deepEqual(hits.map((h) => h.doc), [fresh, stale])
  })
})

describe("UTF-8 位元組裁切（session 帽降級用）", () => {
  it("utf8ByteLength 以位元組計", () => {
    assert.equal(utf8ByteLength("記"), 3)
    assert.equal(utf8ByteLength("ab"), 2)
  })
  it("clipToUtf8Bytes 不切壞多位元組字元", () => {
    const s = "記憶體" // 9 bytes
    assert.equal(utf8ByteLength(clipToUtf8Bytes(s, 4)), 3)
    assert.equal(clipToUtf8Bytes(s, 4), "記")
    assert.equal(clipToUtf8Bytes(s, 0), "")
    assert.equal(clipToUtf8Bytes(s, 99), s)
  })
  it("clipToUtf8Bytes 不切開代理對（emoji）", () => {
    const s = "a😀b" // a(1) + 😀(4) + b(1) = 6 bytes
    const clipped = clipToUtf8Bytes(s, 3)
    assert.equal(clipped, "a")
    assert.ok(!clipped.includes("\ufffd"))
  })
})
