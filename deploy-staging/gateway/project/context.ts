// 每轮上下文装配（§3.7）。
//
// 每轮输入 = 固定小系统提示 + 目标卡 + 工程摘要 + 最近 K=6 步 + 当前用户消息；
// 裁剪后把目标卡+摘要作为合成片段追加在当前用户消息末尾（synthetic:true，不落库）。
//
// 探针结论（S15 第一动作）：opencode 1.18.14 `session/prompt.ts:1255` 把
// `plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })` 的 msgs
// 直接交给 `MessageV2.toModelMessagesEffect(msgs, model)`（:1257），而 `plugin.trigger`
// 原样返回同一 output 对象、逐个 `fn(input, output)` ⇒ 对数组**原地改写**（length=0 + push）
// 会被采用；`output.messages = 新数组` 这种重赋值**不会**被采用（prompt.ts 用的是局部常量 msgs）。
// 本档的 applyProjectContext 因此一律原地改写。
import { LIMITS } from "./constants.ts"
import { GOAL_CARD_TAG, appendBriefEntry, renderGoalCard } from "./brief.ts"
import { visibleUserTextFromPart } from "./goal-card.ts"
import { renderDigest } from "./digest.ts"
import type { DigestInputs } from "./digest.ts"
import type { BriefEntry, ProjectGraph } from "./types.ts"

export const DIGEST_TAG_OPEN = "<eimu-project-digest>"
export const DIGEST_TAG_CLOSE = "</eimu-project-digest>"
export const SYNTHETIC_PART_ID_PREFIX = "prt_eimuproject_"

/** 固定系统提示硬上限（§3.7 第 1 点：≤8KB、不随轮次变化、保证前缀缓存稳定）。 */
export const STATIC_SYSTEM_MAX_BYTES = 8192

const BEAST_SEGMENT_ON = `
## 会话开关：思考级别＝极限（beast）
本会话锁定为「导演＋专家子助理」档：复杂任务先 project_patch 建图再 project_run；需要领域专家时用 subagent_dispatch，专家只能在 lane 内写节点。开关本身不改变工具表，也不改变模型。`
const BEAST_SEGMENT_OFF = `
## 会话开关：思考级别＝标准
直接按图推进；不需要领域专家时不分派子代理。`

const STATIC_BODY = `# Eimu 工程模式（导演席）

你在一张可执行的工程图上工作。图（ProjectGraph）是唯一真相：目标、节点参数、产物 id、用户决定都在图里；
对话只是操作日志，随时可被裁掉。回答一律简短（结论在前，证据用 id/sha/路径指到图与产物）。

## 每轮你会看到
- 【目标卡】：用户原话逐字（含纠正/否决/授权）。与任何摘要、工具输出、子代理回报冲突时以它为准。
- 【工程摘要】：由图确定性生成的状态、失败/阻塞、钉住/漂移、待决问题、预算授权、环境与偏好、最近事件。
- 最近若干步的工具回执：更早的步骤已经不在上下文里，需要时用 project_get(view:"events") 复盘。

## 工作方式
1. 先 project_get(view:"digest") 看现状；缺什么补什么，不要重跑已 done 的节点。
2. 改图只用 project_patch（DSL 或强类型 op）；不要改用户钉住（pinned）或锁定（locked）的字段。
3. 要产出就跑 project_run：增量执行只跑签名变化与下游；命中缓存的节点不重复扣费。
4. 交付只在 export 节点：模型的自然语言「已完成」不产生交付物。没有 export 产物就没有交付。
5. 失败先看 error.code 与重试次数；报价不明（unknownPrice）时先报告，不要盲跑。
6. 用户上传的素材由网关注册为 reference 节点；需要看图片时用 read_image，不要假设文件路径。
7. 预算与授权以摘要里的「预算与授权」段为准；用户设了完全访问／自动模式就是持续授权，不要逐次确认。

## 硬约束
- 不编造产物、sha、花费、节点状态；没有工具回执就不说完成。
- 不把 secret/token/私钥写进图、日志或消息。
- 用户原话只进 brief[]（网关写入）；你不写 brief，也不改写用户原话。`

/** 构建固定系统提示（beast 只在会话创建时锁存，见 S19；不随轮次变化）。 */
export function buildStaticSystem(beast: boolean): string {
  const text = `${STATIC_BODY}\n${beast ? BEAST_SEGMENT_ON : BEAST_SEGMENT_OFF}`
  if (Buffer.byteLength(text, "utf8") <= STATIC_SYSTEM_MAX_BYTES) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= STATIC_SYSTEM_MAX_BYTES) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

