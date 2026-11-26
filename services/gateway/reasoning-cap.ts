// 2026-10-02 e2e 成片评测：「无工具长推理」回合内自我纠偏。
// 病灶：企划段 ~3 分钟 reasoning:message≈800:1、零工具——既有空转止损（finalizeIdleStep）
// 只在 step-finish 结算，而「单个 step 内无限推理」永远到不了 step-finish，且非空 reasoning
// 会让空 step 计数归零 → 断路器根本不会响。
// 机制：累计「自上次动作（非 no-op 工具 / 非空正文）以来」的 reasoning 字数与起算时间，
// 超过上限即回报处置决定，由事件处理器呼叫既有 triggerIdleStepBreaker（中止 + 同轮带纠偏
// 提示重投，每 turn 仅一次、不循环）。纯函数，无 gateway 依赖。
//
// 2026-10-02 修复（减少「长考下臭棋」，但不放纵空转）：
//   1) 首回合保护：开工首个 gen（尚无任何 tool call 与非空正文）给更宽的规划预算。
//      实录：底模 glm-5.3 首回合 46.5s 全在推理（t_first_text/t_first_tool 皆 null），
//      9000 字上限在「正在规划」时就腰斩＝误伤。首回合软上限放大约 2.7x，未到硬上限不中止。
//   2) 两段式，超限不直接 abort：首回合破软限只回 "soft"（呼叫端诚实上报、不 abort）；
//      软限后以常规上限重新计，再破才回 "hard"（中止 + 带 nudge 同轮重投）。
//      已有工具／正文的回合维持原门槛，直接 "hard"。
//   3) nudge 品质：buildReasoningNudge 依「本轮是否已有工具调用」给两套动作导向文案
//      （首回合→给出第一个工具调用；已动作过→续发下一步工具或收尾），非只说「不要再推理」。
//   4) 推理保留：本模组滚动保存最近 REASONING_KEEP_TAIL_CHARS 字推理尾巴，hard 处置时由
//      呼叫端塞进重投的 nudge 文本——避免模型重复思考同一件事（重复长考＝成本翻倍）。
//      注：sse-core 的 N2 stripStaleTurnTextFromReplay 只剥「前端重连重放帧」，不影响模型
//      上下文；模型端推理被丢弃发生在 opencode-client.revertDeadTail（revert 连 assistant
//      推理一起删），本档无权改，故以 nudge 尾巴补偿。回合中注入通道 opencode 不提供
//      （见 steer-gw.ts 注释），故 soft 段没有模型可见的注入点——真正的「先 nudge」在 hard
//      段以「中止＋nudge 同轮重投」实现，soft 段以 widened 预算换取规划时间。
export const REASONING_NOACTION_MAX_CHARS = Number.parseInt(process.env.REASONING_NOACTION_MAX_CHARS || "9000", 10) || 9000
export const REASONING_NOACTION_MAX_MS = Number.parseInt(process.env.REASONING_NOACTION_MAX_MS || "100000", 10) || 100_000
// 首回合（尚未有任何 tool call 与非空正文）的规划宽限：约 2.7x，超限只 soft、不中止。
export const REASONING_FIRST_GEN_MAX_CHARS = Number.parseInt(process.env.REASONING_FIRST_GEN_MAX_CHARS || "24000", 10) || 24_000
export const REASONING_FIRST_GEN_MAX_MS = Number.parseInt(process.env.REASONING_FIRST_GEN_MAX_MS || "150000", 10) || 150_000
// 带回重投 nudge 的推理尾巴上限（有界，避免把整段思维链灌回 prompt）。
export const REASONING_KEEP_TAIL_CHARS = Number.parseInt(process.env.REASONING_KEEP_TAIL_CHARS || "1500", 10) || 1500

// 相容旧汇出：无尾巴、无工具语境下的预设文案（实际路径改用 buildReasoningNudge）。
export const REASONING_CAP_NUDGE =
  "\n\n（系统提示：你已连续长时间只推理、没有任何工具调用或对用户的输出，推理被中止。请立刻：①用一句话给出当前结论；②发出下一个工具调用（需要时先派 subagent / 先调 quote_bundle 并带 items）。不要再展开推理。）"

export type ReasoningCapState = { reasonSinceActionChars?: number; reasonSinceActionAt?: number }

/** 本轮是否已有工具调用与非空正文（首回合判定；由呼叫端自 SessionState 取值）。 */
export type ReasoningCapContext = { hasTool: boolean; hasText: boolean }

export type ReasoningCapPhase = "first-gen" | "active"

export type ReasoningCapVerdict =
  | { kind: "none" }
  | { kind: "soft"; phase: ReasoningCapPhase; tail: string }
  | { kind: "hard"; phase: ReasoningCapPhase; tail: string; overChars: boolean; overMs: boolean }

export type ReasoningDeltaOpts = { now?: number; text?: string; ctx?: ReasoningCapContext }

// 阶段与推理尾巴：不进 SessionState（零型别污染），用 WeakMap 绑会话物件存续期；
// 程序重启后 WeakMap 随物件消失＝回到 fresh turn 语义（与现况一致，不新增持久化）。
type CapMemo = { stage: 0 | 1 | 2; tail: string }
const capMemo = new WeakMap<object, CapMemo>()

