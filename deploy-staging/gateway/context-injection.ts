// context-injection.ts — 上下文注入层（Claude Code 2.1.302 移植，2026-10-18）
//
// 真源窗口（逐窗口读自 /tmp/cc302/app/m0432_off242703960.js）：
//   * 记忆召回 @4067252、技能注入 @1525810、token 提醒 @2563534、
//     压缩续接 pzr @3106486、压缩提示词 uCe @3102152、静态/动态 latch @116300、
//     压缩边界重算 @2705800。
//   * 技能索引预算：skillListingMaxDescChars=1536、skillListingBudgetFraction=0.01
//     （m0432 尾端 lPt/apr/llt），本档按 Eimu 现状收敛到 1200 字符。
//   * token 提醒固定形状：`<total_tokens>N tokens left</total_tokens>`（OXt）。
//
// 所有注入都以 PromptSection 返回，便于 prompt-registry 统一记账、裁预算、
// 写破缓存审计。正文事实由呼叫端提供，本档不编造状态。
import { readdirSync, readFileSync } from "node:fs"
import {
  buildMemoryInjectionBlocks,
  MEMORY_L0_BUDGET,
  MEMORY_L1_BUDGET,
  MEMORY_INJECTION_TOTAL_BUDGET,
  MEMORY_CONTINUITY_BUDGET,
  type ContinuityRow,
} from "./memory-wiring.ts"
import { memoryAgeDays, memoryFreshnessWarning } from "./memory-recall.ts"
import type { RuntimeEnvironment, EnvironmentStability } from "./environment-facts.ts"
import { renderEnvironmentSection, environmentSectionStability } from "./environment-facts.ts"
import type { PromptSection } from "./prompt-registry.ts"

// ── 1. 记忆注入（L0/L1 预算沿用 Eimu 现值）───────────────────────────────
export { MEMORY_L0_BUDGET, MEMORY_L1_BUDGET, MEMORY_INJECTION_TOTAL_BUDGET, MEMORY_CONTINUITY_BUDGET }

export interface MemoryInjectionInput {
  userMemory: {
    user_profile: Record<string, unknown>
    lessons: string[]
    memory_docs?: Array<Record<string, unknown>>
    memory_index_md?: string
  } | undefined
  sharedEnabled: boolean
  freshCreative?: boolean
  continuityLines?: string[]
  sessionId?: string
}

export interface MemoryInjectionResult {
  lines: string[]
  sections: PromptSection[]
  trace: { private_docs: string[]; shared_index_chars: number }
  totalChars: number
}

/**
 * 复用既有 buildMemoryInjectionBlocks（不改其预算/截断语义），额外把每一块包成
 * turn 层 section 供账本使用。年龄不衰减，只由既有 memoryFreshnessWarning 在
 * >1 天时加「过期警示」文字（见 memory-wiring 的 pushDoc）。
 */
export function buildMemoryInjectionSections(input: MemoryInjectionInput): MemoryInjectionResult {
  const blocks = buildMemoryInjectionBlocks(input.userMemory, input.sharedEnabled, {
    freshCreative: input.freshCreative,
    continuityLines: input.continuityLines,
  })
  const labels = ["L0", "L1", "continuity"]
  const sections: PromptSection[] = blocks.lines.map((text, i) => ({
    id: `memory-${labels[i] ?? i}`,
    layer: "turn",
    priority: 40 + i,
    cacheable: false,
    breakingCacheReason: "记忆按本轮输入与账户状态重算",
    render: () => text,
  }))
  return {
    lines: blocks.lines,
    sections,
    trace: blocks.trace,
    totalChars: blocks.lines.reduce((n, s) => n + s.length, 0),
  }
}

/** 单条记忆的年龄警示（仅 >1 天；不做数值衰减）。 */
export function memoryAgeWarning(updatedAt: unknown, nowMs?: number): string {
  return memoryFreshnessWarning(memoryAgeDays(updatedAt, nowMs)).trim()
}

