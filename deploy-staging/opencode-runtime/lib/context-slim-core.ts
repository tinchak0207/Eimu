// context-slim 核心逻辑（2026-10-02）：microCompact（T1-3）＋工具结果预算安全网（T1-4）。
//
// 为什么独立成 lib/（2026-10-02 生产事故）：
//   opencode 的 plugin loader 逐个 export 检查，遇到非函式 export 即整档载入失败
//   （`Plugin export is not a function`）。此前常数与函式都挂在 plugin/context-slim.ts，
//   导致该 plugin 在生产**根本没被载入**（microCompact 与安全网全是死的）。
//   把非 plugin 的常数／函式搬到 lib/（不会被当 plugin 自动载入），plugin 档只留一个
//   `export const ContextSlim: Plugin`。
//
// 为什么需要（与 eimu-guard 的 D6 分工）：
//   - 原生 truncate 只保证「单次呼叫」≤ ~51KB，且只覆盖走原生截断路径的工具；跨轮残留、
//     MCP／自订工具不回报长度（见 opencode tool_output config 与 compaction.prune）。
//   - eimu-guard 的 D6 只在 tool.execute.after（单次输出落盘前）截断，且只覆盖白名单工具。
//   本核心供 plugin 在**送上游前的最后一关**（experimental.chat.messages.transform）做两件事：
//     A) microCompact：距最后一则 user 讯息 > 1 小时（对齐上游 prompt cache TTL）时，
//        把较旧的已完成工具结果就地换成 [Old tool result content cleared]，保留最近 N 笔。
//        概念取自 Claude Code microCompact（只取概念，未复制其程式码）。
//     B) 工具结果安全网：单笔 > 50,000 字元或单讯息聚合 > 200,000 字元时，完整内容落盘到
//        workspace 内 outputs/tool-results/<content-hash>.txt，讯息换成 <persisted-output> ＋
//        前后预览（换行边界切）。已被原生截断（含 "Full output saved to:"）者放行，不二次落盘。
//
// 纯记忆体改写：不动 DB、不发任何上游请求（零 API 成本）。任何错误都 try/catch 原样放行。

import { createHash } from "node:crypto"
import { constants as fsConstants, existsSync, realpathSync } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import path from "node:path"
import { WORKSPACE } from "./sandbox"

// ── 常数（可用 env 覆写；预设为待调参数）────────────────────────────────────

/** 清除后的就地标记（与原生 compaction.prune 同字串，方便辨识与幂等）。 */
export const CLEARED_MARKER = "[Old tool result content cleared]"