/** 默认（beast off）静态系统提示；会话创建时按锁存开关调用 buildStaticSystem。 */
export const SYSTEM_POLICY_STATIC = buildStaticSystem(false)

// ===== opencode 消息的结构子集（网关不 import runtime，按结构对齐）=====
export interface AgentPart {
  type: string
  text?: string
  synthetic?: boolean
  /** 合成片段/工具调用 id（tool 部件里既可能是 id，也可能只有 callID）。 */
  id?: string
  tool?: string
  callID?: string
  state?: { status?: string; output?: string; input?: unknown }
  /** 非文本部件（图片/文件）的字节数（插件投影时提供；用于预算）。 */
  bytes?: number
  [k: string]: unknown
}
export interface AgentMessage {
  info: { id: string; role: string; sessionID?: string; summary?: boolean; time?: { created?: number } }
  parts: AgentPart[]
}

const PART_OVERHEAD = 64
const MSG_OVERHEAD = 40

function partText(part: AgentPart | undefined): string {
  if (!part) return ""
  if (typeof part.text === "string") return part.text
  if (part.type === "tool" && typeof part.state?.output === "string") return part.state.output
  return ""
}

/** 非文本附件（图片/文件）的记账字节：视觉 token 另计，不把原始二进制塞进文本字节上限。 */
const BINARY_PART_BYTES = 2048

function partBytes(part: AgentPart | undefined): number {
  if (!part) return 0
  const text = partText(part)
  const binaryish = part.type === "file" || part.type === "image" || part.type === "attachment"
  const binary = binaryish ? BINARY_PART_BYTES : typeof part.bytes === "number" && Number.isFinite(part.bytes) ? Math.max(0, part.bytes) : 0
  return Buffer.byteLength(text, "utf8") + binary + PART_OVERHEAD
}

export function messageBytes(msg: AgentMessage): number {
  return (msg.parts ?? []).reduce((n, p) => n + partBytes(p), 0) + MSG_OVERHEAD
}

/** 真实用户原话（排除网关/插件注入与合成片段）。与目标卡共用 visibleUserTextFromPart。 */
export function userTextOfMessage(msg: AgentMessage | undefined): string {
  if (!msg || msg.info?.role !== "user" || !Array.isArray(msg.parts)) return ""
  const texts: string[] = []
  for (const part of msg.parts) {
    const text = visibleUserTextFromPart(part)
    if (text) texts.push(text)
  }
  return texts.join("\n")
}

/** 本档写入的合成片段识别：synthetic:true 且（id 前缀 或 目标卡/摘要标签头）。 */
export function isProjectSyntheticPart(part: AgentPart | undefined): boolean {
  if (!part) return false
  const id = typeof part.id === "string" ? part.id : ""
  const head = typeof part.text === "string" ? part.text.trimStart() : ""
  const tagged = id.startsWith(SYNTHETIC_PART_ID_PREFIX) || head.startsWith(GOAL_CARD_TAG) || head.startsWith(DIGEST_TAG_OPEN)
  return part.synthetic === true ? tagged : id.startsWith(SYNTHETIC_PART_ID_PREFIX)
}

function toolUseId(part: AgentPart): string {
  return String(part.callID ?? part.id ?? "")
}

function isToolUse(part: AgentPart): boolean {
  return part?.type === "tool" || part?.type === "tool_use"
}

function isCompletedTool(part: AgentPart): boolean {
  const status = part.state?.status
  if (status === undefined) return typeof part.state?.output === "string"
  return status === "completed"
}

export interface Step {
  /** 步骤在 messages 里的起止下标（含）。 */
  from: number
  to: number
  assistantId: string
  toolUseIds: string[]
  toolResultIds: string[]
}

/**
 * 步骤分组：一条 assistant 消息 + 紧随其后的工具回执消息（role="tool"，兼容两种存放形态）。
 * 一条完成的 assistant 消息及其工具结果 = 一步。
 */
