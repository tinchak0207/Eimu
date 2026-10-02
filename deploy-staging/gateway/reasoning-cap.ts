// 2026-10-02 e2e 成片評測：「無工具長推理」回合內自我糾偏。
// 病灶：企劃段 ~3 分鐘 reasoning:message≈800:1、零工具——既有空轉止損（finalizeIdleStep）
// 只在 step-finish 結算，而「單個 step 內無限推理」永遠到不了 step-finish，且非空 reasoning
// 會讓空 step 計數歸零 → 斷路器根本不會響。
// 機制：累計「自上次動作（非 no-op 工具 / 非空正文）以來」的 reasoning 字數與起算時間，
// 超過上限即回報處置決定，由事件處理器呼叫既有 triggerIdleStepBreaker（中止 + 同輪帶糾偏
// 提示重投，每 turn 僅一次、不循環）。純函數，無 gateway 依賴。
//
// 2026-10-02 修復（減少「長考下臭棋」，但不放縱空轉）：
//   1) 首回合保護：開工首個 gen（尚無任何 tool call 與非空正文）給更寬的規劃預算。
//      實錄：底模 glm-5.3 首回合 46.5s 全在推理（t_first_text/t_first_tool 皆 null），
//      9000 字上限在「正在規劃」時就腰斬＝誤傷。首回合軟上限放大約 2.7x，未到硬上限不中止。
//   2) 兩段式，超限不直接 abort：首回合破軟限只回 "soft"（呼叫端誠實上報、不 abort）；
//      軟限後以常規上限重新計，再破才回 "hard"（中止 + 帶 nudge 同輪重投）。
//      已有工具／正文的回合維持原門檻，直接 "hard"。
//   3) nudge 品質：buildReasoningNudge 依「本輪是否已有工具調用」給兩套動作導向文案
//      （首回合→給出第一個工具調用；已動作過→續發下一步工具或收尾），非只說「不要再推理」。
//   4) 推理保留：本模組滾動保存最近 REASONING_KEEP_TAIL_CHARS 字推理尾巴，hard 處置時由
//      呼叫端塞進重投的 nudge 文本——避免模型重複思考同一件事（重複長考＝成本翻倍）。
//      註：sse-core 的 N2 stripStaleTurnTextFromReplay 只剝「前端重連重放幀」，不影響模型
//      上下文；模型端推理被丟棄發生在 opencode-client.revertDeadTail（revert 連 assistant
//      推理一起刪），本檔無權改，故以 nudge 尾巴補償。回合中注入通道 opencode 不提供
//      （見 steer-gw.ts 註釋），故 soft 段沒有模型可見的注入點——真正的「先 nudge」在 hard
//      段以「中止＋nudge 同輪重投」實現，soft 段以 widened 預算換取規劃時間。
export const REASONING_NOACTION_MAX_CHARS = Number.parseInt(process.env.REASONING_NOACTION_MAX_CHARS || "9000", 10) || 9000
export const REASONING_NOACTION_MAX_MS = Number.parseInt(process.env.REASONING_NOACTION_MAX_MS || "100000", 10) || 100_000
// 首回合（尚未有任何 tool call 與非空正文）的規劃寬限：約 2.7x，超限只 soft、不中止。
export const REASONING_FIRST_GEN_MAX_CHARS = Number.parseInt(process.env.REASONING_FIRST_GEN_MAX_CHARS || "24000", 10) || 24_000
export const REASONING_FIRST_GEN_MAX_MS = Number.parseInt(process.env.REASONING_FIRST_GEN_MAX_MS || "150000", 10) || 150_000
// 帶回重投 nudge 的推理尾巴上限（有界，避免把整段思維鏈灌回 prompt）。
export const REASONING_KEEP_TAIL_CHARS = Number.parseInt(process.env.REASONING_KEEP_TAIL_CHARS || "1500", 10) || 1500

// 相容舊匯出：無尾巴、無工具語境下的預設文案（實際路徑改用 buildReasoningNudge）。
export const REASONING_CAP_NUDGE =
  "\n\n（系统提示：你已连续长时间只推理、没有任何工具调用或对用户的输出，推理被中止。请立刻：①用一句话给出当前结论；②发出下一个工具调用（需要时先派 subagent / 先调 quote_bundle 并带 items）。不要再展开推理。）"

export type ReasoningCapState = { reasonSinceActionChars?: number; reasonSinceActionAt?: number }

/** 本輪是否已有工具調用與非空正文（首回合判定；由呼叫端自 SessionState 取值）。 */
export type ReasoningCapContext = { hasTool: boolean; hasText: boolean }

export type ReasoningCapPhase = "first-gen" | "active"

export type ReasoningCapVerdict =
  | { kind: "none" }
  | { kind: "soft"; phase: ReasoningCapPhase; tail: string }
  | { kind: "hard"; phase: ReasoningCapPhase; tail: string; overChars: boolean; overMs: boolean }

export type ReasoningDeltaOpts = { now?: number; text?: string; ctx?: ReasoningCapContext }

// 階段與推理尾巴：不進 SessionState（零型別污染），用 WeakMap 綁會話物件存續期；
// 程序重啟後 WeakMap 隨物件消失＝回到 fresh turn 語義（與現況一致，不新增持久化）。
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
 * 記一段 reasoning delta，回傳升級後的處置：
 *  - "soft"：首回合軟限已用盡（呼叫端誠實上報、不 abort），預算改按常規上限重新計。
 *  - "hard"：達到中止門檻（呼叫端帶 buildReasoningNudge 的文案同輪重投）。
 * kind!=="none" ⇔ 舊 boolean 版回 true。ctx 缺省視為 active（保守：不誤給首回合寬限）。
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
      resetWindow(st) // 軟限後以常規上限重新計＝硬中止的第二段預算
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

/** 出現真動作（工具調用／非空正文）或新 turn 起點：歸零（含階段與推理尾巴）。 */
export function resetReasoningCap(st: ReasoningCapState): void {
  resetWindow(st)
  const m = capMemo.get(st as unknown as object)
  if (m) {
    m.stage = 0
    m.tail = ""
  }
}

/** 目前保留的推理尾巴（測試／診斷用）。 */
export function peekReasoningTail(st: ReasoningCapState): string {
  return capMemo.get(st as unknown as object)?.tail ?? ""
}

/**
 * 動作導向 nudge（結構化）：指示下一步做什麼，而非只說「不要再推理」。
 *  - hasTool=true（本輪已動作過）→ 收束結論＋續發下一步工具（或收尾）。
 *  - hasTool=false（首回合尚無動作）→ 給出第一個工具調用。
 * tail 非空時附上「保留的推理摘要」，讓模型沿用而非從零重推。
 */
export function buildReasoningNudge(opts: { hasTool: boolean; tail?: string }): string {
  const head = opts.hasTool
    ? "\n\n（系统提示：你已连续长时间只推理。请立刻收束：①用一句话给出当前结论；②发出下一个工具调用（继续未完成的步骤；若已可收尾，直接给出最终答复）。不要再展开推理。"
    : "\n\n（系统提示：你已连续长时间只推理、尚未发出任何工具调用，推理被中止。请立刻：①用一句话给出当前结论；②发出第一个工具调用（例如查余额 / 派 subagent / 发第一条指令）。不要再展开推理。"
  const tail = (opts.tail ?? "").trim()
  const kept = tail ? `\n【保留的推理摘要，直接沿用，勿重复推演】${tail}` : ""
  return `${head}${kept}）`
}