function intEnv(name: string, dflt: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** 开关：CONTEXT_SLIM=0 可整支停用。 */
export const CONTEXT_SLIM_ENABLED = process.env.CONTEXT_SLIM !== "0"

/** A：距最后一则 user 讯息超过此毫秒数＝上游 prompt cache 必已过期。预设 60 分钟。 */
export const MICROCOMPACT_IDLE_MS = intEnv("MICROCOMPACT_IDLE_MINUTES", 60) * 60_000
/** A：保留最近几笔可压缩的工具结果（下限 1）。 */
export const MICROCOMPACT_KEEP = Math.max(5, intEnv("MICROCOMPACT_KEEP", 5))
/** A：豁免的工具名（skill 类等），逗号分隔。预设 skill。 */
export const MICROCOMPACT_EXEMPT_TOOLS: ReadonlySet<string> = new Set(
  (process.env.MICROCOMPACT_EXEMPT_TOOLS ?? "skill")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

/** B：单笔工具结果字元上限。 */
export const TOOL_RESULT_MAX_CHARS = intEnv("TOOL_RESULT_MAX_CHARS", 50_000)
/** B：单讯息（同一 assistant message 内所有工具结果）聚合字元上限。 */
export const TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS = intEnv("TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS", 200_000)
/** B：落盘根目录（agent 可读的 workspace 内）。 */
export const TOOL_RESULT_PERSIST_DIR =
  process.env.TOOL_RESULT_PERSIST_DIR || path.join(WORKSPACE, "outputs", "tool-results")
/** B：前后预览字元数。 */
const PREVIEW_HEAD_CHARS = intEnv("TOOL_RESULT_PREVIEW_HEAD_CHARS", 2_000)
const PREVIEW_TAIL_CHARS = intEnv("TOOL_RESULT_PREVIEW_TAIL_CHARS", 1_000)

// ── 2026-10-18：压缩请求输入硬上限 ─────────────────────────────────────────
// 生产事故：2.4M token 的会话触发 summarize 时，压缩请求本身把整段历史再送一次，
// 必然 AbortError（180s 超时）→ 水位不推进 → 每轮重压。压缩是「送上游前的最后一关」
// 上的请求，必须与普通对话一样有界：保留最早的用户需求 + 已有压缩摘要 + 最近内容。
export const COMPACTION_INPUT_MAX_CHARS = intEnv("COMPACTION_INPUT_MAX_CHARS", 60_000)
export const COMPACTION_INPUT_HEAD_CHARS = intEnv("COMPACTION_INPUT_HEAD_CHARS", 8_000)
export const COMPACTION_PINNED_SUMMARY_MAX_CHARS = intEnv("COMPACTION_PINNED_SUMMARY_MAX_CHARS", 20_000)
/** 压缩请求识别标记（opencode 压缩 prompt 与 CC 形状都覆盖；正常对话不会命中）。 */
const COMPACTION_REQUEST_MARKERS = [
  "只使用已有对话生成恢复摘要",
  "## Original Request",
  "CRITICAL: Respond with TEXT ONLY",
  "Your task is to create a detailed summary",
  "Provide a detailed but concise summary of our conversation",
]
export const COMPACTION_INPUT_TRUNCATED_MARK =
  "[compaction input truncated — older content omitted from this summary request; full history remains in storage]"

// 2026-10-18 生产取证（opencode binary 96451904 字节处）：
//   trigger("experimental.session.compacting", {sessionID}, {context, prompt})
//   ze = structuredClone(select(...).head)
//   trigger("experimental.chat.messages.transform", {}, {messages: ze})
//   toModelMessagesEffect(ze, ...)  → process({messages:[..., {role:"user", text: compactionPrompt}]})
// 即：压缩 prompt 是在 transform **之后**才附加的，靠「最后一条文本含压缩 prompt」无法
// 识别压缩请求。改由 plugin 的 compacting hook 按 sessionID 登记，transform 按
// messages[].info.sessionID 消费（同一进程内、30s TTL）。
const compactionRequestSessions = new Map<string, number>()
export const COMPACTION_REQUEST_TTL_MS = intEnv("COMPACTION_REQUEST_TTL_MS", 30_000)

/** plugin 的 experimental.session.compacting hook 呼叫：标记该会话下一次 transform 是压缩请求。 */
export function markCompactionRequest(sessionId: unknown): void {
  const sid = typeof sessionId === "string" ? sessionId.trim() : ""
  if (!sid) return
  const now = Date.now()
  compactionRequestSessions.set(sid, now)
  // 有界：清掉过期项，避免长期泄漏。
  for (const [key, at] of compactionRequestSessions) {
    if (now - at > COMPACTION_REQUEST_TTL_MS) compactionRequestSessions.delete(key)
  }
  if (compactionRequestSessions.size > 64) {
    const first = compactionRequestSessions.keys().next().value
    if (typeof first === "string") compactionRequestSessions.delete(first)
  }
}

function messageSessionId(messages: MsgLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sid = messages[i]?.info?.sessionID
    if (typeof sid === "string" && sid) return sid
  }
  return undefined
}

/** 原生截断参考句（opencode tool_output 超限时写入讯息的字串）。 */
const NATIVE_TRUNCATED_RE = /Full output saved to:/
/** 从原生参考句取回落盘路径（"Full output saved to: <path>"，到此行为止的第一个非空白字串）。 */
const NATIVE_PATH_RE = /Full output saved to:\s*([^\s"'<>]+)/
/** 完整多行参考句：整串必须恰好是一个多行 `<persisted-output>…</persisted-output>` 区块（锚定＋单一化）。 */
const PERSISTED_REF_FULL_RE =
  /^\s*<persisted-output\s+path="([^"]+)"\s+total-chars="(\d+)"[^>]*>[\s\S]*<\/persisted-output>\s*$/
/** 极简退路式参考句：整串恰好是一个自闭合 `<persisted-output …/>`。 */
const PERSISTED_REF_SELF_RE =
  /^\s*<persisted-output\s+path="([^"]+)"\s+total-chars="(\d+)"[^>]*\/>\s*$/
