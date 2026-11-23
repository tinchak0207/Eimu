/**
 * 生成历史的数据层（小程序端）。
 *
 * 真源是 `GET /api/history`（游标分页），与网页版 src/lib/new-api-client.ts 的
 * `fetchHistoryPage` 同一契约；本档只镜像小程序用得到的那部分字段，避免把整个
 * 网页版 HistoryEntry（含 lineage / projectIds 等小程序不展示的栏位）搬进来。
 *
 * 与 miniapp 其它 lib 一样：只做请求与纯函数，不碰 React 状态。
 */
import { request } from './request'
import { QUOTA_PER_COIN } from './quota'

export type HistorySource = 'local' | 'server' | 'billing' | 'workflow'
export type HistoryEntryKind = 'image' | 'video' | 'audio' | 'workflow'
export type HistoryTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'unknown'

export interface HistoryResult {
  provider?: string
  modelId?: string
  image?: string | null
  imageUrl?: string | null
  endpointLabel?: string
  resultId?: string
  taskId?: string
  videoUrl?: string | null
  audioUrl?: string | null
  mediaType?: string
}

export interface HistoryWorkflowMeta {
  imageSize?: string
  workflowPresetLabel?: string
  qualityProfile?: string
  dagNodes?: unknown[]
  [key: string]: unknown
}

export interface HistoryEntry {
  id: string
  prompt: string
  /** 毫秒时间戳。 */
  generatedAt: number
  results: HistoryResult[]
  source: HistorySource
  entryKind?: HistoryEntryKind
  workflow?: HistoryWorkflowMeta
  quota?: number
  modelId?: string
  starred?: boolean
  taskId?: string
  taskStatus?: HistoryTaskStatus
  errorCode?: string
}

export interface HistoryFacetBucket {
  value: string
  label: string
  count: number
}

export interface HistoryFacets {
  models: HistoryFacetBucket[]
  imageSizes: HistoryFacetBucket[]
  starredCount: number
  withImageCount: number
  total: number
}

export interface HistoryQuery {
  keyword?: string
  modelId?: string
  imageSize?: string
  starredOnly?: boolean
  withImageOnly?: boolean
  since?: number
  until?: number
  projectId?: string
}

export interface HistoryPage {
  entries: HistoryEntry[]
  /** 下一页游标；null/空字符串表示到底。 */
  cursor: string | null
  total: number
}

export interface HistoryPageResponse {
  success: boolean
  data?: HistoryPage
  facets?: HistoryFacets
  message?: string
}

export interface HistoryStats {
  entries: number
  images: number
  quota: number
  starred: number
  firstAt: number | null
  lastAt: number | null
}

/** 与网页版 HISTORY_PAGE_SIZE 同值（src/lib/history-types.ts）。 */
export const HISTORY_PAGE_SIZE = 24

const MAX_EXPORT_ENTRIES = 1000

/** 把服务端条目收窄成 UI 能安全消费的形状（字段缺失不炸列表）。 */
function normalizeEntry(raw: HistoryEntry): HistoryEntry | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null
  const generatedAt =
    typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt)
      ? raw.generatedAt
      : Date.parse(String(raw.generatedAt)) || Date.now()
  return {
    ...raw,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    generatedAt,
    results: Array.isArray(raw.results) ? raw.results : [],
  }
}

function buildHistoryParams(
  query: HistoryQuery,
  options: { cursor?: string | null; pageSize?: number; facets?: boolean } = {},
): string {
  const params: string[] = []
  const push = (key: string, value: string) => params.push(`${key}=${encodeURIComponent(value)}`)
  if (query.keyword) push('keyword', query.keyword)
  if (query.modelId) push('modelId', query.modelId)
  if (query.imageSize) push('imageSize', query.imageSize)
  if (query.since !== undefined) push('since', String(query.since))
  if (query.until !== undefined) push('until', String(query.until))
  if (query.projectId) push('projectId', query.projectId)
  if (query.starredOnly) push('starred', '1')
  if (query.withImageOnly) push('withImage', '1')
  if (options.cursor) push('cursor', options.cursor)
  if (options.pageSize) push('pageSize', String(options.pageSize))
  if (options.facets) push('facets', '1')
  return params.join('&')
}

/** GET /api/history —— 一页记录；首屏把 facets 一起取回。 */
export async function fetchHistoryPage(
  query: HistoryQuery,
  options: { cursor?: string | null; pageSize?: number; facets?: boolean } = {},
): Promise<HistoryPageResponse> {
  const suffix = buildHistoryParams(query, options)
  const payload = await request<HistoryPageResponse>({
    path: `/api/history${suffix ? `?${suffix}` : ''}`,
  })
  if (payload?.data) {
    payload.data.entries = payload.data.entries.flatMap((item) => {
      const normalized = normalizeEntry(item)
      return normalized ? [normalized] : []
    })
  }
  return payload
}

/**
 * 导出前的全量拉取：沿 cursor 翻页直到到底或触到上限。
 * 导出必须覆盖「当前筛选结果」，不能只导出已滚到屏幕上的那几页。
 */
