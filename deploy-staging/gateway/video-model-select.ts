// video-model-select.ts —— 视频模型选型单真源（2026-10-02，MODEL-SELECT 修复）。
//
// 病根：minimax-h3 近 72h 16 单 0 成功、断路器 open，但工作流仍选它——
//   ① 写死兜底 `model = "minimax-h3"`；② failover 候选按 24h success_rate 排序、缺数据一律 0.5，
//   无交付证据的模型与有证据者同等；③ 只在 availability==="unavailable" 时才换，
//   「available 但近 24h 零交付」放行。
// 规则：只选「近期有真实交付且断路器非 open」者；无任何 proven 时才退到「无近期样本」
// （jobs=0，没有被证伪）者，其中 minimax-h3 优先；有 ≥ZERO_DELIVERY_MIN_JOBS 单且 0 交付者永远排除。
// 纯函数、无 I/O，供 pickDefaultVideoModel / resolveActiveModel / 兜底共用。

export const VIDEO_FALLBACK_MODEL = "minimax-h3"
/** 近 24h 至少这么多单且 0 交付才判「已被证伪」（避免单次抖动毒死好模型）。 */
export const ZERO_DELIVERY_MIN_JOBS = 3

export interface ModelStatusEntryLike {
  id?: string
  media_type?: string
  availability?: string
  breaker?: string
  breaker_state?: string
  channel_id?: string
  note?: string
  last_24h?: { jobs?: unknown; delivered?: unknown; success_rate?: unknown }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

export function breakerOpen(m: ModelStatusEntryLike): boolean {
  return m.breaker === "open" || m.breaker_state === "open"
}

/** 近 24h 已被证伪：有足量单而 0 交付。 */
export function disprovenRecently(m: ModelStatusEntryLike): boolean {
  return num(m.last_24h?.jobs) >= ZERO_DELIVERY_MIN_JOBS && num(m.last_24h?.delivered) === 0
}

/** 为何不可选；可选回 null。 */
export function videoDisqualifyReason(m: ModelStatusEntryLike | undefined): string | null {
  if (!m) return null // 目录没这个模型：不在此判（由呼叫端决定）
  if (m.availability === "unavailable") return `不可用${m.note ? `（${String(m.note).slice(0, 60)}）` : ""}`
  if (breakerOpen(m)) return "断路器 open（近 72h 真实生成全失败/极低成功率）"
  if (disprovenRecently(m)) return `近 24h ${num(m.last_24h?.jobs)} 单 0 交付`
  return null
}

export function isProvenVideoModel(m: ModelStatusEntryLike): boolean {
  return m.media_type === "video" && m.availability === "available" && !breakerOpen(m) && num(m.last_24h?.delivered) > 0
}

/** 可选视频模型，由优到劣：proven(交付数降序→成功率)；其次无样本者（minimax-h3 优先）。 */
export function rankVideoModels(
  models: readonly ModelStatusEntryLike[],
  exclude: ReadonlySet<string> = new Set(),
): Array<{ id: string; proven: boolean }> {
  const ok = models.filter(
    (m) =>
      m.media_type === "video" &&
      typeof m.id === "string" &&
      !exclude.has(m.id) &&
      m.availability === "available" &&
      videoDisqualifyReason(m) === null,
  )
  const proven = ok
    .filter(isProvenVideoModel)
    .sort((a, b) => num(b.last_24h?.delivered) - num(a.last_24h?.delivered) || num(b.last_24h?.success_rate) - num(a.last_24h?.success_rate))
  const noSample = ok
    .filter((m) => !isProvenVideoModel(m) && num(m.last_24h?.jobs) === 0)
    .sort((a, b) => Number(b.id === VIDEO_FALLBACK_MODEL) - Number(a.id === VIDEO_FALLBACK_MODEL))
  return [...proven.map((m) => ({ id: m.id as string, proven: true })), ...noSample.map((m) => ({ id: m.id as string, proven: false }))]
}

export function pickVideoModel(models: readonly ModelStatusEntryLike[], exclude?: ReadonlySet<string>): { id: string; proven: boolean } | null {
  return rankVideoModels(models, exclude)[0] ?? null
}
