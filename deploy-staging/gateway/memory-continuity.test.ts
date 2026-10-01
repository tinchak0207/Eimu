/**
 * memory-continuity.test.ts — H17 首回合連續性（資產索引＋同題重下提示）、批次時窗、M6 研究披露。
 * 跑法：npx --yes tsx --test --test-force-exit deploy-staging/gateway/memory-continuity.test.ts
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import {
  buildFirstTurnContinuityLines,
  buildMemoryInjectionBlocks,
  buildRecentAssetIndex,
  detectRepeatTopic,
  memoryBatchHours,
  memoryBatchSlotKey,
} from "./memory-wiring.ts"

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)
const H = 3600_000
const row = (id: string, ageH: number, title: string, snap?: Record<string, unknown>) => ({
  sessionId: id,
  createdAt: NOW - ageH * H,
  updatedAt: NOW - ageH * H,
  data: { title, workflowSnapshot: snap },
})
const snap = {
  graph: { nodes: [{ id: "n1", title: "镜头1视频" }, { id: "n2", title: "镜头2视频" }] },
  nodeStatus: { n1: "done", n2: "failed" },
  nodeContent: { n1: "https://cdn.example/a.mp4", n2: "https://cdn.example/b.mp4" },
}

describe("H17 asset index", () => {
  it("lists done assets only, marks no-reuse, excludes self and stale", () => {
    const idx = buildRecentAssetIndex(
      [row("s1", 2, "百合OP", snap), row("self", 1, "x", snap), row("old", 100, "旧", snap)],
      { excludeSessionId: "self", nowMs: NOW },
    )
    assert.ok(idx)
    assert.match(idx!, /新创作不得沿用/)
    assert.match(idx!, /a\.mp4/)
    assert.doesNotMatch(idx!, /b\.mp4/)
    assert.equal(idx!.match(/→/g)!.length, 1)
  })
  it("no assets -> null", () => assert.equal(buildRecentAssetIndex([row("s", 1, "t")], { nowMs: NOW }), null))
})

describe("H17 repeat topic", () => {
  const rows = [row("a", 1, "日漫百合番MV片头曲"), row("b", 3, "日漫百合番MV片头曲 卡点版"), row("c", 5, "电商主图")]
  it("same topic >=2 rounds triggers confirm hint", () => {
    const lines = buildFirstTurnContinuityLines(rows, "new", "再做一个日漫百合番MV片头曲", NOW)
    assert.match(lines[0], /已做过 2 轮/)
    assert.match(lines[0], /确认本次要的新方向/)
  })
  it("different topic or outside window does not trigger", () => {
    assert.equal(detectRepeatTopic(rows, "给我画一张咖啡海报", { nowMs: NOW }).rounds, 0)
    assert.equal(detectRepeatTopic([row("z", 30, "日漫百合番MV片头曲")], "日漫百合番MV片头曲", { nowMs: NOW }).rounds, 0)
  })
  it("injected as separate block and does not auto-reuse", () => {
    const lines = buildFirstTurnContinuityLines(rows, "new", "日漫百合番MV片头曲", NOW)
    const out = buildMemoryInjectionBlocks(undefined, false, { continuityLines: lines })
    assert.equal(out.lines.length, 1)
    assert.match(out.lines[0], /同题重下提示/)
    assert.doesNotMatch(out.lines[0], /沿用旧轮产物[^。]*可以/)
  })
})

describe("H17 batch slots", () => {
  it("extra hours parsed, deduped, validated", () => {
    assert.deepEqual(memoryBatchHours(20, "2, 8,20,99,x"), [20, 2, 8])
    assert.deepEqual(memoryBatchHours(20, undefined), [20])
  })
  it("slot key is per date+hour; off-hour null", () => {
    assert.equal(memoryBatchSlotKey(new Date(Date.UTC(2026, 9, 2, 8, 5)), [20, 8]), "2026-10-02T08")
    assert.equal(memoryBatchSlotKey(new Date(Date.UTC(2026, 9, 2, 9, 5)), [20, 8]), null)
  })
})

describe("M6 research disclosure", () => {
  const tpl = JSON.parse(readFileSync(new URL("./spec-templates.json", import.meta.url), "utf8")) as Record<string, string>
  it("research template carries fixed disclosure and bans [2026 现行] without tool evidence", () => {
    assert.match(tpl.research, /本域無聯網工具，以下為內部知識，未驗證現行資訊/)
    assert.match(tpl.research, /禁止標注 \[2026 現行\]/)
    assert.match(tpl.research, /工具呼叫的結果證據/)
  })
})
