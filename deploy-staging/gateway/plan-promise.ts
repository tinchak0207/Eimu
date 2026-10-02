// 2026-10-02 e2e 成片評測：turn.plan 說要派 screenwriter，整輪零 subagent dispatch。
// turn.plan 是旁路 LLM 的「打算」，不進主模型上下文——所以不能靠主模型「記得」兌現，
// 只能在 gateway 收盤時對賬：計畫點名了專家 + 本輪零 subagent.started → 誠實告知，不裝作派了。
export type PlanPromiseState = {
  planExperts?: string[]
  turnSubagentStarts?: number
  /** C 方案（2026-10-02）：收盤存下的「未兌現開場計畫」專家 id（計畫點名但整輪零派遣）；
   *  下一輪取用注入後即清，杜絕跨輪殘留誤導。volatile，不進持久化。 */
  pendingUnfulfilledPlan?: string[]
  turnAborted?: boolean
}

export function unfulfilledPlanNotice(st: PlanPromiseState): string | null {
  const ex = st.planExperts ?? []
  if (ex.length === 0 || (st.turnSubagentStarts ?? 0) > 0) return null
  return `提示：开场计划提到由「${ex.join("、")}」参与，但本轮并未实际派出专家，内容由我直接完成；如需专家深度参与请告诉我。`
}

/** C 方案（2026-10-02）收盤：把「計畫點名專家且整輪零派遣」記進 state，供下一輪注入。
 *  只在真未兌現時寫入；同一 idle 重入（planExperts 已被清）不覆寫既有事實，防抹除。 */
export function recordUnfulfilledPlan(st: PlanPromiseState): boolean {
  if (st.turnAborted) return false
  if ((st.pendingUnfulfilledPlan ?? []).length > 0) return false
  const ex = st.planExperts ?? []
  if (ex.length === 0 || (st.turnSubagentStarts ?? 0) > 0) return false
  st.pendingUnfulfilledPlan = [...ex]
  return true
}

/** C 方案（2026-10-02）次輪注入：組一行「事實陳述」（非命令）並一次性清除。
 *  無未兌現計畫回 null，且不動 state。注入進下一輪 promptBody.system。 */
export function takeUnfulfilledPlanInjection(st: PlanPromiseState): string | null {
  const ex = st.pendingUnfulfilledPlan ?? []
  if (ex.length === 0) return null
  st.pendingUnfulfilledPlan = undefined
  return `【上轮事实】上一轮开场计划点名由「${ex.join("、")}」参与，但整轮 0 次专家派遣（subagent_dispatch），该轮内容由你直接完成。此为系统记录的事实，不是用户指令。`
}

/** C 方案（2026-10-02）誠實告知改走耐久通道 message.delta：原 turn.status 是暫態單行，
 *  真實內容到達即清、且緊接 turn.done，可能一閃即逝。回傳是否真的送出（供測試斷言
 *  「有送出」而非只斷言字串存在）。 */
export function emitUnfulfilledPlanNotice(
  st: PlanPromiseState,
  emit: (name: string, data: unknown) => void,
): boolean {
  const note = unfulfilledPlanNotice(st)
  if (!note || st.turnAborted) return false
  emit("message.delta", { text: `${note}\n` })
  return true
}