/** 本档内容定址档名格式（`tool-<sha256 前 16 hex>.txt`）。 */
const PERSISTED_FILE_NAME_RE = /^tool-[0-9a-f]{16}\.txt$/

/** 解析整串是否为**单一**自有参考句；是则回传其 path，否则 null。 */
function parseOwnPersistedRef(out: string): string | null {
  const full = PERSISTED_REF_FULL_RE.exec(out)
  if (full) return full[1]
  const self = PERSISTED_REF_SELF_RE.exec(out)
  if (self) return self[1]
  return null
}

/** 以 realpath 解析一个稳定根（解析失败则退回绝对化），不依赖单次呼叫的 persistDir。 */
function resolveRoot(base: string): string {
  try {
    return realpathSync(base)
  } catch {
    return path.resolve(base)
  }
}

/** real 是否落在 root 子树之下（不含 root 自身）。 */
function isUnder(real: string, root: string): boolean {
  const rel = path.relative(root, real)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/**
 * 判定「这是不是本安全网自己写的 <persisted-output> 参考句」。
 * 旧版只做子字串比对（/<persisted-output\b/），导致**任何提及**该字面的输出（被 cat 的
 * 本档原始码、旧 log、工具回传）永久免落盘与免压缩 ⇒ context 膨胀且可被内容伪造。
 * 收窄为结构化判定（H2/H3），必须同时满足：
 *   ① 形状符合本档模板，且**整串就是这一个区块**（锚定＋单一化）：头／中／尾缀注入，
 *      或「合法前缀＋任意尾随内容」的一律不算；
 *   ② 档名是内容定址格式，路径为绝对路径且无 `..` 跳脱；
 *   ③ 档案真实存在（挡孤儿／幻影指针），且其 realpath 落在稳定根（本次 persistDir、
 *      预设 persistDir、WORKSPACE）之下；或落在稳定的内容定址目录结构
 *      `…/outputs/tool-results/tool-<hash>.txt` 之下（目录搬迁但结构保留时仍认，H3）。
 */
function isOwnPersistedRef(out: string, persistDir: string): boolean {
  const refPath = parseOwnPersistedRef(out)
  if (refPath === null) return false
  if (!path.isAbsolute(refPath)) return false
  if (refPath.split(/[\\/]/).includes("..")) return false
  if (!PERSISTED_FILE_NAME_RE.test(path.basename(refPath))) return false
  let real: string
  try {
    if (!existsSync(refPath)) return false
    real = realpathSync(refPath)
  } catch {
    return false
  }
  for (const root of [persistDir, TOOL_RESULT_PERSIST_DIR, WORKSPACE]) {
    if (root && isUnder(real, resolveRoot(root))) return true
  }
  // 稳定结构退路：任意根下的 `outputs/tool-results/tool-<hash>.txt`（H3）。
  return path.basename(path.dirname(real)) === "tool-results" && PERSISTED_FILE_NAME_RE.test(path.basename(real))
}

/**
 * 原生截断参考句（H4）：`Full output saved to: <path>` 且该档真实存在才算「带真实落盘路径的
 * 参考句」。任何这类参考句都不得被 microCompact 清除（清掉＝模型失去唯一取回路）。
 */
function isNativeTruncatedRef(out: string): boolean {
  const m = NATIVE_PATH_RE.exec(out)
  if (!m) return false
  const p = m[1]
  if (!path.isAbsolute(p)) return false
  try {
    return existsSync(p) && !!realpathSync(p)
  } catch {
    return false
  }
}

// ── 型别（宽松定义：现场可能是 SDK 型别或内部结构，只碰必要栏位）─────────────

interface MsgLike {
  info?: { role?: string; sessionID?: string; summary?: boolean; agent?: string; mode?: string; time?: { created?: number } }
  parts?: PartLike[]
}
interface PartLike {
  text?: string
  type?: string
  tool?: string
  state?: {
    status?: string
    output?: unknown
  }
}

// Only expendable historical lookup output may be cleared. Unknown tools are preserved.
const MICROCOMPACT_LOOKUP_TOOLS = new Set(["read", "glob", "grep", "list", "webfetch", "websearch", "search_web", "search_aggregate", "smart_search", "bash"])
// Protect media receipts, ledger, approvals, dispatch and deliverables even if the tool part completed.
function protectedReceipt(part: PartLike): boolean {
  if (!MICROCOMPACT_LOOKUP_TOOLS.has(part.tool ?? "")) return true
  const output = typeof part.state?.output === "string" ? part.state.output : ""
  return /(?:task_id|workflow_id|runId|artifact|receipt|media_url|audio_url|video_url|image_url|cost_coins|estimated_cost|charged|refund|reservation|ledger|confirm_id|billing|扣费|退款|账本|已提交)/i.test(output)
}

/** 在换行边界切头（含切点那个换行）。 */
export function cutAtNewlineHead(s: string, n: number): string {
  if (s.length <= n) return s
  const i = s.lastIndexOf("\n", n)
  return s.slice(0, i === -1 ? n : i + 1)
}
/** 在换行边界切尾（从切点后第一个换行开始）。 */
export function cutAtNewlineTail(s: string, n: number): string {
  if (s.length <= n) return s
  const start = s.length - n
  const i = s.indexOf("\n", start)
  return s.slice(i === -1 ? start : i + 1)
}

/** 2026-10-18：这是不是一个压缩（summarize/compact）请求？只看最后 3 则讯息。 */
export function isCompactionRequest(messages: MsgLike[]): boolean {
  if (!Array.isArray(messages)) return false
  // 优先：compacting hook 按 sessionID 登记的标记（生产二进位实测的可靠信号）。
  const sid = messageSessionId(messages)
  if (sid) {
    const markedAt = compactionRequestSessions.get(sid)
    if (markedAt !== undefined && Date.now() - markedAt <= COMPACTION_REQUEST_TTL_MS) {
      compactionRequestSessions.delete(sid) // 一次性消费
      return true
    }
  }
  const tail = messages.slice(-3)
  for (const msg of tail) {
    const info = msg?.info as { system?: string } | undefined
    if (typeof info?.system === "string" && COMPACTION_REQUEST_MARKERS.some((m) => info.system!.includes(m))) {
      return true
    }
    for (const part of msg?.parts ?? []) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      if (COMPACTION_REQUEST_MARKERS.some((m) => part.text!.includes(m))) return true
    }
  }
  return false
}

