// I9（设计文档 §8 第九行）：R/AGENTS.md 每条规则带 [R-nn]，rules-map 双向精确，行数 ≤200。
//
// 独立期望来源 = 两个文件本身（AGENTS.md 的标签行、rules-map.ts 的键与 enforce 路径）。
// 反例：手造的「有规则无标签」「有标签无映射」「201 行」必须被检验器拒绝。
import "./fixtures/env"
import "./fixtures/fake-platform"
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const HERE = import.meta.dir
const DEPLOY_STAGING = join(HERE, "..", "..", "..")
const AGENTS_MD = join(DEPLOY_STAGING, "opencode-runtime", "AGENTS.md")
const MAX_LINES = 200 // 设计文档 §8 / §0.1 附带检查

const { RULES_MAP, UNMAPPED_RULES } = await import("../rules-map.ts")

const RULE_LINE_RE = /^- \[(R-\d{2})\] (\S.*)$/
const HEADING_RE = /^#{1,6} /

function tagsOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\n")) {
    const m = RULE_LINE_RE.exec(line.trim())
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** 检验器：AGENTS.md 结构 + 行数 + 标签与映射双向精确；不满足就抛错。 */
function checkRulesBinding(agentsText: string, mappedTags: readonly string[], maxLines = MAX_LINES): string[] {
  const lines = agentsText.split("\n")
  // 文件末尾换行不额外算一行（wc -l 口径）。
  const lineCount = agentsText.endsWith("\n") ? lines.length - 1 : lines.length
  if (lineCount > maxLines) throw new Error(`AGENTS.md ${lineCount} 行超过上限 ${maxLines}`)

  const tags: string[] = []
  // 「# 做事方法」起是手艺层（无代码强制点），不参与标签绑定；行数上限仍按全文计。
  const doctrineAt = lines.findIndex((l) => /^# 做事方法\s*$/.test(l.trim()))
  for (const [i, raw] of (doctrineAt >= 0 ? lines.slice(0, doctrineAt) : lines).entries()) {
    const line = raw.trim()
    if (!line || HEADING_RE.test(line)) continue
    const m = RULE_LINE_RE.exec(line)
    if (!m) throw new Error(`第 ${i + 1} 行没有 [R-nn] 标签：${line.slice(0, 40)}`)
    if (!m[2].trim()) throw new Error(`第 ${i + 1} 行标签后没有规则正文`)
    if (tags.includes(m[1])) throw new Error(`重复标签 ${m[1]}`)
    tags.push(m[1])
  }
  if (tags.length === 0) throw new Error("AGENTS.md 没有任何带标签的规则")

  const mapped = new Set(mappedTags)
  const missingMap = tags.filter((t) => !mapped.has(t))
  if (missingMap.length) throw new Error(`规则没有 rules-map 映射：${missingMap.join(", ")}`)
  const deadMap = [...mapped].filter((t) => !tags.includes(t))
  if (deadMap.length) throw new Error(`rules-map 有死映射（AGENTS.md 没有该规则）：${deadMap.join(", ")}`)
  return tags
}

describe("I9 AGENTS 规则绑定", () => {
  test("AGENTS.md 每条规则带 [R-nn]、行数 ≤200；rules-map 双向精确且强制文件存在", () => {
    const text = readFileSync(AGENTS_MD, "utf8")
    const tags = checkRulesBinding(text, Object.keys(RULES_MAP))
    expect(tags.length).toBe(Object.keys(RULES_MAP).length)
    expect(UNMAPPED_RULES.length).toBe(0)

    for (const [tag, mapping] of Object.entries(RULES_MAP)) {
      expect(typeof mapping.enforce).toBe("string")
      expect(mapping.enforce.trim().length).toBeGreaterThan(0)
      expect(typeof mapping.test).toBe("string")
      // test 必须指向可定位的测试名（不能是空愿望）。
      expect(mapping.test.trim().length).toBeGreaterThan(0)
      // enforce 里写到的每个文件必须真实存在（强制点不是幻觉）。
      const files = mapping.enforce.match(/deploy-staging\/[\w./-]+\.(?:ts|json|md)/g) ?? []
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) expect({ tag, file, exists: existsSync(join(DEPLOY_STAGING, "..", file)) }).toMatchObject({ exists: true })
    }

    // 被删规则清单（S17 产物）：v1 必须为空数组，且每项都带 tag+rule 两个字段。
    for (const item of UNMAPPED_RULES) {
      expect(typeof item.tag).toBe("string")
      expect(typeof item.rule).toBe("string")
    }
  })

  test("反例：无标签规则 / 死映射 / 201 行，检验器必须分别报错", () => {
    const good = "# x\n\n- [R-01] 规则一\n- [R-02] 规则二\n"
    expect(checkRulesBinding(good, ["R-01", "R-02"])).toEqual(["R-01", "R-02"])
    expect(() => checkRulesBinding(`${good}- 一条没有标签的愿望\n`, ["R-01", "R-02"])).toThrow(/没有 \[R-nn\] 标签/)
    expect(() => checkRulesBinding(good, ["R-01"])).toThrow(/没有 rules-map 映射：R-02/)
    expect(() => checkRulesBinding(good, ["R-01", "R-02", "R-99"])).toThrow(/死映射/)
    const tooLong = Array.from({ length: 201 }, () => "- [R-01] 规则").join("\n")
    expect(() => checkRulesBinding(tooLong, ["R-01"])).toThrow(/超过上限 200/)
  })
})
