/**
 * memory-fresh-creative.test.ts — 新创作闸门（2026-10-01 翻旧账事故）：
 * 用户要新创意时，旧专案档案不得进 system；平时专案档案前置复用纪律且不被截断吃掉。
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

const pref = { id: "p1", domain: "music", slug: "pref-theme-song-audio-only", description: "主题曲只交音频", body: "除非点名 MV" }
const proj = { id: "x1", domain: "anime-project", slug: "yuri-op-brief", description: "《潮汐绣线》百合番 OP", body: "16 镜、89s、MIO/AKARI" }
const mem = (docs: unknown[]) => ({ user_profile: {}, lessons: [], memory_docs: docs }) as any

describe("isFreshCreativeRequest", () => {
  it("命中新创意表述", () => {
    for (const t of [
      "我想要2026热门日漫风格的百合番MV片头曲 搞漂亮点有卡点 新创意",
      "来个全新的世界观",
      "这次原创，不要沿用之前的",
      "从零做一部短片",
      "give me a brand-new concept",
    ]) assert.equal(isFreshCreativeRequest(t), true, t)
  })
  it("续作/普通请求不命中", () => {
    for (const t of ["接着做潮汐绣线第 5 镜", "把这张图放大到 4K", "继续上次的 MV"]) {
      assert.equal(isFreshCreativeRequest(t), false, t)
    }
  })
})

describe("isPreferenceMemoryDoc", () => {
  it("pref-* 为偏好，专案 brief 不是", () => {
    assert.equal(isPreferenceMemoryDoc(pref), true)
    assert.equal(isPreferenceMemoryDoc(proj), false)
  })
})

describe("buildMemoryInjectionBlocks 新创作闸门", () => {
  it("新创意：专案档案零注入，偏好保留", () => {
    const out = buildMemoryInjectionBlocks(mem([proj, pref]), false, { freshCreative: true }).lines.join("\n")
    assert.ok(!out.includes("潮汐绣线"))
    assert.ok(!out.includes(PROJECT_REUSE_RULE))
    assert.ok(out.includes("pref-theme-song-audio-only"))
  })
  it("平时：专案档案带复用纪律，偏好排在前", () => {
    const out = buildMemoryInjectionBlocks(mem([proj, pref]), false).lines.join("\n")
    const iPref = out.indexOf("pref-theme-song"), iRule = out.indexOf(PROJECT_REUSE_RULE), iProj = out.indexOf("潮汐绣线")
    assert.ok(iPref >= 0 && iRule > iPref && iProj > iRule)
  })
  it("专案正文超长被截断时纪律仍完整", () => {
    const fat = { ...proj, body: "长".repeat(5000) }
    const out = buildMemoryInjectionBlocks(mem([fat]), false).lines.join("\n")
    assert.ok(out.includes(PROJECT_REUSE_RULE))
    assert.ok(out.endsWith("（已截断）") || out.length <= 2400)
  })
})