type CompactionSlot =
  | { kind: "text"; role?: string; info?: MsgLike["info"]; part: PartLike; text: string }
  | { kind: "tool"; role?: string; info?: MsgLike["info"]; state: NonNullable<PartLike["state"]>; text: string }

function compactionSlots(messages: MsgLike[]): CompactionSlot[] {
  const slots: CompactionSlot[] = []
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.parts)) continue
    const role = msg.info?.role
    const info = msg.info
    for (const part of msg.parts) {
      if (!part) continue
      if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        slots.push({ kind: "text", role, info, part, text: part.text })
      } else if (part.type === "tool") {
        const st = part.state
        if (st && st.status === "completed" && typeof st.output === "string" && st.output.length > 0) {
          slots.push({ kind: "tool", role, info, state: st, text: st.output })
        }
      }
    }
  }
  return slots
}

function isCompactionSummary(info: MsgLike["info"] | undefined): boolean {
  return info?.summary === true || info?.agent === "compaction" || info?.mode === "compaction"
}

/**
 * 2026-10-18：把压缩请求的对话文本截到固定上限，保留：
 *   ① 第一条 user 讯息的头（关键早期需求/约束）；
 *   ② 既有压缩摘要（继续压缩时最重要的早期信息）；
 *   ③ 最近的讯息（按槽位从尾部整条保留，必要时只留最后一段）。
 * 其余文本/工具输出就地换成截断标记。回传被省略的字元数。
 */
