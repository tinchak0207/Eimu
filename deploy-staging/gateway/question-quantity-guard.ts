// question-quantity-guard.ts —— 2026-11-04：用户原话已明确「数量=1」时，网关硬拦模型把数量扩成多张／多方向的 question 卡。
// 病灶（真会话 /tmp/human-e2e-2026-11-04T13-33-53-301Z）：用户说「给我一张极简风的咖啡馆海报」，orchestrator 仍弹
// 「3 候选×2K 18 币（推荐）／1 张×2K 6 币／4 候选×2K 24 币」问卡——AGENTS.md 与技能里的「数量以用户字面为准」压不住 flash 模型，
// 提示词是建议、网关才是闸。本模块纯函数、无 IO：判「用户是否明确数量=1」「某道子问题是否把数量扩成多」「该怎么自动作答」。
// 不拦：用户没说明确数量、用户明说「几个方案／多个方向／出几版」、子问题选项里没有 N≥2 的数量扩张（真正的审美／文案取舍照常出卡）。

import type { PendingQuestion } from "./types-gateway.ts"

type QItem = PendingQuestion["questions"][number]

const ONE = "(?:一|1|壹)"
const CLASSIFIER = "[张首段个条幅版套份支曲]"
/** 用户明确的单量：一张／1张／一首／一段／一个…（不吃「第一张」「这一张」「一张一张」类的不影响，因为后续还要有多量扩张才会触发）。 */
const SINGLE_RE = new RegExp(`(?<![\\d第])${ONE}\\s*${CLASSIFIER}|单张|单首|单曲|只要一|仅要一|就要一`)
/** 用户明说多量／要对比：出现任何一个就整体放弃拦截。 */
const MULTI_INTENT_RE = new RegExp(
  [
    "几(?:个|张|首|版|种|套|条)?\\s*(?:方案|方向|版|风格|选择|候选|张|首|种)",
    "多(?:个|张|套|种|首|版)",
    "(?:[二两三四五六七八九十]|[2-9]|[1-9]\\d)\\s*(?:个|张|首|版|套|种|条|幅|份)",
    "各\\s*[一二两三四五六七八九十\\d]",
    "对比|备选|候选|不同方向|不同风格|都(?:出|做|要)|专辑|歌单|合集|系列|套图|组图|全套|整套|分镜|多镜",
  ].join("|"),
)

/** 用户原话是否明确了「数量=1」且没有任何要多量的信号。 */
export function userDemandsSingleQuantity(userText: string | undefined | null): boolean {
  const text = typeof userText === "string" ? userText : ""
  if (!text.trim()) return false
  if (!SINGLE_RE.test(text)) return false
  // 剥掉「10 秒」「2K」「4:5」之类带数字但非数量的串，避免误触发 MULTI（上面 MULTI 的 N+classifier 本就要求 classifier，这里只防「3 个字」类）。
  return !MULTI_INTENT_RE.test(text)
}

const NUM = "(?:[2-9]|[1-9]\\d|[二两三四五六七八九十])"
/** 选项／问题里的「N≥2 数量扩张」：N 候选、N 个方向、N 张、×N、N 首、N 版、多方向。 */
const EXPAND_RE = new RegExp(
  [
    `${NUM}\\s*(?:个)?\\s*(?:候选|方向|方案|版本|张|首|段|条|版|幅|套)`,
    `[×xX＊*]\\s*${NUM}(?![\\dKk:：x])`,
    "多方向|多个方向|多候选|多张|多版",
  ].join("|"),
)
const SINGLE_OPTION_RE = new RegExp(`(?<![\\d第])${ONE}\\s*${CLASSIFIER}|单张|单首|仅\\s*1|只(?:出|要)\\s*(?:1|一)`)

/** 该子问题是否把数量扩成多：至少一个选项 label 含 N≥2 扩张。 */
export function questionExpandsQuantity(q: QItem): boolean {
  return (q.options ?? []).some((o) => EXPAND_RE.test(o.label))
}

/** 给扩张型子问题选「单量」答案：优先选项里的单量项；没有则合成一句话。 */
function pickSingleAnswer(q: QItem): string {
  const hit = (q.options ?? []).find((o) => SINGLE_OPTION_RE.test(o.label) && !EXPAND_RE.test(o.label))
  return hit ? hit.label : "只出 1 张（用户已明确数量=1）"
}

export const QUANTITY_GUARD_NOTE = "【系统】用户已明确数量=1，按单张直接下单，不要扩成多张／多方向；收费只走既有确认卡／预算闸，不要再弹数量或开工问卡。"

export type QuantityGuardPlan =
  | { kind: "none" }
  /** 所有子问题都是数量扩张：整张卡不展示，直接代答。 */
  | { kind: "all"; answers: string[][] }
  /** 只有部分子问题是数量扩张：展示其余子问题，扩张的那几道自动答。 */
  | { kind: "partial"; visible: QItem[]; merge: { total: number; auto: Array<{ index: number; answer: string }> } }

export function planQuantityGuard(userText: string | undefined | null, questions: QItem[]): QuantityGuardPlan {
  if (!questions.length || !userDemandsSingleQuantity(userText)) return { kind: "none" }
  const auto: Array<{ index: number; answer: string }> = []
  const visible: QItem[] = []
  questions.forEach((q, index) => {
    if (questionExpandsQuantity(q)) auto.push({ index, answer: pickSingleAnswer(q) })
    else visible.push(q)
  })
  if (auto.length === 0) return { kind: "none" }
  if (visible.length === 0) {
    return { kind: "all", answers: auto.map((a) => [`${a.answer}。${QUANTITY_GUARD_NOTE}`]) }
  }
  return {
    kind: "partial",
    visible,
    merge: { total: questions.length, auto: auto.map((a) => ({ index: a.index, answer: `${a.answer}。${QUANTITY_GUARD_NOTE}` })) },
  }
}

/** 把用户对「可见子问题」的答案按原序与自动答案合并回完整 answers（长度=原 questions 数）。 */
export function mergeGuardedAnswers(
  merge: { total: number; auto: Array<{ index: number; answer: string }> },
  userAnswers: string[][],
): string[][] {
  const autoByIdx = new Map(merge.auto.map((a) => [a.index, a.answer]))
  const out: string[][] = []
  let u = 0
  for (let i = 0; i < merge.total; i++) {
    const a = autoByIdx.get(i)
    if (a !== undefined) out.push([a])
    else out.push(userAnswers[u++] ?? [""])
  }
  return out
}
