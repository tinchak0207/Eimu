/**
 * claim-gate.ts — 无回执「完成主张」闸（2026-10-21）。
 *
 * 生产证据（已核实）：用户可见正文常见「已完成/已交付」而无任何 task_id/URL/落盘回执
 * （150 包 604 条矛盾）。本模组提供确定性判定与文案；接线在 events-translate-tools
 * （completed 时收证据）与 opencode-event-handler（session.idle 收盘拦截，形状照
 * canvas-write-gate：同款尾端 nudge 重投，不另造一套重投机制）。
 *
 * 红线：证据只在**工具真正 completed** 时收集；闸门只拦「零证据的完成主张」，
 * 不把任何 running/未完成状态改写成成功。
 */
import type { SessionState } from "./types-gateway.ts"
import { extractMediaTargets } from "./media-quality.ts"

export const CLAIM_GATE_MARK = "【完成主张闸·缺回执】"

/**
 * 媒体交付意图词表（用户委托里出现这些成品/媒介词 → 本轮属媒体交付，完成主张需要回执）。
 * 纯文字委托（方案/文案/歌词…）以正文为交付物，不应被索要 task_id/URL（2026-10-21 裁定）。
 */
export const MEDIA_DELIVERABLE_RE =
  /图片|图像|海报|封面|照片|视频|影片|短片|宣传片|广告片|成片|动画|音乐|歌曲|主题曲|配乐|音频|配音|语音|TTS|渲染|出图|生图|建模|影音|MV/i

/** 用户委托是否要求媒体成品（false = 纯文字委托，正文即交付物）。 */
export function hasMediaDeliverableIntent(text: string | null | undefined): boolean {
  return typeof text === "string" && MEDIA_DELIVERABLE_RE.test(text)
}

/** 证据清单上限（按 turn 重置，超出丢最旧）。 */
export const CLAIM_EVIDENCE_CAP = 128

/** 主张前后各 12 字符窗口内出现否定词 → 不算完成主张。 */
const CLAIM_CONTEXT_WINDOW = 12
const NEGATED_CLAIM_RE = /未完成|尚未|没能|无法|失败/

/**
 * 完成主张词表：已完成/已交付/已生成/已上传/已落盘/已发布/可以直接用/已经出图/已经出片。
 * 「已(经)?」同时覆盖「已经完成/已经交付」等常见写法；否定上下文由 12 字符窗口排除。
 */
export const COMPLETION_CLAIM_RE =
  /已(?:经)?(?:完成|交付|生成|上传|落盘|发布)|可以直接用|已经出图|已经出片/g

/** 本轮模型正文尾部保留长度（够覆盖最后一段交付话术）。 */
export const ASSISTANT_TAIL_CHARS = 4000

/** 绝对路径（≥2 段），与 events-translate-tools 的 ABS_PATH_RE 同口径，避免跨档循环依赖。 */
const ABS_PATH_GLOBAL_RE = /\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g

/**
 * 找第一条**未被否定**的完成主张；没有回 null。
 * 否定判定只看主张词前后各 12 字符（「未完成/尚未/没能/无法/失败」）。
 */
export function findCompletionClaim(text: string | null | undefined): string | null {
  if (typeof text !== "string" || text.length === 0) return null
  const re = new RegExp(COMPLETION_CLAIM_RE.source, "g")
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    const before = text.slice(Math.max(0, idx - CLAIM_CONTEXT_WINDOW), idx)
    const after = text.slice(idx + m[0].length, idx + m[0].length + CLAIM_CONTEXT_WINDOW)
    if (NEGATED_CLAIM_RE.test(before) || NEGATED_CLAIM_RE.test(after)) continue
    return m[0]
  }
  return null
}

/** 本轮 assistant 正文尾部累积（gen 变化即视为新一轮，自动重置）。 */
export function noteAssistantText(state: SessionState, text: string, turnGen: number): void {
  if (typeof text !== "string" || text.length === 0) return
  const cur = state.turnAssistantTail
  const base = cur && cur.gen === turnGen ? cur.text : ""
  state.turnAssistantTail = { gen: turnGen, text: (base + text).slice(-ASSISTANT_TAIL_CHARS) }
}