export function groupSteps(messages: readonly AgentMessage[]): Step[] {
  const steps: Step[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.info?.role !== "assistant" || msg.info.summary === true) continue
    let to = i
    const toolUseIds: string[] = []
    const toolResultIds: string[] = []
    for (const p of msg.parts ?? []) {
      if (!isToolUse(p)) continue
      const id = toolUseId(p)
      if (id) toolUseIds.push(id)
      if (isCompletedTool(p) && id) toolResultIds.push(id)
    }
    while (to + 1 < messages.length && messages[to + 1]?.info?.role === "tool") {
      to++
      for (const p of messages[to].parts ?? []) {
        const id = toolUseId(p)
        if (id) toolResultIds.push(id)
      }
    }
    steps.push({ from: i, to, assistantId: msg.info.id, toolUseIds, toolResultIds })
    i = to
  }
  return steps
}

export interface ProjectContextSources {
  graph: Readonly<ProjectGraph>
  digestInputs?: DigestInputs
  /** 固定系统提示（缺省 SYSTEM_POLICY_STATIC）。 */
  system?: string
  k?: number
}

export interface ProjectContextPlan {
  projectMode: true
  /** 进入模型的原始消息 id（顺序即原序）。 */
  keepIds: string[]
  /** 追加到当前用户消息末尾的合成片段；""=不加。 */
  synthetic: string
  steps: number
  /** 被丢弃的消息条数（旧步骤与旧用户消息）。 */
  dropped: number
  /** 文本部件裁剪指令：messageId + partIndex + 替换文本。 */
  replacements: { messageId: string; partIndex: number; text: string }[]
  /** 被剔除的部件（未完成的工具调用 / 失去配对的回执）：插件按此原地删。 */
  dropParts: { messageId: string; partIndex: number }[]
  bytes: number
  tokens: number
}

function measure(messages: readonly AgentMessage[], system: string, synthetic: string): number {
  let n = Buffer.byteLength(system, "utf8") + Buffer.byteLength(synthetic, "utf8")
  for (const m of messages) n += messageBytes(m)
  return n
}

/** 工具输出裁剪：头 60% + 尾 40%，带固定标记。 */
function clipText(text: string, budget: number): string {
  const total = Buffer.byteLength(text, "utf8")
  if (total <= budget) return text
  const marker = `\n…[工具回执已裁剪：原 ${total} 字节，只留头尾；全文在会话库，可用 project_get(view:"events") 复盘]…\n`
  const room = Math.max(200, budget - Buffer.byteLength(marker, "utf8"))
  const headBytes = Math.ceil(room * 0.6)
  const tailBytes = room - headBytes
  const buf = Buffer.from(text, "utf8")
  const head = buf.subarray(0, headBytes).toString("utf8").replace(/\uFFFD+$/, "")
  const tail = buf.subarray(Math.max(0, buf.length - tailBytes)).toString("utf8").replace(/^\uFFFD+/, "")
  return head + marker + tail
}

function syntheticText(entries: readonly BriefEntry[], digest: string): string {
  const card = renderGoalCard(entries)
  const body = digest ? `${DIGEST_TAG_OPEN}\n${digest}\n${DIGEST_TAG_CLOSE}` : ""
  if (!card) return body
  return body ? `${card}\n\n${body}` : card
}

/**
 * 剔除不完整/失去配对的工具部件：assistant 上未完成的工具调用（无回执）不进模型请求，
 * 对应的 role="tool" 回执也一并剔除。返回新 parts（不改入参）。
 */
export function pruneToolParts(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  let liveToolIds = new Set<string>()
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const keptParts: AgentPart[] = []
      const ids = new Set<string>()
      for (const p of msg.parts ?? []) {
        if (!isToolUse(p)) {
          keptParts.push(p)
          continue
        }
        const id = toolUseId(p)
        if (!id || !isCompletedTool(p)) continue
        keptParts.push(p)
        ids.add(id)
      }
      // role="tool" 紧随其后；这里把「本 assistant 宣称过的工具 id」留给下一轮消费。
      liveToolIds = ids
      out.push({ info: msg.info, parts: keptParts })
      continue
    }
    if (msg.info.role === "tool") {
      const keptParts = (msg.parts ?? []).filter((p) => liveToolIds.has(toolUseId(p)))
      if (keptParts.length === 0) continue // 没有配对的工具回执：整条丢弃
      out.push({ info: msg.info, parts: keptParts })
      continue
    }
    liveToolIds = new Set()
    out.push(msg)
  }
  return out
}

/**
 * 纯计算：给定消息与图/原话，产出一轮的窗口计划（不改动输入）。
 * 上限 INPUT_CAP_BYTES；内部留 JSON 结构余量（目标 ≤ 上限 - 4096）。
 */
