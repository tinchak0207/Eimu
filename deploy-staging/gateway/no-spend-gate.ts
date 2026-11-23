// 不花钱/只做前期 意图闸（2026-11-03）。
//
// 病灶：用户说「先只做前期、不花钱」或刚拒绝过扣费确认，orchestrator 照样派美术/作曲子代理去
// 提交 image_generate／谱曲；唯一挡住的是子代理调付费工具时的确认卡（用户得再拒一次，auto 模式
// 下甚至直接扣）。应在**派工当下**拦：任务书要付费产出 + 本轮用户有不花钱信号 → 409。
// 信号只认两样真值：①最后一条用户消息的不花钱/只做前期措辞；②最后一条用户消息之后用户
// 亲手拒绝（denied，不含过期）过付费确认。用户下一条消息若不再带该措辞即自然解除。
// 零依赖纯函数，呼叫端（subagent-dispatch）传入状态。

/** 用户措辞：不花钱 / 只做前期 / 先别生成。 */
export const NO_SPEND_RE =
  /(?:不(?:要|想)?花钱|别花钱|不扣费|别扣费|零(?:花费|付费|扣费)|先(?:别|不要?)(?:花|扣|生成|出图|出片|开跑|跑图)|(?:只|先)做前期|只(?:做|要)(?:方案|策划|设定|文案|剧本|大纲|调研|研究)|暂(?:时)?不(?:要)?(?:生成|出图|出片|花钱)|不要(?:生成|出图|出片)(?:任何(?:东西|媒体)?)?(?=$|[，,。！!；;、\s]))/

/** 反向措辞「不要只做前期／别只要方案」＝要花钱，先剥掉再判。 */
const NEGATED_NO_SPEND_RE = /(?:不要|别|不)只(?:做|要)/g

/** 任务书自己声明零付费（研究/提示词包这类派工）→ 不算付费派工。 */
const TASK_DECLARES_FREE_RE =
  /(?:零(?:付费|生成|扣费)|不(?:生成|调用)任何|任何付费生成|禁止(?:调用)?[^。\n]{0,24}(?:付费|生成|image_generate|image_edit|video_|music_)|纯文本产物|只做(?:检索|研究|文本|写作))/

/** 任务书要付费产出：点名付费工具、生成媒体、定妆/试拍、报单价。 */
const TASK_SPENDS_RE =
  /(?:image_generate|image_edit|video_generate|video_submit|music_generate|music_submit|tts_generate|生成[^。\n]{0,8}(?:图|图片|图像|视频|音轨|音乐|音频|配音|成片)|(?:出|生)图|出片|提交[^。\n]{0,8}(?:图|视频|生成)|定妆|试拍|单价\s*\d+(?:\.\d+)?\s*币)/i

/** 天然付费的 expert（作曲＝music_generate）。 */
const SPENDING_EXPERTS = new Set(["music"])

export type NoSpendSignal = { lastUserMessage?: string; lastUserAt?: number; resolvedConfirms?: Map<string, { outcome: string; resolvedAt: number }> }

export function noSpendSignal(s: NoSpendSignal): "user_words" | "declined_confirm" | null {
  if (typeof s.lastUserMessage === "string" && NO_SPEND_RE.test(s.lastUserMessage.replace(NEGATED_NO_SPEND_RE, ""))) return "user_words"
  const since = typeof s.lastUserAt === "number" ? s.lastUserAt : 0
  for (const r of s.resolvedConfirms?.values() ?? []) {
    if (r.outcome === "denied" && r.resolvedAt >= since) return "declined_confirm"
  }
  return null
}

export function taskSpends(taskText: string, expertId: string): boolean {
  if (TASK_DECLARES_FREE_RE.test(taskText)) return false
  return SPENDING_EXPERTS.has(expertId) || TASK_SPENDS_RE.test(taskText)
}

export function noSpendBlockReason(taskText: string, expertId: string, s: NoSpendSignal): string | null {
  const sig = noSpendSignal(s)
  if (!sig || !taskSpends(taskText, expertId)) return null
  const why = sig === "user_words" ? "用户最后一条消息说了不花钱/只做前期" : "用户刚拒绝了付费确认"
  return `【机器闸·no-spend】${why}，本任务书要付费产出（出图/视频/音乐），已拒绝派工。改派零付费的前期任务（研究/设定/剧本/分镜/提示词包，任务书里写明「零付费、禁止调用生成工具」），或先用 question 问用户是否现在开始花钱；用户下一条消息明确同意后再派。`
}
