/**
 * outbound-sanitize.test.ts — S2b 內部框架段剝離：2026-09-21 e2e 擴充標題清單
 * （progress summary / verdict / issues / evidence / beats / shots / timeline_ops）
 * ＋ 誤傷防護（正文單詞、代碼柵欄、中文標題）。
 * 跑法：npx --yes tsx --test deploy-staging/gateway/outbound-sanitize.test.ts
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  INTERNAL_SECTION_HEADING_RE,
  stripOutboundFeed,
  stripOutboundFlush,
  type PartStripState,
} from "./outbound-sanitize.ts"

const newState = (): PartStripState => ({ pending: "", suppress: false, fence: false, sawEnglish: false })

/** 餵完整文本（含尾換行）並 flush，模擬一個 part 的完整出站生命週期。 */
const runThrough = (text: string): string => {
  const st = newState()
  return stripOutboundFeed(st, text) + stripOutboundFlush(st)
}

describe("S2b 2026-09-21 擴充標題：內部段整段剝離", () => {
  it("## Progress Summary 段被剝，下一個正文中國標題恢復輸出", () => {
    const out = runThrough("正文第一行。\n## Progress Summary\n内部进度内容不应外泄\n## 真正的中文标题\n正文恢复。\n")
    assert.ok(!out.includes("Progress Summary"), `不应包含标题：${out}`)
    assert.ok(!out.includes("内部进度内容"), `不应包含段体：${out}`)
    assert.ok(out.includes("正文第一行。"))
    assert.ok(out.includes("## 真正的中文标题"))
    assert.ok(out.includes("正文恢复。"))
  })
  it("### verdict 段被剝（critic 交付契約欄位名；段體吞到下一個標題＝既有 suppress 語義）", () => {
    const out = runThrough("### verdict\n内部英文段体 FAIL details\n## 用户正文标题\n中文结论在正文。\n")
    assert.ok(!out.includes("verdict"), `不应包含标题：${out}`)
    assert.ok(!out.includes("内部英文段体"), `不应包含段体：${out}`)
    assert.ok(out.includes("## 用户正文标题"))
    assert.ok(out.includes("中文结论在正文。"))
  })
  it("## beats / ## shots / ## timeline_ops 各自成段被剝（suppress 到下個標題恢復＝既有語義）", () => {
    for (const h of ["beats", "shots", "timeline_ops"]) {
      const out = runThrough(`前文。\n## ${h}\n机器字段内容\n## 用户标题\n后文正常。\n`)
      assert.ok(!out.includes(`## ${h}`), `${h} 标题应被剥`)
      assert.ok(!out.includes("机器字段内容"), `${h} 段体应被剥`)
      assert.ok(out.includes("前文。") && out.includes("后文正常。"), `${h} 前后正文应保留：${out}`)
    }
  })
  it("标题带冒号/大小写变体也命中（既有旗标 /i 与 :? 容差）", () => {
    assert.ok(INTERNAL_SECTION_HEADING_RE.test("## Progress Summary"))
    assert.ok(INTERNAL_SECTION_HEADING_RE.test("## progress summary:"))
    assert.ok(INTERNAL_SECTION_HEADING_RE.test("### VERDICT"))
    assert.ok(INTERNAL_SECTION_HEADING_RE.test("#### Evidence:"))
    assert.ok(!INTERNAL_SECTION_HEADING_RE.test("## Progress Summary 加了后缀"))
    assert.ok(!INTERNAL_SECTION_HEADING_RE.test("## 重新审视 issues 的方案"))
  })
})

describe("S2b 誤傷防護", () => {
  it("正文含单词 issues/evidence 的句子不被误剥", () => {
    const out = runThrough("我们分析了本次生成的 issues 与 evidence，结论如下。\n下一行。\n")
    assert.equal(out, "我们分析了本次生成的 issues 与 evidence，结论如下。\n下一行。\n")
  })
  it("代码栅栏内的 ## beats 直通（柵欄內容不誤傷）", () => {
    const out = runThrough("说明：\n```\n## beats\n- beat 1\n```\n栅栏后正文。\n")
    assert.ok(out.includes("## beats"), `栅栏内标题应直通：${JSON.stringify(out)}`)
    assert.ok(out.includes("- beat 1"))
    assert.ok(out.includes("栅栏后正文。"))
  })
  it("## 真正的中文标题 不受影响", () => {
    const out = runThrough("## 真正的中文标题\n中文正文。\n")
    assert.equal(out, "## 真正的中文标题\n中文正文。\n")
  })
  it("既有清单回归：## Work State 仍被剥（改动未破坏旧标题；suppress 到下個標題恢復）", () => {
    const out = runThrough("## Work State\n内部状态\n## 用户标题\n正文。\n")
    assert.ok(!out.includes("Work State"))
    assert.ok(out.includes("正文。"))
  })
})