function stringifyEvidence(output: unknown): string {
  if (output === null || output === undefined) return ""
  if (typeof output === "string") return output.slice(0, 20000)
  try {
    return JSON.stringify(output).slice(0, 20000)
  } catch {
    return ""
  }
}

/**
 * 产出型工具名标记（小写包含任一即算）：只有真正产出／写入成品的工具带回的路径才算交付证据。
 * 排除 bash/read 类：读一张旧图／旧片也会在输出里留下绝对路径，那是「读过」不是「交付过」，
 * 若照收会让「已完成」凭旧档过关，闸门形同失效。task_id 与 http(s) URL 仍对其它非纯读、
 * 非 shell 工具生效（它们本身就是上游/成品回执，不是本地路径）；bash/shell 见 isShellTool 全不计。
 */
const PRODUCING_TOOL_MARKERS = [
  "write",
  "edit",
  "upload",
  "document",
  "canvas",
  "workflow_write",
  "generate",
  "image",
  "video",
  "music",
  "tts",
]

function isProducingTool(tool: string): boolean {
  const t = tool.toLowerCase()
  return PRODUCING_TOOL_MARKERS.some((marker) => t.includes(marker))
}

/**
 * 纯读工具（读档/列目录/搜索）：输出里的 URL、task_id、路径都只是「看到过的旧资料」，
 * 一律不算交付证据。2026-10-21 Hack：completed 的 read_file 输出里带任意 URL 就能让
 * 「已完成」通过闸门——读旧文件不是交付。mcp__<server>__read* 形态同样计入。
 */
export const PURE_READ_TOOL_RE =
  /^(?:read|read_file|file_read|glob|grep|ls|list|list_dir|cat|view|search)$|^mcp__[\w-]+__read[\w-]*$/i

export function isPureReadTool(tool: string): boolean {
  return PURE_READ_TOOL_RE.test(String(tool).trim())
}

/**
 * shell 类工具（bash/shell/sh/zsh）：**一律不计任何证据**。
 * 2026-10-21 Hack：completed 的 bash 输出只要含旧 URL（例如 `cat` 一份旧回执、`jq` 旧任务档）
 * 就会被记成交付证据，模型零交付也能让「已完成」过关。shell 输出可由命令任意伪造／读取旧档，
 * 不是交付回执；真正的交付必须走产出型工具（写档/生成/画布/工作流）。
 */
const SHELL_TOOL_RE = /^(?:bash|shell|sh|zsh)$/i

export function isShellTool(tool: string): boolean {
  return SHELL_TOOL_RE.test(String(tool).trim())
}

/**
 * completed 工具回执 → 收集交付证据（媒体 URL、task_id、绝对路径）。
 * 纯读工具与 shell 工具完全不计证据（路径/URL/task_id 都不计）；路径证据只接受产出型工具；
 * 按 turnGen 重置；上限 CLAIM_EVIDENCE_CAP，超出丢最旧。
 */
