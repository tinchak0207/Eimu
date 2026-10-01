// video-model-select.ts —— 視頻模型選型單真源（2026-10-02，MODEL-SELECT 修復）。
//
// 病根：minimax-h3 近 72h 16 單 0 成功、斷路器 open，但工作流仍選它——
//   ① 寫死兜底 `model = "minimax-h3"`；② failover 候選按 24h success_rate 排序、缺數據一律 0.5，
//   無交付證據的模型與有證據者同等；③ 只在 availability==="unavailable" 時才換，
//   「available 但近 24h 零交付」放行。
// 規則：只選「近期有真實交付且斷路器非 open」者；無任何 proven 時才退到「無近期樣本」
// （jobs=0，沒有被證偽）者，其中 seedance-2.0 優先；有 ≥ZERO_DELIVERY_MIN_JOBS 單且 0 交付者永遠排除。
// 純函數、無 I/O，供 pickDefaultVideoModel / resolveActiveModel / 兜底共用。

export const VIDEO_FALLBACK_MODEL = "seedance-2.0"
/** 近 24h 至少這麼多單且 0 交付才判「已被證偽」（避免單次抖動毒死好模型）。 */
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

/** 近 24h 已被證偽：有足量單而 0 交付。 */
export function disprovenRecently(m: ModelStatusEntryLike): boolean {
  return num(m.last_24h?.jobs) >= ZERO_DELIVERY_MIN_JOBS && num(m.last_24h?.delivered) === 0
}

/** 為何不可選；可選回 null。 */
export function videoDisqualifyReason(m: ModelStatusEntryLike | undefined): string | null {
  if (!m) return null // 目錄沒這個模型：不在此判（由呼叫端決定）
  if (m.availability === "unavailable") return `不可用${m.note ? `（${String(m.note).slice(0, 60)}）` : ""}`
  if (breakerOpen(m)) return "斷路器 open（近 72h 真實生成全失敗/極低成功率）"
  if (disprovenRecently(m)) return `近 24h ${num(m.last_24h?.jobs)} 單 0 交付`
  return null
}

export function isProvenVideoModel(m: ModelStatusEntryLike): boolean {
  return m.media_type === "video" && m.availability === "available" && !breakerOpen(m) && num(m.last_24h?.delivered) > 0
}

/** 可選視頻模型，由優到劣：proven(交付數降序→成功率)；其次無樣本者（seedance-2.0 優先）。 */
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