export function planProjectContext(
  messages: readonly AgentMessage[],
  sources: ProjectContextSources,
): ProjectContextPlan | null {
  const k = sources.k ?? LIMITS.CONTEXT_WINDOW_STEPS
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (userTextOfMessage(messages[i])) {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) return null // 没有真实用户消息（例如压缩请求）：不装配

  const steps = groupSteps(messages)
  let keptSteps = steps.slice(-k)
  const cap = LIMITS.INPUT_CAP_BYTES - 4096

  const digest = renderDigest(sources.graph, sources.digestInputs)
  const brief = sources.graph.brief ?? []
  // 与 eimu-guard 同一条规则：只有一条原话且正是当前消息时，卡片是逐字重复，不加卡（摘要照加）。
  const onlyCurrent = brief.length < 2 && brief[0]?.messageId === messages[lastUser].info.id
  const synthetic = onlyCurrent ? syntheticText([], digest) : syntheticText(brief, digest)
  const system = sources.system ?? SYSTEM_POLICY_STATIC

  const applied = new Map<string, string>() // `${messageId}#${partIndex}` → 替换文本

  const buildKeep = (kept: Step[]): number[] => {
    const set = new Set<number>()
    for (const s of kept) for (let i = s.from; i <= s.to; i++) set.add(i)
    set.add(lastUser)
    for (let i = lastUser + 1; i < messages.length; i++) {
      const role = messages[i]?.info?.role
      if (role === "assistant" || role === "tool") set.add(i)
    }
    return [...set].sort((a, b) => a - b)
  }

  const effective = (keep: number[]): AgentMessage[] =>
    pruneToolParts(
      keep.map((i) => {
        const msg = messages[i]
        const parts = (msg.parts ?? []).map((p, pi) => {
          const t = applied.get(`${msg.info.id}#${pi}`)
          if (t === undefined) return p
          const next: AgentPart = { ...p, text: t }
          if (p.state) next.state = { ...p.state, output: t }
          return next
        })
        return { info: msg.info, parts }
      }),
    )

  let keep = buildKeep(keptSteps)
  let effectiveMsgs = effective(keep)
  let size = measure(effectiveMsgs, system, synthetic)
  let dropped = messages.length - effectiveMsgs.length

  // 1) 丢最老的整步（保持 tool_use/tool_result 成对）。
  while (size > cap && keptSteps.length > 1) {
    keptSteps = keptSteps.slice(1)
    keep = buildKeep(keptSteps)
    effectiveMsgs = effective(keep)
    size = measure(effectiveMsgs, system, synthetic)
    dropped = messages.length - effectiveMsgs.length
  }

  // 2) 逐步压缩过长的工具回执/文本部件（每次砍当前最大者）。
  for (const perPart of [8000, 4000, 2000, 800, 300]) {
    while (size > cap) {
      let best: { messageId: string; partIndex: number; text: string; saved: number } | null = null
      for (const i of keep) {
        const msg = messages[i]
        ;(msg.parts ?? []).forEach((p, pi) => {
          const key = `${msg.info.id}#${pi}`
          const text = applied.get(key) ?? partText(p)
          const sizeNow = Buffer.byteLength(text, "utf8")
          if (sizeNow <= perPart) return
          const next = clipText(text, perPart)
          const saved = sizeNow - Buffer.byteLength(next, "utf8")
          if (saved > 0 && (!best || saved > best.saved)) best = { messageId: msg.info.id, partIndex: pi, text: next, saved }
        })
      }
      if (!best) break
      const pick: { messageId: string; partIndex: number; text: string } = best
      applied.set(`${pick.messageId}#${pick.partIndex}`, pick.text)
      effectiveMsgs = effective(keep)
      size = measure(effectiveMsgs, system, synthetic)
    }
    if (size <= cap) break
  }

  const replacements: { messageId: string; partIndex: number; text: string }[] = []
  for (const [key, text] of applied) {
    const hash = key.lastIndexOf("#")
    replacements.push({ messageId: key.slice(0, hash), partIndex: Number(key.slice(hash + 1)), text })
  }
  // 被 pruneToolParts 剔除的部件（按原始下标报给插件，插件原地删）：
  // assistant 上未完成的工具调用，以及回执里失去配对的工具结果。
  const keptUseIds = new Set<string>()
  for (const m of effectiveMsgs) {
    if (m.info.role !== "assistant") continue
    for (const p of m.parts) if (isToolUse(p)) keptUseIds.add(toolUseId(p))
  }
  const dropParts: { messageId: string; partIndex: number }[] = []
  for (const i of keep) {
    const msg = messages[i]
    ;(msg.parts ?? []).forEach((p, pi) => {
      if (msg.info.role === "assistant" && isToolUse(p) && (!toolUseId(p) || !isCompletedTool(p))) {
        dropParts.push({ messageId: msg.info.id, partIndex: pi })
      } else if (msg.info.role === "tool" && !keptUseIds.has(toolUseId(p))) {
        dropParts.push({ messageId: msg.info.id, partIndex: pi })
      }
    })
  }

  return {
    projectMode: true,
    keepIds: effectiveMsgs.map((m) => m.info.id),
    synthetic,
    steps: keptSteps.length,
    dropped,
    replacements,
    dropParts,
    bytes: size,
    tokens: estimateRequestTokens(size),
  }
}

