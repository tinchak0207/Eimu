/**
 * memory-fresh-creative.test.ts — 新創作閘門（2026-10-01 翻舊賬事故）：
 * 用戶要新創意時，舊專案檔案不得進 system；平時專案檔案前置複用紀律且不被截斷吃掉。
 * 跑法：npx --yes tsx --test --test-force-exit deploy-staging/gateway/memory-fresh-creative.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildMemoryInjectionBlocks,
  isFreshCreativeRequest,
  isPreferenceMemoryDoc,
  PROJECT_REUSE_RULE,
} from "./memory-wiring.ts"

const pref = { id: "p1", domain: "music", slug: "pref-theme-song-audio-only", description: "主題曲只交音頻", body: "除非點名 MV" }
const proj = { id: "x1", domain: "anime-project", slug: "yuri-op-brief", description: "《潮汐繡線》百合番 OP", body: "16 镜、89s、MIO/AKARI" }
const mem = (docs: unknown[]) => ({ user_profile: {}, lessons: [], memory_docs: docs }) as any

describe("isFreshCreativeRequest", () => {
  it("命中新創意表述", () => {
    for (const t of [
      "我想要2026热门日漫风格的百合番MV片头曲 搞漂亮点有卡点 新创意",
      "来个全新的世界观",
      "这次原創，不要沿用之前的",
      "從零做一部短片",
      "give me a brand-new concept",
    ]) assert.equal(isFreshCreativeRequest(t), true, t)
  })
  it("續作/普通請求不命中", () => {
    for (const t of ["接着做潮汐繡線第 5 镜", "把这张图放大到 4K", "继续上次的 MV"]) {
      assert.equal(isFreshCreativeRequest(t), false, t)
    }
  })
})

describe("isPreferenceMemoryDoc", () => {
  it("pref-* 為偏好，專案 brief 不是", () => {
    assert.equal(isPreferenceMemoryDoc(pref), true)
    assert.equal(isPreferenceMemoryDoc(proj), false)
  })
})

describe("buildMemoryInjectionBlocks 新創作閘門", () => {
  it("新創意：專案檔案零注入，偏好保留", () => {
    const out = buildMemoryInjectionBlocks(mem([proj, pref]), false, { freshCreative: true }).lines.join("\n")
    assert.ok(!out.includes("潮汐繡線"))
    assert.ok(!out.includes(PROJECT_REUSE_RULE))
    assert.ok(out.includes("pref-theme-song-audio-only"))
  })
  it("平時：專案檔案帶複用紀律，偏好排在前", () => {
    const out = buildMemoryInjectionBlocks(mem([proj, pref]), false).lines.join("\n")
    const iPref = out.indexOf("pref-theme-song"), iRule = out.indexOf(PROJECT_REUSE_RULE), iProj = out.indexOf("潮汐繡線")
    assert.ok(iPref >= 0 && iRule > iPref && iProj > iRule)
  })
  it("專案正文超長被截斷時紀律仍完整", () => {
    const fat = { ...proj, body: "长".repeat(5000) }
    const out = buildMemoryInjectionBlocks(mem([fat]), false).lines.join("\n")
    assert.ok(out.includes(PROJECT_REUSE_RULE))
    assert.ok(out.endsWith("（已截斷）") || out.length <= 2400)
  })
})