export function boundCompactionInput(
  messages: MsgLike[],
  opts: { maxChars?: number; headChars?: number; pinnedSummaryMaxChars?: number } = {},
): number {
  const maxChars = Math.max(1000, opts.maxChars ?? COMPACTION_INPUT_MAX_CHARS)
  const headChars = Math.max(0, opts.headChars ?? COMPACTION_INPUT_HEAD_CHARS)
  const pinnedMax = Math.max(0, opts.pinnedSummaryMaxChars ?? COMPACTION_PINNED_SUMMARY_MAX_CHARS)
  const slots = compactionSlots(messages)
  if (slots.length === 0) return 0
  const total = slots.reduce((n, s) => n + s.text.length, 0)
  if (total <= maxChars) return 0

  const keep = new Map<CompactionSlot, string>()
  let budget = maxChars

  // ① 关键早期信息：第一条 user 文本（截头）。
  const firstUser = slots.find((s) => s.kind === "text" && s.role === "user")
  if (firstUser && headChars > 0) {
    const kept = cutAtNewlineHead(firstUser.text, Math.min(headChars, budget))
    keep.set(firstUser, kept)
    budget = Math.max(0, budget - kept.length)
  }

  // ② 既有压缩摘要整段保留（上限 pinnedMax，避免把上一次摘要也截碎）。
  for (const slot of slots) {
    if (!isCompactionSummary(slot.info)) continue
    if (keep.has(slot)) continue
    const allowance = Math.min(pinnedMax, budget)
    if (allowance <= 0) break
    const kept = slot.text.length <= allowance ? slot.text : cutAtNewlineHead(slot.text, allowance)
    keep.set(slot, kept)
    budget = Math.max(0, budget - kept.length)
  }

  // ③ 最近内容：从尾部往前整槽保留，最后一槽可只留尾段。
  for (let i = slots.length - 1; i >= 0; i--) {
    if (budget <= 0) break
    const slot = slots[i]
    if (keep.has(slot)) continue
    if (slot.text.length <= budget) {
      keep.set(slot, slot.text)
      budget -= slot.text.length
      continue
    }
    const tail = cutAtNewlineTail(slot.text, Math.max(1, budget))
    if (tail) keep.set(slot, tail)
    budget = 0
  }

  let omitted = 0
  // 先做「保留内容」的总长对帐；超限时从最早的尾部保留槽继续丢弃（首条 user
  // 与既有摘要属于关键早期信息，不参与二次丢弃）。
  const SHORT_MARK = "[...]"
  const order = new Map<CompactionSlot, number>(slots.map((slot, i) => [slot, i]))
  let totalAfter = 0
  for (const slot of slots) {
    const kept = keep.get(slot)
    totalAfter += kept !== undefined ? kept.length : SHORT_MARK.length
  }
  const droppable = [...keep.keys()]
    .filter((slot) => slot !== firstUser && !isCompactionSummary(slot.info))
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  for (const slot of droppable) {
    if (totalAfter <= maxChars - COMPACTION_INPUT_TRUNCATED_MARK.length) break
    const kept = keep.get(slot)
    if (!kept) continue
    totalAfter -= Math.max(0, kept.length - SHORT_MARK.length)
    keep.delete(slot)
  }
  // 第一个被丢弃的槽位保留完整说明，其余用极短标记，避免标记本身撑爆预算。
  let firstDropped = true
  for (const slot of slots) {
    const kept = keep.get(slot)
    if (kept !== undefined) {
      if (kept !== slot.text) {
        omitted += slot.text.length - kept.length
        if (slot.kind === "text") slot.part.text = kept
        else slot.state.output = kept
      }
      continue
    }
    omitted += slot.text.length
    const mark = firstDropped ? COMPACTION_INPUT_TRUNCATED_MARK : SHORT_MARK
    firstDropped = false
    if (slot.kind === "text") slot.part.text = mark
    else slot.state.output = mark
  }
  return omitted
}

/** 内容定址档名（幂等：同内容同档）。 */
function contentFileName(content: string): string {
  return `tool-${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}.txt`
}

interface SlimResult {
  cleared: number
  persisted: number
  paths: string[]
}

/**
 * 就地改写 messages（供 hook 呼叫，也可直接单测）。
 * 失败不抛：内部已逐段 try/catch，最坏情况维持原样。
 */