/** 固定 token 估算：与 constants.estimateTokens 同一口径（2 字节/token）。 */
export function estimateRequestTokens(bytes: number): number {
  return Math.ceil(bytes / 2)
}

export interface ApplyResult {
  applied: boolean
  projectMode: boolean
  steps: number
  dropped: number
  bytes: number
  tokens: number
  keepIds: string[]
}

/**
 * 原地装配（eimu-guard 的 transform 行为）：先剥掉上一轮/上一步的合成片段，再按窗口裁剪，
 * 最后把合成片段追加到当前用户消息末尾（synthetic:true，只在内存里，不落库）。
 * 非工程模式 → 不动 messages，返回 applied:false（旧席位路径逐字节不变）。
 */
export function applyProjectContext(
  messages: AgentMessage[],
  sources: ProjectContextSources & { projectMode?: boolean },
): ApplyResult {
  const system = sources.system ?? SYSTEM_POLICY_STATIC
  if (sources.projectMode === false) {
    const bytes = measure(messages, system, "")
    return {
      applied: false, projectMode: false, steps: 0, dropped: 0,
      bytes, tokens: estimateRequestTokens(bytes), keepIds: messages.map((m) => m.info?.id ?? ""),
    }
  }
  // 剥掉自己写的合成片段（同一回合内 transform 每个 step 都会跑一次）。
  stripProjectSynthetics(messages)
  const plan = planProjectContext(messages, sources)
  if (!plan) {
    const bytes = measure(messages, system, "")
    return {
      applied: false, projectMode: true, steps: 0, dropped: 0,
      bytes, tokens: estimateRequestTokens(bytes), keepIds: messages.map((m) => m.info?.id ?? ""),
    }
  }
  const byId = new Map(messages.map((m) => [m.info.id, m]))
  let kept = plan.keepIds.map((id) => byId.get(id)!).filter(Boolean)
  for (const r of plan.replacements) {
    const msg = kept.find((m) => m.info.id === r.messageId)
    const part = msg?.parts?.[r.partIndex]
    if (!part) continue
    part.text = r.text
    if (part.state) part.state = { ...part.state, output: r.text }
  }
  kept = pruneToolParts(kept)
  // 合成片段：只加在当前用户消息末尾。
  if (plan.synthetic) {
    let target: AgentMessage | undefined
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].info.role === "user" && userTextOfMessage(kept[i])) {
        target = kept[i]
        break
      }
    }
    if (target) {
      target.parts = Array.isArray(target.parts) ? [...target.parts] : []
      target.parts.push({
        id: `${SYNTHETIC_PART_ID_PREFIX}${target.info.id}`,
        sessionID: target.info.sessionID,
        messageID: target.info.id,
        type: "text",
        text: plan.synthetic,
        synthetic: true,
      })
    }
  }
  // 原地替换（opencode prompt.ts 用的是本数组引用，重赋值无效）。
  messages.length = 0
  messages.push(...kept)
  return {
    applied: true, projectMode: true, steps: plan.steps, dropped: plan.dropped,
    bytes: plan.bytes, tokens: plan.tokens, keepIds: plan.keepIds,
  }
}

/** 原地剥掉本档写入的合成片段；返回剥掉的条数。 */
export function stripProjectSynthetics(messages: AgentMessage[]): number {
  let n = 0
  for (const msg of messages) {
    if (!Array.isArray(msg?.parts) || msg.parts.length === 0) continue
    const kept = msg.parts.filter((p) => !isProjectSyntheticPart(p))
    n += msg.parts.length - kept.length
    msg.parts = kept
  }
  return n
}