export async function fetchAllHistoryEntries(
  query: HistoryQuery,
  maxEntries = MAX_EXPORT_ENTRIES,
): Promise<HistoryEntry[]> {
  const collected: HistoryEntry[] = []
  const seen = new Set<string>()
  let cursor: string | null = null

  for (let page = 0; page < 20 && collected.length < maxEntries; page += 1) {
    const response = await fetchHistoryPage(query, { cursor, pageSize: 100 })
    if (!response.success || !response.data) {
      if (!collected.length) throw new Error(response.message || '导出数据加载失败')
      break
    }
    for (const entry of response.data.entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      collected.push(entry)
    }
    cursor = response.data.cursor
    if (!cursor) break
  }

  return collected.slice(0, maxEntries)
}

/** PATCH /api/history/{id} —— 收藏开关（body 字段名以服务端 route 为准：starred）。 */
export async function patchHistoryStar(
  id: string,
  starred: boolean,
): Promise<{ success: boolean; message?: string }> {
  return request<{ success: boolean; message?: string }>({
    path: `/api/history/${encodeURIComponent(id)}`,
    method: 'PATCH',
    data: { starred },
  })
}

/**
 * DELETE /api/history —— 批量删除。
 * 服务端一次最多接受 200 条（超出会被静默切片），这里按 200 分批发，
 * 保证「全选后删除」不会只删掉前 200 条却回报成功。
 */
export async function deleteHistoryEntries(
  ids: string[],
): Promise<{ success: boolean; removed?: number; message?: string }> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && Boolean(id)))]
  if (!unique.length) return { success: false, removed: 0, message: '没有指定要删除的记录。' }

  let removed = 0
  for (let index = 0; index < unique.length; index += 200) {
    const response = await request<{ success: boolean; removed?: number; message?: string }>({
      path: '/api/history',
      method: 'DELETE',
      data: { ids: unique.slice(index, index + 200) },
    })
    if (!response?.success) {
      return { success: false, removed, message: response?.message || '删除失败' }
    }
    removed += response.removed ?? 0
  }
  return { success: true, removed }
}

// ─────────────────────────────────────────────────────────── 纯函数（镜像网页版 history-types）

/** 一条记录的主模型。 */
export function primaryModelId(entry: HistoryEntry): string {
  return entry.modelId ?? entry.results[0]?.modelId ?? ''
}

/** 模型展示名：去掉 provider 前缀，与网页版 formatModelLabel 同义。 */
export function formatModelLabel(modelId: string): string {
  const segments = String(modelId ?? '').split('/')
  return segments[segments.length - 1] || modelId
}

/** 记录类型推断（优先级逐条对应网页版 inferEntryKind）。 */
export function inferEntryKind(entry: HistoryEntry): HistoryEntryKind {
  if (entry.entryKind === 'image' || entry.entryKind === 'video' || entry.entryKind === 'audio' || entry.entryKind === 'workflow') {
    return entry.entryKind
  }
  if (entry.source === 'workflow') return 'workflow'
  if (Array.isArray(entry.workflow?.dagNodes) && entry.workflow.dagNodes.length > 0) return 'workflow'
  for (const result of entry.results) {
    if (result.videoUrl) return 'video'
  }
  for (const result of entry.results) {
    if (result.audioUrl) return 'audio'
  }
  return 'image'
}

/** 是否有可展示媒体（图/视频/音频）。 */
export function hasMedia(entry: HistoryEntry): boolean {
  return entry.results.some((result) => Boolean(result.image || result.imageUrl || result.videoUrl || result.audioUrl))
}

export interface MediaView {
  url: string
  kind: 'image' | 'video' | 'audio'
}

/**
 * 卡片媒体地址：取第一个带媒体的结果。
 * 顺序与网页版 entrySrc 一致：内嵌 base64 图 → imageUrl → videoUrl → audioUrl。
 */
export function mediaOf(entry: HistoryEntry): MediaView | null {
  const result = entry.results.find(
    (item) => item.image || item.imageUrl || item.videoUrl || item.audioUrl,
  )
  if (!result) return null
  if (result.image) return { url: `data:image/png;base64,${result.image}`, kind: 'image' }
  if (result.imageUrl) return { url: result.imageUrl, kind: 'image' }
  if (result.videoUrl) return { url: result.videoUrl, kind: 'video' }
  if (result.audioUrl) return { url: result.audioUrl, kind: 'audio' }
  return null
}

export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/** 绝对时间文案，供导出使用（与网页版同一格式）。 */
export function formatAbsoluteTime(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 与网页版 formatCoins 同一套换算与小数规则。 */
export function formatCoins(quota: number | undefined | null): string {
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) return '0'
  const coins = quota / QUOTA_PER_COIN
  if (coins < 1) return coins.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return Number.isInteger(coins) ? String(coins) : coins.toFixed(1)
}

