import type { MemoryAcceptedRef } from "./memory-batch-types.ts"
export function acceptedRefInputIdentity(ref: MemoryAcceptedRef): { domain: string; slug: string } {
  if (typeof ref.inputDomain === "string" && ref.inputDomain && typeof ref.inputSlug === "string" && ref.inputSlug) {
    return { domain: ref.inputDomain, slug: ref.inputSlug }
  }
  return { domain: ref.domain, slug: ref.slug }
}

/** 解析 ingest 回执的 `accepted_refs`（缺省＝空阵列，兼容旧端点）。 */
export function parseAcceptedRefs(raw: unknown): MemoryAcceptedRef[] {
  if (!Array.isArray(raw)) return []
  const out: MemoryAcceptedRef[] = []
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== "string" || !r.id) continue
    if (typeof r.scope !== "string" || typeof r.domain !== "string" || typeof r.slug !== "string") continue
    const batchId = typeof r.batchId === "string" ? r.batchId : typeof r.batch_id === "string" ? r.batch_id : undefined
    const ownerKey = typeof r.ownerKey === "string" ? r.ownerKey : typeof r.owner_key === "string" ? r.owner_key : undefined
    const inputDomain =
      typeof r.inputDomain === "string" ? r.inputDomain : typeof r.input_domain === "string" ? r.input_domain : undefined
    const inputSlug =
      typeof r.inputSlug === "string" ? r.inputSlug : typeof r.input_slug === "string" ? r.input_slug : undefined
    out.push({ id: r.id, batchId, scope: r.scope, ownerKey, domain: r.domain, slug: r.slug, inputDomain, inputSlug })
  }
  return out
}

/**
 * 身份键：scope|ownerKey|domain|slug（ownerKey 缺省＝空串，shared 恒为空）。
 * 用于候选→回执归属：同一 slug 在不同 domain/owner 下是不同身份，不得用 slug 集合去重。
 */
export function memoryIdentityKey(ref: { scope: string; ownerKey?: string; domain: string; slug: string }): string {
  return `${ref.scope}|${ref.ownerKey ?? ""}|${ref.domain}|${ref.slug}`
}
// ─────────────────────────── 常量

export const INGEST_PATH = "/api/agent/memory/ingest"
export const REVIEW_PATH = "/api/agent/memory/review"
export const CONCURRENCY = 3
export const MAX_ATTEMPTS = 5 // 指数退避上限（含跨 run 重试），超过落 memory-failed/
export const DEFAULT_MAX_SESSIONS = 50
export const DEFAULT_MAX_LLM = 150
export const CURSOR_FILE = "memory-cursor.json"
export const PENDING_DIR = "memory-pending"
export const FAILED_DIR = "memory-failed"
export const REPORTS_DIR = "memory-batches"
// badcase 集（PRD §5.6）：【本地决定】比照 pending 目录系（见档头），落 `memory-badcases/`。
export const BADCASES_DIR = "memory-badcases"
/** §5.6 抽检判据常量：30%、最少 3（不足全抽）、平均 <1.5 或任一 0 分触发。 */
const SAMPLING_RATE = 0.3
const SAMPLING_MIN = 3
export const SAMPLING_AVG_TRIGGER = 1.5

export const DEFAULTS = {
  maxSessions: DEFAULT_MAX_SESSIONS,
  maxLlm: DEFAULT_MAX_LLM,
} as const

// ─────────────────────────── 小工具（纯函式）

export function envInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function envBool(raw: string | undefined, fallback: boolean): boolean {
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return fallback
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export function isoDateOf(value: string | number | undefined): string {
  if (value === undefined || value === null) return ""
  const ms = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toISOString().slice(0, 10)
}

export function epochOf(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0
  const ms = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 并发池（上限 limit；回呼自行 try/catch，永不抛出中断池）。 */
export async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers: Promise<void>[] = []
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor
          cursor += 1
          await fn(items[index])
        }
      })(),
    )
  }
  await Promise.all(workers)
}

/** 抽检量（§5.6）：30%，最少 3；不足 3 条全抽。 */
export function sampleSize(total: number): number {
  if (total <= 0) return 0
  if (total < SAMPLING_MIN) return total
  return Math.min(total, Math.max(SAMPLING_MIN, Math.ceil(total * SAMPLING_RATE)))
}

/** Fisher–Yates 洗牌取前 k（随机抽样，原地不改输入）。 */
export function shuffleSample<T>(items: T[], k: number): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  return pool.slice(0, k)
}

/** 档名安全化（docId 理论上已是 `${batch}-${slug}`，防卫性剥分隔符）。 */
export function safeFileSegment(value: string): string {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120)
}

/** 均值保留 4 位小数（报告可读；比较用四舍五入后值，触发边界与原始判据一致）。 */
export function roundAvg(sum: number, count: number): number {
  return Math.round((sum / count) * 1e4) / 1e4
}