function memoOf(st: ReasoningCapState): CapMemo {
  const key = st as unknown as object
  let m = capMemo.get(key)
  if (!m) {
    m = { stage: 0, tail: "" }
    capMemo.set(key, m)
  }
  return m
}

function overBudget(
  st: ReasoningCapState,
  maxChars: number,
  maxMs: number,
  now: number,
): { overChars: boolean; overMs: boolean } {
  const overChars = (st.reasonSinceActionChars ?? 0) >= maxChars
  const at = st.reasonSinceActionAt ?? 0
  const overMs = at > 0 && now - at >= maxMs
  return { overChars, overMs }
}

function resetWindow(st: ReasoningCapState): void {
  st.reasonSinceActionChars = 0
  st.reasonSinceActionAt = 0
}

/**
 * 记一段 reasoning delta，回传升级后的处置：
 *  - "soft"：首回合软限已用尽（呼叫端诚实上报、不 abort），预算改按常规上限重新计。
 *  - "hard"：达到中止门槛（呼叫端带 buildReasoningNudge 的文案同轮重投）。
 * kind!=="none" ⇔ 旧 boolean 版回 true。ctx 缺省视为 active（保守：不误给首回合宽限）。
 */
export function noteReasoningDelta(
  st: ReasoningCapState,
  len: number,
  opts: ReasoningDeltaOpts = {},
): ReasoningCapVerdict {
  const m = memoOf(st)
  if (typeof opts.text === "string" && opts.text.length > 0) {
    m.tail = (m.tail + opts.text).slice(-REASONING_KEEP_TAIL_CHARS)
  }
  if (len <= 0) return { kind: "none" }
  const now = opts.now ?? Date.now()
  if (!st.reasonSinceActionAt) st.reasonSinceActionAt = now
  st.reasonSinceActionChars = (st.reasonSinceActionChars ?? 0) + len

  const ctx = opts.ctx ?? { hasTool: true, hasText: true }
  const phase: ReasoningCapPhase = !ctx.hasTool && !ctx.hasText ? "first-gen" : "active"

  if (phase === "first-gen" && m.stage === 0) {
    const b = overBudget(st, REASONING_FIRST_GEN_MAX_CHARS, REASONING_FIRST_GEN_MAX_MS, now)
    if (b.overChars || b.overMs) {
      m.stage = 1
      resetWindow(st) // 软限后以常规上限重新计＝硬中止的第二段预算
      return { kind: "soft", phase, tail: m.tail }
    }
    return { kind: "none" }
  }
  const b = overBudget(st, REASONING_NOACTION_MAX_CHARS, REASONING_NOACTION_MAX_MS, now)
  if (b.overChars || b.overMs) {
    m.stage = 2
    return { kind: "hard", phase, tail: m.tail, overChars: b.overChars, overMs: b.overMs }
  }
  return { kind: "none" }
}

/** 出现真动作（工具调用／非空正文）或新 turn 起点：归零（含阶段与推理尾巴）。 */
export function resetReasoningCap(st: ReasoningCapState): void {
  resetWindow(st)
  const m = capMemo.get(st as unknown as object)
  if (m) {
    m.stage = 0
    m.tail = ""
  }
}

/** 目前保留的推理尾巴（测试／诊断用）。 */
export function peekReasoningTail(st: ReasoningCapState): string {
  return capMemo.get(st as unknown as object)?.tail ?? ""
}

/**
 * 动作导向 nudge（结构化）：指示下一步做什么，而非只说「不要再推理」。
 *  - hasTool=true（本轮已动作过）→ 收束结论＋续发下一步工具（或收尾）。
 *  - hasTool=false（首回合尚无动作）→ 给出第一个工具调用。
 * tail 非空时附上「保留的推理摘要」，让模型沿用而非从零重推。
 *
 * 2026-10-04 W：本站只做简体，语言漂移修复留下的繁体镜像变体已拆除；文案收成单一简体常量。
 */

const NUDGE_HEAD_ACTIVE =
  "\n\n（系统提示：你已连续长时间只推理。请立刻收束：①用一句话给出当前结论；②发出下一个工具调用（继续未完成的步骤；若已可收尾，直接给出最终答复）。不要再展开推理。"
const NUDGE_HEAD_FIRST =
  "\n\n（系统提示：你已连续长时间只推理、尚未发出任何工具调用，推理被中止。请立刻：①用一句话给出当前结论；②发出第一个工具调用（例如查余额 / 派 subagent / 发第一条指令）。不要再展开推理。"
const NUDGE_KEPT_PREFIX = "\n【保留的推理摘要，直接沿用，勿重复推演】"

export function buildReasoningNudge(opts: { hasTool: boolean; tail?: string }): string {
  const head = opts.hasTool ? NUDGE_HEAD_ACTIVE : NUDGE_HEAD_FIRST
  const tail = (opts.tail ?? "").trim()
  const kept = tail ? `${NUDGE_KEPT_PREFIX}${tail}` : ""
  return `${head}${kept}）`
}