export async function slimMessages(
  messages: MsgLike[],
  opts: {
    now?: number
    persistDir?: string
    microCompact?: boolean
    toolResultMax?: number
    perMessageBudget?: number
    idleMs?: number
    keep?: number
    exemptTools?: ReadonlySet<string>
  } = {},
): Promise<SlimResult> {
  const now = opts.now ?? Date.now()
  const persistDir = opts.persistDir ?? TOOL_RESULT_PERSIST_DIR
  const toolResultMax = opts.toolResultMax ?? TOOL_RESULT_MAX_CHARS
  const perMessageBudget = opts.perMessageBudget ?? TOOL_RESULT_BUDGET_PER_MESSAGE_CHARS
  const idleMs = opts.idleMs ?? MICROCOMPACT_IDLE_MS
  const keep = Math.max(5, opts.keep ?? MICROCOMPACT_KEEP)
  const exempt = opts.exemptTools ?? MICROCOMPACT_EXEMPT_TOOLS
  const result: SlimResult = { cleared: 0, persisted: 0, paths: [] }
  // 本轮被安全网改写过的 state：microCompact 同轮不得再清除（同轮自杀不可接受）。
  const persistedThisRound = new Set<object>()
  // 本轮尝试落盘但失败的 state（H5）：该笔既无档可回，同轮就不得再被 microCompact 清掉。
  const failedPersist = new Set<object>()

  if (!Array.isArray(messages)) return result
  // 2026-10-18：压缩请求自身必须有界——超大会话的 summarize 不能把整段历史再送一次。
  try {
    if (isCompactionRequest(messages)) {
      const omitted = boundCompactionInput(messages)
      if (omitted > 0) {
        console.warn(
          `[context-slim] compaction input bounded: omitted=${omitted} chars max=${COMPACTION_INPUT_MAX_CHARS}`,
        )
      }
    }
  } catch {
    /* 截断失败：原样放行（压缩仍可能超时，但绝不因截断自身抛错） */
  }
  // Recovery fallback for previously stored compaction drafts; never rewrite normal conversation.
  for (const msg of messages) {
    if (msg?.info?.summary !== true && msg?.info?.agent !== "compaction" && msg?.info?.mode !== "compaction") continue
    if (!Array.isArray(msg.parts)) continue
    msg.parts = msg.parts.filter((part) => part?.type !== "reasoning")
    for (const part of msg.parts) {
      if (part?.type !== "text" || typeof part.text !== "string") continue
      const clean = part.text.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "").replace(/<analysis\b[^>]*>[\s\S]*$/gi, "").trim()
      const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(clean)
      part.text = (summary ? summary[1] : clean).trim()
    }
  }

  // ── B：工具结果预算安全网（先做，避免超大字串进入后续处理）──────────────
  try {
    for (const msg of messages) {
      if (!msg || !Array.isArray(msg.parts)) continue
      let running = 0
      for (const part of msg.parts) {
        if (!part || part.type !== "tool") continue
        const st = part.state
        if (!st || st.status !== "completed" || typeof st.output !== "string") continue
        const out = st.output

        // 已清除：放行，不二次处理；但仍计入预算（避免合成误判）。
        // 判定必须「整串等于」标记：用 includes 会让任何「提及」标记的输出（被 cat 的原始码／旧 log）
        // 永久免落盘，与 <persisted-output> 的子字串误判同病。
        if (out === CLEARED_MARKER) {
          running += out.length
          continue
        }
        // 原生已截断：安全网放行（不二次落盘）。
        if (NATIVE_TRUNCATED_RE.test(out) || isOwnPersistedRef(out, persistDir)) {
          running += out.length
          continue
        }

        const overSingle = out.length > toolResultMax
        const overBudget = !overSingle && running + out.length > perMessageBudget
        // 落盘本身要能缩小讯息才有意义：比预览还小的内容不落盘（否则越处理越大）。
        const worthPersisting = out.length > PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS + 512
        if (!((overSingle || overBudget) && worthPersisting)) {
          running += out.length
          continue
        }

        const replacement = await persistAndPreview(out, persistDir, toolResultMax)
        if (replacement === null) {
          // 落盘失败：放弃该笔改写，原样放行（不中断会话）。
          // H5：记住该笔曾 attempt 落盘失败，microCompact 同轮不得清除（否则无档可回、静默遗失）。
          failedPersist.add(st)
          running += out.length
          continue
        }
        st.output = replacement.ref
        running += replacement.ref.length
        result.persisted++
        result.paths.push(replacement.path)
        persistedThisRound.add(st)
      }
    }
  } catch {
    /* 安全网失败：原样放行 */
  }

  // ── A：microCompact（仅在距最后一则 user 讯息 > idleMs 时触发）────────────
  try {
    if (opts.microCompact !== false) {
      let lastUserCreated = -Infinity
      for (const msg of messages) {
        const role = msg?.info?.role
        const t = msg?.info?.time?.created
        if (role === "user" && typeof t === "number") lastUserCreated = Math.max(lastUserCreated, t)
      }
      if (Number.isFinite(lastUserCreated) && now - lastUserCreated > idleMs) {
        // 依讯息顺序收集「可压缩」的已完成工具结果。
        const allTools = messages.flatMap((m) => m?.parts ?? []).filter((p) => p?.type === "tool")
        const recent = new Set(allTools.slice(-keep))
        const eligible: Array<{ st: NonNullable<PartLike["state"]> }> = []
        for (const msg of messages) {
          if (!msg || !Array.isArray(msg.parts)) continue
          for (const part of msg.parts) {
            if (!part || part.type !== "tool") continue
            const st = part.state
            if (!st || st.status !== "completed" || typeof st.output !== "string") continue
            if (recent.has(part) || protectedReceipt(part)) continue
            const toolName = part.tool ?? ""
            if (exempt.has(toolName)) continue
            const out = st.output
            if (out.length === 0) continue
            if (out === CLEARED_MARKER) continue // 幂等：整串等于标记的已清除项不再计数（includes 会被「提及」伪造）
            // 参考句是模型取回完整内容的唯一路径指针，清除即永久断链 ⇒ 不纳入可压缩集（与安全网放行对称）。
            // ① 自产 <persisted-output> 指针（H2 判定）；
            // ② 原生 `Full output saved to: <path>` 且该档真实存在（H4）；
            // ③ 本轮 attempt 落盘但失败者（H5：无档可回，宁可留着也不断链）；
            // ④ 本轮刚由安全网落盘者，同轮不得再清除。
            if (isOwnPersistedRef(out, persistDir)) continue
            if (isNativeTruncatedRef(out)) continue
            if (failedPersist.has(st)) continue
            if (persistedThisRound.has(st)) continue
            eligible.push({ st })
          }
        }
        // 保留最近 keep 笔，其余清成标记（就地）。
        const toClear = eligible.length
        for (let i = 0; i < toClear; i++) {
          eligible[i].st.output = CLEARED_MARKER
          result.cleared++
        }
      }
    }
  } catch {
    /* microCompact 失败：原样放行 */
  }

  return result
}

