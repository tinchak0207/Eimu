/**
 * seat-preflight.ts — 席位能力预检（C1，2026-10-21）。
 *
 * 病灶（实测）：
 *   - editor 席位 `image_generate: false`，任务书却点名要它生图 → 子代理先派工、跑 10 分钟
 *     才报 BLOCKED（pack-0002 recon:6f97202c、pack-0005 recon:b0626a59）；
 *   - critic 席位 `write/shell: false`，任务书却要求落盘报告 → 报告根本写不出来，却给出
 *     PASS/PARTIAL（pack-0011、pack-0095）。
 *
 * 本模组只做**预检**：从任务书文本抽出被点名的工具，对照 expert/opencode-agents.json 的
 * 逐席位 tools 布尔表，找出「任务书要、席位没开」的项。命中**不阻断派工**（换席位是
 * orchestrator 的判断，不是网关的），只把一行可见提示追加到派工结果文本 + console.warn，
 * 让 orchestrator 在派遣当刻而不是 10 分钟后才知道。
 *
 * 口径（与既有轮子同源，不另造）：
 *   - 席位工具表读 `expert/opencode-agents.json`（`import.meta.dir`，与 subagent-dispatch.ts
 *     读 expert-ids.json、delivery-gate-contracts.ts 读交付契约同一种读法）；
 *   - 档缺失 / JSON 坏 → 空表 + 一行 warn，绝不抛（预检是提示，不是闸门）。
 *
 * 纯函数边界：checkSeatTools 不碰 I/O（table 由呼叫端传入），可单独验证；
 * loadSeatToolTable 负责读档与缓存（一次 warn）。
 */

import { readFileSync } from "node:fs"

/** 单个席位的定义（只声明本模组实际用到的栏位，其余原样忽略）。 */
export interface SeatDefinition {
  tools?: Record<string, boolean | undefined>
  [key: string]: unknown
}

/** agent id → 席位定义（来自 expert/opencode-agents.json 的顶层形状）。 */
export type SeatToolTable = Record<string, SeatDefinition | undefined>

/** 一项「任务书要、席位没开」的工具。 */
export interface SeatToolMiss {
  tool: string
  reason: string
}

/** checkSeatTools 的回传。missing 为空即 ok。 */
export interface SeatToolCheck {
  ok: boolean
  missing: SeatToolMiss[]
}

const SEAT_TABLE_FILE = "expert/opencode-agents.json"

let cachedTable: SeatToolTable | null = null
let warnedMissing = false

/**
 * 读席位工具表。缺档 / 解析失败 → 空表 + 一行 warn（只 warn 一次），不抛。
 * 结果缓存：整个进程生命周期只读一次盘（预检在每次派工的热路径上）。
 */
export function loadSeatToolTable(): SeatToolTable {
  if (cachedTable !== null) return cachedTable
  const file = `${import.meta.dir}/${SEAT_TABLE_FILE}`
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
    cachedTable = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SeatToolTable) : {}
    if (Object.keys(cachedTable).length === 0 && !warnedMissing) {
      warnedMissing = true
      console.warn(`[gateway] seat-preflight: 席位工具表为空（${file}）——预检跳过`)
    }
  } catch (e) {
    cachedTable = {}
    if (!warnedMissing) {
      warnedMissing = true
      console.warn(
        `[gateway] seat-preflight: 席位工具表不可读（${file}）：${e instanceof Error ? e.message : String(e)}——预检按空表跳过`,
      )
    }
  }
  return cachedTable
}

/** 全表所有席位提到的工具名并集（用来挡掉正文里不是工具的同名标识符）。 */
function knownToolNames(table: SeatToolTable): Set<string> {
  const names = new Set<string>()
  for (const seat of Object.values(table)) {
    const tools = seat?.tools
    if (!tools || typeof tools !== "object") continue
    for (const name of Object.keys(tools)) names.add(name)
  }
  return names
}

/**
 * 从任务书文本抽出**被点名**的工具候选：
 *   ① 反引号包裹的名字（`image_generate`、`image_generate(...)` 都取首个标识符）；
 *   ② 「调用 X」「使用 X」后的名字（允许紧跟反引号 / 引号）。
 * 回传去重后的候选；是否真为工具由呼叫端用 knownToolNames 过滤。
 * 正则一律在函数内新建（不复用带 g 的模组级物件，避免 lastIndex 污染）。
 */
function namedToolCandidates(taskText: string): string[] {
  const text = typeof taskText === "string" ? taskText : ""
  if (!text) return []
  const found = new Set<string>()
  for (const m of text.matchAll(/`\s*([A-Za-z][A-Za-z0-9_]*)[^`]*`/g)) found.add(m[1])
  for (const m of text.matchAll(/(?:调用|使用)\s*[`「"'“]?([A-Za-z][A-Za-z0-9_]*)/g)) found.add(m[1])
  return [...found]
}

/**
 * 纯函数：席位 agent 的 tools 表 vs 任务书点名工具。
 * 只把 `tools[X] === false` 判为缺失（表里没写的键不算「未启用」，避免误报）；
 * agent 不在表里 / 表为空 → { ok: true, missing: [] }（无从判断，不制造噪音）。
 */
export function checkSeatTools(agent: string, taskText: string, table: SeatToolTable): SeatToolCheck {
  const seat = agent && table ? table[agent] : undefined
  const tools = seat?.tools
  if (!tools || typeof tools !== "object") return { ok: true, missing: [] }
  const known = knownToolNames(table)
  const missing: SeatToolMiss[] = []
  for (const tool of namedToolCandidates(taskText)) {
    if (!known.has(tool)) continue
    if (tools[tool] === false) missing.push({ tool, reason: `席位 ${agent} 的 tools.${tool} = false` })
  }
  return { ok: missing.length === 0, missing }
}

/** 派工结果文本里追加的那一行（措辞为对外可见文案，改动前先确认）。 */
export function formatSeatPreflightNotice(agent: string, missing: SeatToolMiss[]): string {
  const tools = missing.map((m) => m.tool)
  return `【席位能力预检】席位 ${agent} 未启用工具 ${tools.join("、")}；任务书要求这些工具，子代理将无法调用，请先换席位或改派。`
}