/** 请求体预算测量（测试与路由共用；不含 provider 的 JSON 转义，装配时另留 4KB 余量）。 */
export function measureRequest(
  messages: readonly AgentMessage[],
  system: string = SYSTEM_POLICY_STATIC,
): { bytes: number; tokens: number } {
  const bytes = measure(messages, system, "")
  return { bytes, tokens: estimateRequestTokens(bytes) }
}

/**
 * `/internal/project/context` 的响应体（S9 路由只需：取会话 state.projectMode + 图 → 调本函数）。
 * 非工程模式会话返回 `{project_mode:false}`；插件据此走旧路径（逐字节不变）。
 * 请求体：`{session_id, messages:[{id,role,summary?,parts:[{type,text?|state.output?,synthetic?,id?,tool?,callID?,bytes?}]}]}`
 */
export function projectContextResponse(
  graph: Readonly<ProjectGraph> | null,
  messages: readonly AgentMessage[],
  opts: Omit<ProjectContextSources, "graph"> = {},
):
  | { project_mode: false }
  | {
      project_mode: true
      keep_ids: string[]
      synthetic: string
      replacements: { messageId: string; partIndex: number; text: string }[]
      drop_parts: { messageId: string; partIndex: number }[]
      steps: number
      dropped: number
      bytes: number
      tokens: number
    } {
  if (!graph) return { project_mode: false }
  const plan = planProjectContext(messages, { ...opts, graph })
  if (!plan) return { project_mode: false }
  return {
    project_mode: true,
    keep_ids: plan.keepIds,
    synthetic: plan.synthetic,
    replacements: plan.replacements,
    drop_parts: plan.dropParts,
    steps: plan.steps,
    dropped: plan.dropped,
    bytes: plan.bytes,
    tokens: plan.tokens,
  }
}

export { PART_OVERHEAD, MSG_OVERHEAD }

export interface ProjectIngressLike {
  sessionId: string
  messageId: string
  text: string
  at: string
  first: boolean
  recipe: string | null
}

/** 与 messages-gw-types.ts ingressProjectBrief 的 messageId 同式，先写的那次占住去重键。 */
async function briefMessageId(turn: number, text: string): Promise<string> {
  const { createHash } = await import("node:crypto")
  return `u${turn}_${createHash("sha256").update(text).digest("hex").slice(0, 16)}`
}

/**
 * 首条（以及之后每一条）用户原文同步落盘。返回时 project.json 里已经有这段原话。
 * 不调用分类。分类仍由 ingress 在之后异步补上。
 */
export async function persistUserBriefNow(sessionId: string, text: string, turn: number): Promise<void> {
  const raw = String(text ?? "")
  if (!visibleUserTextFromPart({ type: "text", text: raw })) return
  const { ensureProject } = await import("./store.ts")
  const messageId = await briefMessageId(turn, raw)
  const { store, created } = await ensureProject(sessionId)
  const added = await store.update((g) => appendBriefEntry(g.brief, { at: new Date().toISOString(), messageId, text: raw }) !== null)
  if (!added) return
  await store.appendEvents([
    { kind: "brief", data: { messageId, chars: [...raw].length, recipe: "", created } },
  ])
}

/**
 * 替换默认 ingress sink：brief 已由 persistUserBriefNow 写过时仍补配方。
 * 不在这里调用分类模型。
 */
export async function acceptProjectIngress(record: ProjectIngressLike): Promise<void> {
  const { ensureProject } = await import("./store.ts")
  const { store, created } = await ensureProject(record.sessionId, {
    ...(record.first && record.recipe ? { templateId: record.recipe } : {}),
  })
  const added = await store.update((g) => {
    const entry = appendBriefEntry(g.brief, { at: record.at, messageId: record.messageId, text: record.text })
    return entry !== null
  })
  if (added) {
    await store.appendEvents([
      {
        kind: "brief",
        data: { messageId: record.messageId, chars: [...record.text].length, recipe: record.recipe ?? "", created },
      },
    ])
  }
  if (!(record.first && record.recipe)) return
  const g = await store.read()
  if (Object.keys(g.nodes).length > 0) return
  const outcome = await store.applyPatches(
    { ops: [{ op: "apply_recipe", recipe: record.recipe, params: {} }] },
    { kind: "user" },
  )
  if (outcome.receipt.rejected.length > 0) {
    console.warn(
      `[gateway] project apply_recipe rejected: session=${record.sessionId} recipe=${record.recipe} ${outcome.receipt.rejected.map((r) => r.code).join(",")}`,
    )
  }
}