/** 落盘并回传 <persisted-output> 参考句与实际档路径；失败回 null。 */
async function persistAndPreview(
  content: string,
  persistDir: string,
  maxChars: number,
): Promise<{ ref: string; path: string } | null> {
  try {
    await mkdir(persistDir, { recursive: true })
    // 规范化落盘目录：解析 symlink，后续一律在真实目录内操作（父目录逃逸防护）。
    let realDir: string
    try {
      realDir = realpathSync(persistDir)
    } catch {
      realDir = path.resolve(persistDir)
    }
    const file = path.join(realDir, contentFileName(content))
    // H1：档名由内容 hash 决定，攻击者可在目录内预植同名 symlink，让 writeFile 跟随写穿到
    // persistDir 之外（任意档覆写）。一律以 O_NOFOLLOW 打开最终档（不跟随 symlink）；
    // 命中 symlink 即抛 ELOOP → 落盘失败 fail-open，目标档不被触碰。
    // 同 hash 已存在（且为普通档）时覆写为相同内容＝仍幂等（内容定址）。
    const fh = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    )
    try {
      await fh.writeFile(content, "utf8")
    } finally {
      await fh.close()
    }
    const head = cutAtNewlineHead(content, PREVIEW_HEAD_CHARS)
    const tail = cutAtNewlineTail(content, PREVIEW_TAIL_CHARS)
    const omitted = content.length - head.length - tail.length
    const ref =
      `<persisted-output path="${file}" total-chars="${content.length}" omitted-chars="${omitted}">\n` +
      `${head}\n...[中略 ${omitted} 字元，完整内容见上述 path]...\n${tail}\n` +
      `</persisted-output>`
    // 保险：参考句本身必须远小于上限，否则退回极简式。
    const chosen = ref.length < maxChars ? ref : `<persisted-output path="${file}" total-chars="${content.length}"/>\n`
    return { ref: chosen, path: file }
  } catch {
    return null
  }
}