export function recordDeliveryEvidence(state: SessionState, tool: string, output: unknown): void {
  // 读旧文件不是交付：纯读工具连「本轮证据已收」的状态都不建立。
  if (isPureReadTool(tool)) return
  // shell 输出可伪造/可读旧档，不是交付回执；生成与落盘走产出型工具。
  if (isShellTool(tool)) return
  const gen = state.turnGen ?? 0
  if (!state.claimEvidence || state.claimEvidence.gen !== gen) {
    state.claimEvidence = { gen, items: [] }
  }
  const text = stringifyEvidence(output)
  if (!text) return
  const items = state.claimEvidence.items
  const push = (value: string): void => {
    if (!value || items.includes(value)) return
    items.push(value)
    if (items.length > CLAIM_EVIDENCE_CAP) items.shift()
  }
  for (const url of extractMediaTargets(text, 8)) push(`${tool}:url:${url}`)
  const taskId = /"task_id"\s*:\s*"([^"\s]+)"/.exec(text)
  if (taskId?.[1]) push(`${tool}:task_id:${taskId[1]}`)
  if (isProducingTool(tool)) {
    // URL 内部的路径片段不是「落盘路径」：先剔除 http(s) URL 再扫绝对路径，
    // 否则 https://host/a/b.png 会被同时记成 :url: 与 :path:/a/b.png（重复计数）。
    // 字符集排除引号/空白：JSON 回执里 URL 后紧跟 `","next":"…"`，用 \S+ 会吞掉后面整个字段。
    const pathText = text.replace(/https?:\/\/[^\s"'<>]+/gi, " ")
    for (const p of pathText.matchAll(ABS_PATH_GLOBAL_RE)) push(`${tool}:path:${p[0]}`)
  }
}

export interface ClaimGateInput {
  /** findCompletionClaim 的结果（null = 本轮没有完成主张）。 */
  claim: string | null
  /** 本轮已完成工具带回的证据条数（0 = 无回执）。 */
  evidenceCount: number
  /** 用户本轮明确只要纯文字成品（歌词/文案/方案）→ 正文即交付物，不要求回执。 */
  textOnlyRequest?: boolean
  /** 本轮是否媒体交付（false = 非媒体委托以正文为交付物，直接放行）。缺省按媒体处理（向后兼容）。 */
  mediaIntent?: boolean
  /** 用户本轮原话；未显式给 mediaIntent 时用它判定 hasMediaDeliverableIntent。 */
  promptText?: string
  /** 本 turnGen 已拦过一次（防死循环）。 */
  nudgeSent: boolean
  turnAborted?: boolean
  hasLastPromptBody?: boolean
}

/**
 * 收盘点是否应拦截 turn.done 并补写 nudge。
 * 条件：有未被否定的完成主张 + 零证据 + 本 turn 未拦过 + 非用户中止 + 有可重投的 lastPromptBody。
 * 纯文字成品以正文为交付物，不需要回执（2026-10-21 实测：只要歌词时「歌词已完成」被误拦，
 * 逼模型交 task_id/URL/路径，成品反被挤掉）——textOnlyRequest=true 直接放行。
 * 非媒体委托（写方案/文案/分析）同样以正文为交付物（2026-10-21「纯文字成品以正文交付」）：
 * mediaIntent=false 直接放行；未给 mediaIntent 时由 promptText 判定，promptText 也未给
 * 则按媒体处理（保持既有调用点语义不变）。
 */
export function shouldBlockCompletionForUnbackedClaim(input: ClaimGateInput): boolean {
  if (input.textOnlyRequest) return false
  const mediaIntent =
    input.mediaIntent ?? (typeof input.promptText === "string" ? hasMediaDeliverableIntent(input.promptText) : true)
  // 非媒体委托以正文为交付物：完成主张无需 task_id/URL/落盘路径。
  if (mediaIntent === false) return false
  if (!input.claim) return false
  if (input.evidenceCount > 0) return false
  if (input.nudgeSent) return false
  if (input.turnAborted) return false
  if (!input.hasLastPromptBody) return false
  return true
}

/** 收盘补写指令（接在 user 尾端，经 TAIL_PAYLOAD_MARKER；显示通道会截掉）。 */
export function buildClaimGateNudge(): string {
  return (
    `${CLAIM_GATE_MARK} 本轮正文写了完成/已交付一类结论，但没有任何回执证据（task_id、成品 URL、落盘路径全无）。` +
    `规则：要么给出真实回执——\`task_id\`、可访问的成品 \`URL\`、或绝对落盘路径，逐条列出；` +
    `要么明确写「失败/未完成」以及卡在哪一步。` +
    `禁止再写「已完成」「已生成」「已交付」之类没有回执的空话，也不得把计划或口头承诺当成交付。`
  )
}