// ── 2. 技能索引（渐进披露：只给 name/description/tokenEstimate）────────────
export interface SkillIndexEntry {
  name: string
  description: string
  path: string
  tokenEstimate: number
  usage?: number
}

export interface SkillIndexOptions {
  dir?: string
  budgetChars?: number
  /** usage 高者优先保留；缺省全部按 name 排序。 */
  usage?: Record<string, number>
}

export const SKILL_INDEX_BUDGET_CHARS = (() => {
  const n = Number.parseInt(process.env.SKILL_INDEX_BUDGET_CHARS || "1200", 10)
  return Number.isFinite(n) && n > 0 ? n : 1200
})()

export const DEFAULT_SKILLS_DIR =
  process.env.EIMU_SKILLS_DIR ||
  (process.env.BEAST_SKILLS_DIR || "/opt/agent-harness/workspace/.opencode/skills")

function parseSkillFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ""
  const lines = fm.split(/\r?\n/)
  const readValue = (key: string): string => {
    const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
    if (idx < 0) return ""
    const first = lines[idx].replace(new RegExp(`^${key}:\\s*`), "").trim()
    if (!/^[|>][-+]?$/.test(first)) return first.replace(/^["']|["']$/g, "")
    // YAML block scalar：收后续缩进行，折叠成单行（技能索引只要一句说明）。
    const block: string[] = []
    for (let i = idx + 1; i < lines.length; i++) {
      if (!/^\s+/.test(lines[i])) break
      block.push(lines[i].trim())
    }
    return block.join(" ").trim()
  }
  const name = (readValue("name") || fallbackName).replace(/^["']|["']$/g, "")
  const description = readValue("description")
  return { name, description }
}

/** 默认目录扫描结果缓存：技能文件很少变，避免每轮同步扫描上百个 SKILL.md。 */
let defaultSkillCache: { at: number; rows: SkillIndexEntry[] } | null = null
const SKILL_CACHE_TTL_MS = 60_000

/** 扫描技能目录。读不到目录/空目录 → 空数组（不阻塞主流程）。 */
export function loadSkillIndex(opts: SkillIndexOptions = {}): SkillIndexEntry[] {
  const dir = opts.dir ?? DEFAULT_SKILLS_DIR
  const cacheable = opts.dir === undefined && opts.usage === undefined
  if (cacheable && defaultSkillCache && Date.now() - defaultSkillCache.at < SKILL_CACHE_TTL_MS) {
    return defaultSkillCache.rows
  }
  let names: string[] = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  const usage = opts.usage ?? {}
  const rows: SkillIndexEntry[] = []
  for (const dirName of names) {
    const path = `${dir}/${dirName}/SKILL.md`
    try {
      const raw = readFileSync(path, "utf8")
      const { name, description } = parseSkillFrontmatter(raw, dirName)
      const tokenEstimate = Math.max(1, Math.ceil((name.length + description.length) / 4))
      rows.push({ name, description, path, tokenEstimate, usage: usage[name] ?? 0 })
    } catch {
      rows.push({ name: dirName, description: "", path, tokenEstimate: 1, usage: usage[dirName] ?? 0 })
    }
  }
  // usage 高者优先；同 usage 按 name，保证确定性。
  const sorted = rows.sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0) || a.name.localeCompare(b.name))
  if (cacheable) defaultSkillCache = { at: Date.now(), rows: sorted }
  return sorted
}

/**
 * 技能索引段：只注入 name、description（单行截 120 字符）、tokenEstimate；
 * 正文由 skill 工具按需读取（渐进披露）。超预算按 usage 排序保留，末尾标注省略数量。
 */
export function buildSkillIndexSection(opts: SkillIndexOptions = {}): PromptSection | null {
  const rows = loadSkillIndex(opts)
  if (rows.length === 0) return null
  const budget = opts.budgetChars ?? SKILL_INDEX_BUDGET_CHARS
  const header = "【技能索引·按需载入】只列名称与说明；正文用 skill 工具读取，不要凭名字猜内容。"
  const tailFor = (omitted: number): string =>
    omitted > 0 ? `（另有 ${omitted} 个低使用技能未列出，需要时用 skill 工具按名载入）` : ""
  const lineBudget = Math.max(0, budget - header.length - 2)
  const lines: string[] = []
  let used = 0
  for (const row of rows) {
    const desc = row.description.replace(/\s+/g, " ").slice(0, 120)
    const line = `- ${row.name}${desc ? ` — ${desc}` : ""}（≈${row.tokenEstimate} tokens）`
    if (used + line.length + 1 > lineBudget) continue
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return null
  let omitted = rows.length - lines.length
  let text = `${header}\n${lines.join("\n")}${omitted > 0 ? `\n${tailFor(omitted)}` : ""}`
  while (text.length > budget && lines.length > 1) {
    lines.pop()
    omitted = rows.length - lines.length
    text = `${header}\n${lines.join("\n")}${omitted > 0 ? `\n${tailFor(omitted)}` : ""}`
  }
  if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 1))}…`
  return {
    id: "skill-index",
    layer: "session",
    priority: 30,
    cacheable: true,
    render: () => text,
  }
}

// ── 3. 环境事实（与 execution-contract 去重，同一事实只出现一次）──────────
export const ENVIRONMENT_FACT_KEYS = [
  "agent",
  "toolSurface",
  "capabilityCutoff",
  "sandbox",
  "workspace",
  "localBridge",
  "client",
] as const

const FACT_PREFIX: Array<{ key: string; prefix: string }> = [
  { key: "agent", prefix: "- 本回合挂载 agent" },
  { key: "toolSurface", prefix: "- 工具表" },
  { key: "capabilityCutoff", prefix: "- 能力断路" },
  { key: "sandbox", prefix: "- 沙箱" },
  { key: "workspace", prefix: "- 工作目录" },
  { key: "localBridge", prefix: "- 本机文件" },
  { key: "client", prefix: "- 客户端" },
]

/**
 * 去掉已在上游（execution-contract 等）说过的同一事实。
 * seen 可传 section id 或事实 key；同一条渲染行在 alreadyStated 中出现即丢弃。
 */
export function dedupeEnvironmentText(text: string, opts: { seenFacts?: Iterable<string>; alreadyStated?: string } = {}): string {
  const seen = new Set(opts.seenFacts ?? [])
  const already = opts.alreadyStated ?? ""
  const lines = text.split("\n")
  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (already.includes(trimmed)) return false
    const hit = FACT_PREFIX.find((f) => trimmed.startsWith(f.prefix))
    if (hit && seen.has(hit.key)) return false
    return true
  })
  return kept.join("\n")
}

export interface EnvironmentInjectionInput {
  env: RuntimeEnvironment
  seenFacts?: Iterable<string>
  alreadyStated?: string
  /** 覆盖稳定性判定（默认走 environmentSectionStability）。 */
  stability?: EnvironmentStability
}

/**
 * 环境段：agent/工具表/能力断路/沙箱/本机桥等事实。默认按真源推导稳定性：
 * session 内稳定的格子可快取，含本轮客户端事实时转 turn 并写破缓存理由。
 */
export function buildEnvironmentPromptSection(input: EnvironmentInjectionInput): PromptSection | null {
  const full = renderEnvironmentSection(input.env)
  const text = dedupeEnvironmentText(full, {
    seenFacts: input.seenFacts,
    alreadyStated: input.alreadyStated,
  }).trim()
  if (!text) return null
  const stability = input.stability ?? environmentSectionStability(input.env)
  return {
    id: "environment",
    layer: stability,
    priority: 35,
    cacheable: stability !== "turn",
    breakingCacheReason:
      stability === "turn" ? "工具表/设备/客户端环境是本轮事实，未知状态也须重新核实" : undefined,
    render: () => text,
  }
}

// ── 4. token 提醒 ────────────────────────────────────────────────────────
export const TOKEN_REMINDER_ENABLED = !/^(0|false|off|no)$/i.test(process.env.EIMU_TOKEN_REMINDER ?? "")
export const DEFAULT_CONTEXT_WINDOW_TOKENS = (() => {
  const n = Number.parseInt(process.env.EIMU_CONTEXT_WINDOW_TOKENS || "200000", 10)
  return Number.isFinite(n) && n > 0 ? n : 200000
})()

/** 4 chars/token 粗估（与 messages-gw.estimateTokensFromMessages 同口径）。 */
export function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4))
}

export function estimateRemainingTokens(
  usedTokens: number | null | undefined,
  opts: { contextWindowTokens?: number } = {},
): number {
  const window = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
  const used = typeof usedTokens === "number" && Number.isFinite(usedTokens) ? usedTokens : 0
  return Math.max(0, Math.floor(window - used))
}

/** 固定形状，与 Claude Code OXt 逐位元一致（只换数字）。 */
export function renderTokenReminder(remaining: number | "infinite"): string {
  return `<total_tokens>${remaining === "infinite" ? "Infinite" : Math.max(0, Math.floor(remaining))} tokens left</total_tokens>`
}

export function buildTokenReminderSection(
  remaining: number | "infinite",
  opts: { enabled?: boolean } = {},
): PromptSection | null {
  const enabled = opts.enabled ?? TOKEN_REMINDER_ENABLED
  if (!enabled) return null
  const text = renderTokenReminder(remaining)
  return {
    id: "total-tokens",
    layer: "turn",
    priority: 60,
    cacheable: false,
    breakingCacheReason: "剩余 token 数每回合变化",
    render: () => text,
  }
}

// ── 5. 压缩续接块 ────────────────────────────────────────────────────────
export const COMPACTION_CONTINUED_TEXT = `【压缩续接·上下文已重建】
上一窗对话已由摘要替换。本次重建只保留：系统提示、项目指令（AGENTS/CLAUDE 等）、记忆、最多 5 个最近读过的文件（长文件已截短）、plan、已加载 skills、后台代理与 shell 状态。其余内容不会自动回来。
续接要求（摘要必须覆盖下列 9 节，缺一节就回到磁盘/工具核实）：
1. 主要请求与意图：用户明确说过什么、要什么结果。
2. 关键技术概念：必须保留的领域词与约束。
3. 文件与代码段：改过/读过的文件、关键片段与原因。
4. 错误与修复：出现过什么错、怎么解决、用户纠正过什么。
5. 问题解决：已解决与仍在排查的部分。
6. 全部用户消息：只记用户本人输入（不含工具结果与系统提醒）；安全约束、预算、禁止项逐字保留。
7. 待办任务：用户明确要求但尚未完成的。
8. 当前工作：压缩前最后在做什么，精确到文件与命令。
9. 下一步：与用户最近请求直接对齐的一步；引用用户原话，不要自行扩题。
不要凭记忆补全摘要没写的内容；需要时先读文件或重跑只读命令核实。`

const compactionBoundary = new WeakMap<object, { at: number; preTokens?: number }>()

/** 压缩成功（验证通过、水位推进）后由 messages-gw 调用。 */
export function markCompactionBoundary(scope: object, info: { preTokens?: number } = {}): void {
  compactionBoundary.set(scope, { at: Date.now(), preTokens: info.preTokens })
}

/** 压缩后的下一回合取一次续接块（取出即清，不跨轮残留）。 */
export function takeCompactionContinuation(scope: object): PromptSection | null {
  const hit = compactionBoundary.get(scope)
  if (!hit) return null
  compactionBoundary.delete(scope)
  return {
    id: "compaction-continuation",
    layer: "turn",
    priority: 10,
    cacheable: false,
    breakingCacheReason: "压缩是会话级边界，下一回合必须重建上下文",
    render: () => COMPACTION_CONTINUED_TEXT,
  }
}

/** 供测试/诊断：不消费，只看是否有待注入的压缩边界。 */
export function hasCompactionContinuation(scope: object): boolean {
  return compactionBoundary.has(scope)
}

// ── 6. 附件/文件提及预算 ─────────────────────────────────────────────────
export const ATTACHMENT_TURN_CHAR_BUDGET = (() => {
  const n = Number.parseInt(process.env.ATTACHMENT_TURN_CHAR_BUDGET || "12000", 10)
  return Number.isFinite(n) && n > 0 ? n : 12000
})()

export interface AttachmentBudgetResult {
  text: string
  truncated: boolean
  originalChars: number
  chars: number
}

/**
 * 单轮附件总字符上限。只裁 [ATTACHMENTS_BLOCK]…[/ATTACHMENTS_BLOCK] 内部，
 * 保留块结构与其余用户正文；裁掉的部分标注「已截断」。
 */
export function applyAttachmentBudget(text: string, maxChars = ATTACHMENT_TURN_CHAR_BUDGET): AttachmentBudgetResult {
  const originalChars = text.length
  const re = /(\[ATTACHMENTS_BLOCK\])([\s\S]*?)(\[\/ATTACHMENTS_BLOCK\])/
  const m = re.exec(text)
  if (!m) return { text, truncated: false, originalChars, chars: originalChars }
  const inner = m[2] ?? ""
  if (inner.length <= maxChars) return { text, truncated: false, originalChars, chars: originalChars }
  const head = inner.slice(0, Math.max(0, maxChars - 20))
  const keptInner = `${head}\n（附件清单超 ${maxChars} 字符，已截断）`
  const next = text.slice(0, m.index) + m[1] + keptInner + m[3] + text.slice(m.index + m[0].length)
  return { text: next, truncated: true, originalChars, chars: next.length }
}

// ── 7. 聚合入口 ──────────────────────────────────────────────────────────
export interface ContextInjectionInput extends MemoryInjectionInput {
  env?: RuntimeEnvironment
  environmentSeenFacts?: Iterable<string>
  environmentAlreadyStated?: string
  skillIndex?: SkillIndexOptions & { enabled?: boolean }
  remainingTokens?: number | "infinite" | null
  attachments?: string[]
  attachmentBudgetChars?: number
}

export interface ContextInjectionResult {
  sections: PromptSection[]
  lines: string[]
  trace: { private_docs: string[]; shared_index_chars: number }
  totalChars: number
  attachments: AttachmentBudgetResult | null
}

/**
 * 一次性收集本轮要注入的上下文。调用方拿到 sections 后交给 renderPrompt 记账；
 * lines 用于既有 turn-tail 注入路径（语义不变）。
 */
export function collectContextInjections(input: ContextInjectionInput): ContextInjectionResult {
  const memory = buildMemoryInjectionSections(input)
  const sections: PromptSection[] = [...memory.sections]
  if (input.env) {
    const envSection = buildEnvironmentPromptSection({
      env: input.env,
      seenFacts: input.environmentSeenFacts,
      alreadyStated: input.environmentAlreadyStated,
    })
    if (envSection) sections.push(envSection)
  }
  if (input.skillIndex?.enabled !== false) {
    const skill = buildSkillIndexSection(input.skillIndex ?? {})
    if (skill) sections.push(skill)
  }
  if (input.remainingTokens !== undefined && input.remainingTokens !== null) {
    const token = buildTokenReminderSection(input.remainingTokens)
    if (token) sections.push(token)
  }
  let attachments: AttachmentBudgetResult | null = null
  if (input.attachments && input.attachments.length > 0) {
    const joined = input.attachments.join("\n")
    attachments = applyAttachmentBudget(joined, input.attachmentBudgetChars)
    if (attachments.truncated) {
      sections.push({
        id: "attachment-budget",
        layer: "turn",
        priority: 55,
        cacheable: false,
        breakingCacheReason: "附件清单随本轮用户输入变化",
        render: () => attachments?.text ?? "",
      })
    }
  }
  return {
    sections,
    lines: memory.lines,
    trace: memory.trace,
    totalChars: memory.totalChars,
    attachments,
  }
}
