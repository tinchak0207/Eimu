export interface SmokeAuth {
  informationGoal?: unknown
  maxRuns?: unknown
}

export function countsTowardCompletion(graph: {
  entry?: { via?: string } | null
  brief?: { text?: string }[]
}): boolean {
  const text = graph.brief?.[0]?.text
  return graph.entry?.via === "session_api" && typeof text === "string" && text.trim().length > 0
}

export function morphologyOf(nodes: Record<string, { type?: string; params?: Record<string, unknown> }>): string {
  return Object.values(nodes)
    .map((node) => ({ type: String(node.type ?? ""), keys: Object.keys(node.params ?? {}).sort() }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.keys.join(",").localeCompare(b.keys.join(",")))
    .map((node) => `${node.type}|${node.keys.join(",")}`)
    .join(";")
}

export function admitSmoke(priorSameMorphology: number, newFailureClass: string | null | undefined): { allow: boolean; reason: string } {
  const failure = (newFailureClass ?? "").trim()
  if (priorSameMorphology >= 3 && failure.length === 0) {
    return { allow: false, reason: "同一形态已经跑满 3 次，没有新的失败，停止" }
  }
  return { allow: true, reason: "" }
}

export function parsePaidAuth(input: SmokeAuth): { ok: true; informationGoal: string; maxRuns: number } | { ok: false; reason: string } {
  const goal = typeof input.informationGoal === "string" ? input.informationGoal.trim() : ""
  if (!goal) return { ok: false, reason: "付费授权要写明想得到的信息" }
  if (/导出\s*\d+/.test(goal) || /export\s+\d+/i.test(goal) || goal.includes("线上首句导出")) {
    return { ok: false, reason: "计数器不能当目标" }
  }
  const maxRuns = input.maxRuns
  if (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 3) {
    return { ok: false, reason: "最多跑几次必须是 1 到 3 的整数" }
  }
  return { ok: true, informationGoal: goal, maxRuns }
}

export function admitPipelineSmoke(input: {
  sessionEntry: boolean
  informationGoal?: unknown
  maxRuns?: unknown
  sampleId?: unknown
  sentence?: unknown
  registry: Record<string, string>
  priorSameMorphology?: number
  newFailureClass?: string | null
}): { allow: boolean; reason: string } {
  if (input.sessionEntry) return { allow: true, reason: "" }
  const auth = parsePaidAuth(input)
  if (!auth.ok) return { allow: false, reason: auth.reason }
  const sampleId = typeof input.sampleId === "string" ? input.sampleId : ""
  const expected = input.registry[sampleId]
  if (typeof expected !== "string") return { allow: false, reason: "样本不在外部登记" }
  if (input.sentence !== expected) return { allow: false, reason: "句子必须与外部样本全等" }
  const prior = input.priorSameMorphology ?? 0
  if (prior >= auth.maxRuns && (input.newFailureClass ?? "").trim().length === 0) {
    return { allow: false, reason: `同一形态已经跑满 ${auth.maxRuns} 次，没有新的失败，停止` }
  }
  return admitSmoke(prior, input.newFailureClass)
}