export function buildHistoryStats(entries: HistoryEntry[]): HistoryStats {
  let images = 0
  let quota = 0
  let starred = 0
  let firstAt: number | null = null
  let lastAt: number | null = null

  for (const entry of entries) {
    images += entry.results.filter((result) => result.image || result.imageUrl).length
    quota += entry.quota ?? 0
    if (entry.starred) starred += 1
    if (firstAt === null || entry.generatedAt < firstAt) firstAt = entry.generatedAt
    if (lastAt === null || entry.generatedAt > lastAt) lastAt = entry.generatedAt
  }

  return { entries: entries.length, images, quota, starred, firstAt, lastAt }
}

// ─────────────────────────────────────────────────────────── 按天分组

export type HistoryDayBucket = 'today' | 'yesterday' | 'week' | 'earlier'

export interface HistoryGroup {
  bucket: HistoryDayBucket
  label: string
  entries: HistoryEntry[]
}

/** 与 src/lib/history-types.ts 同一组分组标题。 */
const DAY_BUCKET_LABELS: Record<HistoryDayBucket, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 按「今天 / 昨天 / 本周 / 更早」分组（本地时区自然日边界）。
 * 逐行对应网页版 groupHistoryByDay，并就地按 generatedAt 倒序。
 */
export function groupHistoryByDay(entries: HistoryEntry[], now: number = Date.now()): HistoryGroup[] {
  const todayStart = startOfLocalDay(now)
  const yesterdayStart = startOfLocalDay(todayStart - 1)
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000

  const order: HistoryDayBucket[] = ['today', 'yesterday', 'week', 'earlier']
  const grouped = new Map<HistoryDayBucket, HistoryEntry[]>()

  for (const entry of [...entries].sort((a, b) => b.generatedAt - a.generatedAt)) {
    let bucket: HistoryDayBucket
    if (entry.generatedAt >= todayStart) bucket = 'today'
    else if (entry.generatedAt >= yesterdayStart) bucket = 'yesterday'
    else if (entry.generatedAt >= weekStart) bucket = 'week'
    else bucket = 'earlier'

    const list = grouped.get(bucket)
    if (list) list.push(entry)
    else grouped.set(bucket, [entry])
  }

  return order
    .filter((bucket) => grouped.has(bucket))
    .map((bucket) => ({
      bucket,
      label: DAY_BUCKET_LABELS[bucket],
      entries: grouped.get(bucket) as HistoryEntry[],
    }))
}

// ─────────────────────────────────────────────────────────── 导出

interface HistoryArchiveRecord {
  id: string
  prompt: string
  generatedAt: string
  model: string
  imageSize?: string
  preset?: string
  qualityProfile?: string
  starred: boolean
  coins?: string
  imageUrls: string[]
  workflow?: HistoryWorkflowMeta
}

/** 完整档案结构（与网页版 buildHistoryArchive 同形）。 */
export function buildHistoryArchive(entries: HistoryEntry[]): {
  exportedAt: string
  count: number
  records: HistoryArchiveRecord[]
} {
  return {
    exportedAt: new Date().toISOString(),
    count: entries.length,
    records: entries.map((entry) => ({
      id: entry.id,
      prompt: entry.prompt,
      generatedAt: new Date(entry.generatedAt).toISOString(),
      model: primaryModelId(entry),
      ...(entry.workflow?.imageSize ? { imageSize: entry.workflow.imageSize } : {}),
      ...(entry.workflow?.workflowPresetLabel ? { preset: entry.workflow.workflowPresetLabel } : {}),
      ...(entry.workflow?.qualityProfile ? { qualityProfile: entry.workflow.qualityProfile } : {}),
      starred: Boolean(entry.starred),
      ...(entry.quota !== undefined ? { coins: formatCoins(entry.quota) } : {}),
      imageUrls: entry.results
        .map((result) => result.imageUrl)
        .filter((url): url is string => Boolean(url)),
      ...(entry.workflow ? { workflow: entry.workflow } : {}),
    })),
  }
}

/** CSV 单元转义（与网页版 csvCell 同一规则）。 */
export function csvCell(value: string | number | boolean | undefined): string {
  const text = value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV（含 BOM，Excel 读中文不乱码）。 */
export function buildHistoryCsv(entries: HistoryEntry[]): string {
  const header = ['生成时间', '提示词', '模型', '尺寸', '预设', '消耗', '已收藏', '图片链接']
  const rows = entries.map((entry) =>
    [
      csvCell(formatAbsoluteTime(entry.generatedAt)),
      csvCell(entry.prompt),
      csvCell(primaryModelId(entry)),
      csvCell(entry.workflow?.imageSize),
      csvCell(entry.workflow?.workflowPresetLabel),
      csvCell(entry.quota !== undefined ? formatCoins(entry.quota) : ''),
      csvCell(entry.starred ? '是' : '否'),
      csvCell(entry.results.map((result) => result.imageUrl).filter(Boolean).join(' ')),
    ].join(','),
  )
  return `\ufeff${[header.join(','), ...rows].join('\r\n')}`
}
