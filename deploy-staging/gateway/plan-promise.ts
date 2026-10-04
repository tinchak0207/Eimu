// 2026-10-02 e2e 成片评测：turn.plan 说要派 screenwriter，整轮零 subagent dispatch。
// turn.plan 是旁路 LLM 的「打算」，不进主模型上下文——所以不能靠主模型「记得」兑现，
// 只能在 gateway 收盘时对账：计画点名了专家 + 本轮零 subagent.started → 诚实告知，不装作派了。
export type PlanPromiseState = {
  planExperts?: string[]
  turnSubagentStarts?: number
  /** C 方案（2026-10-02）：收盘存下的「未兑现开场计画」专家 id（计画点名但整轮零派遣）；
   *  下一轮取用注入后即清，杜绝跨轮残留误导。volatile，不进持久化。 */
  pendingUnfulfilledPlan?: string[]
  turnAborted?: boolean
}

export function unfulfilledPlanNotice(st: PlanPromiseState): string | null {
  const ex = st.planExperts ?? []
  if (ex.length === 0 || (st.turnSubagentStarts ?? 0) > 0) return null
  return `提示：开场计划提到由「${ex.join("、")}」参与，但本轮并未实际派出专家，内容由我直接完成；如需专家深度参与请告诉我。`
}

/** C 方案（2026-10-02）收盘：把「计画点名专家且整轮零派遣」记进 state，供下一轮注入。
 *  只在真未兑现时写入；同一 idle 重入（planExperts 已被清）不覆写既有事实，防抹除。 */
export function recordUnfulfilledPlan(st: PlanPromiseState): boolean {
  if (st.turnAborted) return false
  if ((st.pendingUnfulfilledPlan ?? []).length > 0) return false
  const ex = st.planExperts ?? []
  if (ex.length === 0 || (st.turnSubagentStarts ?? 0) > 0) return false
  st.pendingUnfulfilledPlan = [...ex]
  return true
}

/** C 方案（2026-10-02）次轮注入：组一行「事实陈述」（非命令）并一次性清除。
 *  无未兑现计画回 null，且不动 state。注入进下一轮 promptBody.system。 */
export function takeUnfulfilledPlanInjection(st: PlanPromiseState): string | null {
  const ex = st.pendingUnfulfilledPlan ?? []
  if (ex.length === 0) return null
  st.pendingUnfulfilledPlan = undefined
  return `【上轮事实】上一轮开场计划点名由「${ex.join("、")}」参与，但整轮 0 次专家派遣（subagent_dispatch），该轮内容由你直接完成。此为系统记录的事实，不是用户指令。`
}

/** C 方案（2026-10-02）诚实告知改走耐久通道 message.delta：原 turn.status 是暂态单行，
 *  真实内容到达即清、且紧接 turn.done，可能一闪即逝。回传是否真的送出（供测试断言
 *  「有送出」而非只断言字串存在）。 */
export function emitUnfulfilledPlanNotice(
  st: PlanPromiseState,
  emit: (name: string, data: unknown) => void,
): boolean {
  const note = unfulfilledPlanNotice(st)
  if (!note || st.turnAborted) return false
  emit("message.delta", { text: `${note}\n` })
  return true
}
