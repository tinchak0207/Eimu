import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Input, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { request } from '../../lib/request'
import { ensureLogin } from '../../lib/session'
import {
  canRerunTask,
  rerunFromTask,
  type GenerationTask,
  type GenerationTaskStatus,
} from '../../lib/generation'
import {
  buildHistoryArchive,
  buildHistoryCsv,
  buildHistoryStats,
  deleteHistoryEntries,
  fetchAllHistoryEntries,
  fetchHistoryPage,
  formatModelLabel,
  groupHistoryByDay,
  inferEntryKind,
  mediaOf,
  patchHistoryStar,
  HISTORY_PAGE_SIZE,
  type HistoryEntry,
  type HistoryEntryKind,
  type HistoryFacets,
  type HistoryQuery,
} from '../../lib/history'
import { PageShell } from '../../components/pages/PageShell'
import { PageBoundary } from '../../components/pages/PageBoundary'
import { Icon, type IconName } from '../../components/agent-chat/icons'
import './index.scss'

/** 与 app.config.ts 登记的路由保持一致（另一个 agent 负责登记）。 */
const DETAIL_ROUTE = '/pages/detail/index/index'
const POLL_INTERVAL_MS = 5_000
/** 进行中任务合成的临时卡片 id 前缀；它们没有服务端历史 id，不能收藏/删除。 */
const SYNTHETIC_PREFIX = 'job-'

type KindFilter = 'all' | HistoryEntryKind

interface TaskListResponse {
  success?: boolean
  enabled?: boolean
  data?: GenerationTask[]
  message?: string
}

const KIND_LABELS: Record<HistoryEntryKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音乐',
  workflow: '工作流',
}

function statusLabel(status: GenerationTaskStatus | undefined): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '生成中'
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '生成失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'refunded') return '已退款'
  return '状态未知'
}

function isLiveStatus(status: GenerationTaskStatus | undefined): boolean {
  return status === 'queued' || status === 'running'
}

function failedLabel(status: GenerationTaskStatus | undefined): string | null {
  if (status === 'failed') return '生成失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'refunded') return '已退款'
  return null
}

/** 进行中的 job 合成一条卡片记录（/api/history 尚未投影出来时的兜底）。 */
function syntheticEntryFromTask(task: GenerationTask): HistoryEntry {
  return {
    id: `${SYNTHETIC_PREFIX}${task.taskId}`,
    prompt: task.prompt ?? '',
    generatedAt: Date.parse(task.createdAt) || Date.now(),
    results: [],
    source: 'server',
    modelId: task.submittedConfig?.modelId || task.modelId,
    taskId: task.taskId,
    taskStatus: task.status,
  }
}

/** job 的最新结果覆盖到历史条目（历史条目可能还没有产物地址）。 */
function mergeTaskResults(entry: HistoryEntry, task: GenerationTask): HistoryEntry {
  const results = entry.results.length
    ? entry.results
    : task.results
        .filter((result) => Boolean(result.url))
        .map((result) => {
          const mime = result.mimeType || ''
          return {
            provider: '',
            modelId: task.modelId,
            image: null,
            imageUrl: mime.startsWith('video/') || mime.startsWith('audio/') ? null : result.url,
            videoUrl: mime.startsWith('video/') ? result.url : null,
            audioUrl: mime.startsWith('audio/') ? result.url : null,
            mediaType: mime.startsWith('video/')
              ? ('video' as const)
              : mime.startsWith('audio/')
                ? ('audio' as const)
                : ('image' as const),
            resultId: result.resultId,
            taskId: result.taskId,
          }
        })

  return {
    ...entry,
    prompt: entry.prompt || task.prompt || '',
    results,
    taskStatus: task.status,
  }
}

function writeExportFile(fileName: string, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const fs = Taro.getFileSystemManager()
      const filePath = `${Taro.env.USER_DATA_PATH}/${fileName}`
      fs.writeFile({
        filePath,
        data: content,
        encoding: 'utf8',
        success: () => resolve(filePath),
        fail: (error) => reject(new Error(error?.errMsg || '写入导出文件失败')),
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error('文件系统不可用，无法导出'))
    }
  })
}

/**
 * 生成历史（网页版全功能）。
 *
 * 结构逐行对应网页版：
 *   src/components/HistoryClient.tsx                页头 / 筛选 / 网格 / 空态 / 多选
 *   src/components/history/HistoryFilterBar.tsx     搜索、收藏、类型、有图、分面抽屉、导出
 *   src/components/history/HistoryGrid.tsx          按天分组 + 无限滚动
 *   src/components/history/HistoryCard.tsx          媒体态 / 收藏 / 操作条 / 勾选圈
 *   src/components/history/HistoryEmptyState.tsx    空态
 *
 * 数据真源是 `GET /api/history`（游标分页、收藏、批量删除都走它），
 * `/api/generation-jobs` 只用来把进行中任务的最新状态合并进卡片。
 */
export default function WorksPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [facets, setFacets] = useState<HistoryFacets | null>(null)
  const [filters, setFilters] = useState<HistoryQuery>({})
  const [keyword, setKeyword] = useState('')
  const [kind, setKind] = useState<KindFilter>('all')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [tasks, setTasks] = useState<Record<string, GenerationTask>>({})
  const [failedIds, setFailedIds] = useState<Record<string, boolean>>({})
  const [busyEntryId, setBusyEntryId] = useState('')
  const [exporting, setExporting] = useState<'' | 'json' | 'csv'>('')
  const [scrollTop, setScrollTop] = useState(0)
  const [navHeight, setNavHeight] = useState(80)

  const aliveRef = useRef(true)
  const requestSeqRef = useRef(0)
  const filtersRef = useRef<HistoryQuery>(filters)
  const loadingMoreRef = useRef(false)
  const exportingRef = useRef(false)
  const hasLoadedRef = useRef(false)
  const skipFilterEffectRef = useRef(true)
  const inProgressIdsRef = useRef<Set<string>>(new Set())

  filtersRef.current = filters

  useEffect(() => {
    aliveRef.current = true
    try {
      const info = Taro.getWindowInfo ? Taro.getWindowInfo() : Taro.getSystemInfoSync()
      setNavHeight(Number(info.statusBarHeight ?? 20) + 60)
    } catch {
      // 取不到就沿用 80px 兜底（20 状态栏 + 60 导航）。
    }
    return () => {
      aliveRef.current = false
    }
  }, [])

  const resetScroll = useCallback(() => {
    // 同一个值不会触发重新滚动，所以用 0 / 0.01 交替把视口拉回顶部。
    setScrollTop((prev) => (prev === 0 ? 0.01 : 0))
  }, [])

  /** 首屏 / 筛选变化：重置分页并重新拉第一页（facets 只在首屏要）。 */
  const loadFirstPage = useCallback(async (target: HistoryQuery, options: { silent?: boolean } = {}) => {
    const seq = requestSeqRef.current + 1
    requestSeqRef.current = seq
    if (!options.silent) setLoading(true)
    setError('')
    try {
      await ensureLogin()
      const response = await fetchHistoryPage(target, { pageSize: HISTORY_PAGE_SIZE, facets: true })
      if (!aliveRef.current || seq !== requestSeqRef.current) return
      if (!response.success || !response.data) {
        throw new Error(response.message || '获取生成历史失败')
      }
      setEntries(response.data.entries)
      setCursor(response.data.cursor || null)
      setTotal(response.data.total ?? response.data.entries.length)
      if (response.facets) setFacets(response.facets)
      hasLoadedRef.current = true
      setError('')
    } catch (err) {
      if (!aliveRef.current || seq !== requestSeqRef.current) return
      setError(err instanceof Error ? err.message : '获取生成历史失败')
    } finally {
      if (aliveRef.current && seq === requestSeqRef.current && !options.silent) setLoading(false)
    }
  }, [])

  /** 下一页：cursor 原样带回；cursor 为空即到底。 */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || loading) return
    if (!cursor) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    const seq = requestSeqRef.current
    try {
      const response = await fetchHistoryPage(filtersRef.current, {
        cursor,
        pageSize: HISTORY_PAGE_SIZE,
      })
      if (!aliveRef.current || seq !== requestSeqRef.current) return
      if (!response.success || !response.data) {
        throw new Error(response.message || '加载更多失败')
      }
      setEntries((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        return [...prev, ...response.data!.entries.filter((item) => !seen.has(item.id))]
      })
      setCursor(response.data.cursor || null)
      setTotal(response.data.total ?? total)
      setError('')
    } catch (err) {
      if (!aliveRef.current || seq !== requestSeqRef.current) return
      setError(err instanceof Error ? err.message : '加载更多失败')
    } finally {
      loadingMoreRef.current = false
      if (aliveRef.current) setLoadingMore(false)
    }
  }, [cursor, loading, total])

  /** /api/generation-jobs 只用于刷新进行中任务状态（失败即降级，不挡历史）。 */
  const loadJobs = useCallback(async () => {
    try {
      await ensureLogin()
      const payload = await request<TaskListResponse>({ path: '/api/generation-jobs?limit=50' })
      if (!aliveRef.current || !payload?.success) return
      const list = Array.isArray(payload.data) ? payload.data : []
      const next: Record<string, GenerationTask> = {}
      for (const task of list) next[task.taskId] = task
      setTasks(next)
    } catch {
      // fail-soft：历史页不因为任务接口抖动而报错。
    }
  }, [])

  const refreshAll = useCallback(
    async (options: { silent?: boolean } = {}) => {
      await loadFirstPage(filtersRef.current, options)
    },
    [loadFirstPage],
  )

  useDidShow(() => {
    const silent = hasLoadedRef.current
    setSelectionMode(false)
    setSelectedIds(new Set())
    void refreshAll({ silent })
    void loadJobs()
  })

  usePullDownRefresh(async () => {
    await refreshAll({ silent: true })
    Taro.stopPullDownRefresh()
  })

  // 筛选变化：重新拉第一页。首次挂载由 useDidShow 负责，避免重复请求。
  useEffect(() => {
    if (skipFilterEffectRef.current) {
      skipFilterEffectRef.current = false
      return
    }
    setSelectionMode(false)
    setSelectedIds(new Set())
    resetScroll()
    void loadFirstPage(filters)
  }, [filters, loadFirstPage, resetScroll])

  // 搜索输入防抖（HistoryFilterBar.tsx:78-86 的 320ms）。
  useEffect(() => {
    const timer = setTimeout(() => {
      const nextKeyword = keyword.trim() || undefined
      setFilters((prev) => {
        if ((prev.keyword ?? undefined) === nextKeyword) return prev
        return { ...prev, keyword: nextKeyword }
      })
    }, 320)
    return () => clearTimeout(timer)
  }, [keyword])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await refreshAll({ silent: true })
    setRefreshing(false)
    Taro.stopPullDownRefresh()
  }, [refreshAll])

  // 进行中任务轮询：/api/generation-jobs 的最新状态合并进卡片。
  // 有任务落地时静默重拉第一页，让新记录从历史里出现。
  useEffect(() => {
    const current = new Set(
      Object.values(tasks)
        .filter((task) => isLiveStatus(task.status))
        .map((task) => task.taskId),
    )
    const settled = [...inProgressIdsRef.current].filter((id) => !current.has(id))
    inProgressIdsRef.current = current
    if (settled.length > 0) {
      void loadFirstPage(filtersRef.current, { silent: true })
    }
  }, [tasks, loadFirstPage])

  const hasInProgressJobs = useMemo(
    () => Object.values(tasks).some((task) => isLiveStatus(task.status)),
    [tasks],
  )

  useEffect(() => {
    if (!hasInProgressJobs) return
    const timer = setInterval(() => {
      void loadJobs()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasInProgressJobs, loadJobs])

  /** 历史条目 + 进行中任务合并后的展示列表。 */
  const displayEntries = useMemo(() => {
    const merged = entries.map((entry) => {
      const task = entry.taskId ? tasks[entry.taskId] : undefined
      return task ? mergeTaskResults(entry, task) : entry
    })
    const presentTaskIds = new Set(merged.map((entry) => entry.taskId).filter(Boolean) as string[])
    const synthetic = Object.values(tasks)
      .filter((task) => isLiveStatus(task.status) && !presentTaskIds.has(task.taskId))
      .map(syntheticEntryFromTask)
    return [...synthetic, ...merged].sort((a, b) => b.generatedAt - a.generatedAt)
  }, [entries, tasks])

  /** 类型胶囊在本地过滤（/api/history 契约没有 entryKind 查询参数，网页版同样在 Grid 里过一遍）。 */
  const visibleEntries = useMemo(
    () => (kind === 'all' ? displayEntries : displayEntries.filter((entry) => inferEntryKind(entry) === kind)),
    [displayEntries, kind],
  )

  const groups = useMemo(() => groupHistoryByDay(visibleEntries), [visibleEntries])
  const stats = useMemo(() => buildHistoryStats(displayEntries), [displayEntries])

  const hasFilters = Boolean(
    filters.keyword ||
      filters.modelId ||
      filters.imageSize ||
      filters.starredOnly ||
      filters.withImageOnly ||
      kind !== 'all',
  )
  const activeFilterCount =
    (filters.modelId ? 1 : 0) +
    (filters.imageSize ? 1 : 0) +
    (filters.starredOnly ? 1 : 0) +
    (filters.withImageOnly ? 1 : 0) +
    (kind !== 'all' ? 1 : 0)
  const showSkeleton = loading && entries.length === 0

  const selectableIds = useMemo(
    () => visibleEntries.filter((entry) => !entry.id.startsWith(SYNTHETIC_PREFIX)).map((entry) => entry.id),
    [visibleEntries],
  )
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id))

  function clearFilters() {
    setKeyword('')
    setKind('all')
    setFilters({})
  }

  function goHome() {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack({ fail: () => void Taro.reLaunch({ url: '/pages/index/index' }) })
      return
    }
    void Taro.reLaunch({ url: '/pages/index/index' })
  }

  function enterSelection(id: string) {
    if (id.startsWith(SYNTHETIC_PREFIX)) return
    setSelectionMode(true)
    setSelectedIds(new Set([id]))
  }

  function exitSelection() {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }

  function toggleSelect(id: string) {
    if (id.startsWith(SYNTHETIC_PREFIX)) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(selectableIds))
  }

  function activateEntry(entry: HistoryEntry) {
    if (selectionMode) {
      toggleSelect(entry.id)
      return
    }
    const status = (entry.taskId ? tasks[entry.taskId]?.status : undefined) ?? entry.taskStatus
    if (isLiveStatus(status)) return
    if (entry.taskId) {
      void Taro.navigateTo({ url: `${DETAIL_ROUTE}?id=${encodeURIComponent(entry.taskId)}` })
      return
    }
    const media = mediaOf(entry)
    if (media?.kind === 'image') {
      void Taro.previewImage({ urls: [media.url], current: media.url })
      return
    }
    void Taro.showToast({ title: '这条记录没有可打开的详情', icon: 'none' })
  }

  /** 收藏：乐观更新 + 失败回滚（HistoryClient.tsx:460 的 toggleStar 同一语义）。 */
  async function toggleStar(entry: HistoryEntry) {
    if (entry.id.startsWith(SYNTHETIC_PREFIX)) return
    const next = !entry.starred
    setEntries((prev) => prev.map((item) => (item.id === entry.id ? { ...item, starred: next } : item)))
    setFacets((prev) =>
      prev ? { ...prev, starredCount: Math.max(0, prev.starredCount + (next ? 1 : -1)) } : prev,
    )
    try {
      const response = await patchHistoryStar(entry.id, next)
      if (!response?.success) throw new Error(response?.message || '收藏失败')
    } catch (err) {
      setEntries((prev) => prev.map((item) => (item.id === entry.id ? { ...item, starred: !next } : item)))
      setFacets((prev) =>
        prev ? { ...prev, starredCount: Math.max(0, prev.starredCount + (next ? -1 : 1)) } : prev,
      )
      void Taro.showToast({ title: err instanceof Error ? err.message : '收藏失败', icon: 'none' })
    }
  }

  async function handleSave(entry: HistoryEntry) {
    if (busyEntryId) return
    const media = mediaOf(entry)
    if (!media) {
      void Taro.showToast({ title: '这条记录没有可保存的文件', icon: 'none' })
      return
    }
    if (media.url.startsWith('data:')) {
      void Taro.showToast({ title: '内嵌图片暂不支持保存', icon: 'none' })
      return
    }
    setBusyEntryId(entry.id)
    try {
      const download = await Taro.downloadFile({ url: media.url })
      if (download.statusCode !== 200) {
        throw new Error(`文件下载失败（${download.statusCode}）`)
      }
      if (media.kind === 'video') {
        await Taro.saveVideoToPhotosAlbum({ filePath: download.tempFilePath })
        void Taro.showToast({ title: '已保存到相册', icon: 'success' })
      } else if (media.kind === 'audio') {
        await Taro.shareFileMessage({
          filePath: download.tempFilePath,
          fileName: `${entry.prompt.trim().slice(0, 20) || 'eimu-audio'}.mp3`,
        })
      } else {
        await Taro.saveImageToPhotosAlbum({ filePath: download.tempFilePath })
        void Taro.showToast({ title: '已保存到相册', icon: 'success' })
      }
    } catch (err) {
      const detail = err as { errMsg?: string; message?: string } | null
      const message = detail?.errMsg || detail?.message || '保存失败，请稍后重试'
      if (/auth\s*deni|authorize|权限/i.test(message)) {
        void Taro.showModal({
          title: '需要相册权限',
          content: '请在右上角「…」→ 设置中打开「保存到相册」权限后重试。',
          showCancel: false,
        })
      } else {
        void Taro.showModal({ title: '保存失败', content: message, showCancel: false })
      }
    } finally {
      setBusyEntryId('')
    }
  }

  async function handleRerun(entry: HistoryEntry) {
    const task = entry.taskId ? tasks[entry.taskId] : undefined
    if (!task || busyEntryId) return
    setBusyEntryId(entry.id)
    try {
      await rerunFromTask(task)
      void Taro.showToast({ title: '已重新提交，稍候刷新查看', icon: 'none' })
      await loadFirstPage(filtersRef.current, { silent: true })
    } catch (err) {
      void Taro.showToast({
        title: err instanceof Error ? err.message : '重跑失败',
        icon: 'none',
      })
    } finally {
      setBusyEntryId('')
    }
  }

  /** 删除选中：Taro.showModal 二次确认 → DELETE /api/history { ids } → 重拉第一页回滚游标。 */
  async function handleDeleteSelected() {
    const ids = [...selectedIds].filter((id) => !id.startsWith(SYNTHETIC_PREFIX))
    if (!ids.length) {
      void Taro.showToast({ title: '进行中的任务不能删除', icon: 'none' })
      return
    }
    const confirm = await Taro.showModal({
      title: '删除记录',
      content: `确定删除选中的 ${ids.length} 条记录？删除后无法恢复。`,
      confirmText: '删除',
      confirmColor: '#FF3B30',
    })
    if (!confirm.confirm) return

    Taro.showLoading({ title: '正在删除…', mask: true })
    try {
      const response = await deleteHistoryEntries(ids)
      if (!response?.success) throw new Error(response?.message || '删除失败')
      Taro.hideLoading()
      exitSelection()
      // 删除会改变游标位置；重新拉第一页最稳（需求原文）。
      resetScroll()
      await loadFirstPage(filtersRef.current, { silent: true })
      void Taro.showToast({ title: `已删除 ${response.removed ?? ids.length} 条`, icon: 'none' })
    } catch (err) {
      Taro.hideLoading()
      await Taro.showModal({
        title: '删除失败',
        content: err instanceof Error ? err.message : '删除失败，请稍后重试',
        showCancel: false,
      })
    }
  }

  /** 导出：沿 cursor 拉全量筛选结果 → writeFile → shareFileMessage（不支持则可见降级）。 */
  async function handleExport(format: 'json' | 'csv') {
    if (exportingRef.current) return
    exportingRef.current = true
    setExporting(format)
    setNotice('')
    Taro.showLoading({ title: '正在导出…', mask: true })
    try {
      const all = await fetchAllHistoryEntries(filtersRef.current)
      if (!all.length) {
        Taro.hideLoading()
        void Taro.showToast({ title: '当前筛选没有可导出的记录', icon: 'none' })
        return
      }
      const content = format === 'json'
        ? JSON.stringify(buildHistoryArchive(all), null, 2)
        : buildHistoryCsv(all)
      const stamp = new Date().toISOString().slice(0, 10)
      const fileName = `eimu-history-${stamp}.${format}`
      const filePath = await writeExportFile(fileName, content)
      Taro.hideLoading()

      try {
        await Taro.shareFileMessage({ filePath, fileName })
        void Taro.showToast({ title: `已导出 ${all.length} 条`, icon: 'none' })
      } catch {
        // 开发者工具 / 旧基础库不支持文件分享：把内容复制到剪贴板，给可见提示。
        if (content.length <= 60_000) {
          try {
            await Taro.setClipboardData({ data: content })
            await Taro.showModal({
              title: '导出文件已生成',
              content: `当前环境不支持文件分享，${all.length} 条记录已复制到剪贴板（${fileName}）。`,
              showCancel: false,
            })
            return
          } catch {
            // 落到下面的路径提示。
          }
        }
        setNotice(`导出文件已写入：${filePath}`)
        await Taro.showModal({
          title: '导出文件已生成',
          content: `当前环境不支持分享该格式，文件已写入沙箱：${filePath}`,
          showCancel: false,
        })
      }
    } catch (err) {
      Taro.hideLoading()
      await Taro.showModal({
        title: '导出失败',
        content: err instanceof Error ? err.message : '导出失败，请稍后重试',
        showCancel: false,
      })
    } finally {
      exportingRef.current = false
      setExporting('')
    }
  }

  function markImageFailed(id: string) {
    setFailedIds((prev) => ({ ...prev, [id]: true }))
  }

  function placeholderText(entry: HistoryEntry, imageFailed: boolean, kind: HistoryEntryKind): string {
    const status = (entry.taskId ? tasks[entry.taskId]?.status : undefined) ?? entry.taskStatus
    const failure = failedLabel(status)
    if (imageFailed) return '图片已失效'
    if (failure) return failure
    if (kind === 'video') return '视频作品'
    if (kind === 'audio') return '音乐作品'
    if (kind === 'workflow') return '工作流记录'
    return '没有留存图片'
  }

  function cardIcon(entry: HistoryEntry, imageFailed: boolean, kind: HistoryEntryKind): IconName {
    const status = (entry.taskId ? tasks[entry.taskId]?.status : undefined) ?? entry.taskStatus
    if (imageFailed) return 'alert-triangle-red'
    if (failedLabel(status)) return 'alert-circle-a44'
    if (kind === 'video') return 'clapperboard-a40'
    if (kind === 'audio') return 'music-a40'
    if (kind === 'workflow') return 'folder-kanban-a45'
    return 'image-a40'
  }

  function renderCard(entry: HistoryEntry) {
    const task = entry.taskId ? tasks[entry.taskId] : undefined
    const status = task?.status ?? entry.taskStatus
    const inProgress = isLiveStatus(status)
    const media = mediaOf(entry)
    const kind = inferEntryKind(entry)
    const imageFailed = Boolean(failedIds[entry.id])
    const selected = selectedIds.has(entry.id)
    const rerunnable = Boolean(task && canRerunTask(task))
    const showImage = !inProgress && media?.kind === 'image' && !imageFailed
    const synthetic = entry.id.startsWith(SYNTHETIC_PREFIX)

    return (
      <View
        key={entry.id}
        className={`hist-card hist-masonry-item ${selected ? 'is-selected' : ''}`}
        onClick={() => activateEntry(entry)}
        onLongPress={() => enterSelection(entry.id)}
      >
        {inProgress ? (
          <View className='relative w-full overflow-hidden' style={{ paddingTop: '75%' }}>
            <View className='hist-skeleton absolute inset-0' />
            <View className='absolute inset-0 flex flex-col items-center justify-center gap-2'>
              <Icon name='loader-2-blue' className='ic-spin h-5 w-5' />
              <Text className='text-ios-caption1 text-[rgba(0,0,0,0.58)]'>{statusLabel(status)}</Text>
            </View>
          </View>
        ) : showImage && media ? (
          <View className='hist-card-media'>
            <Image
              className='block w-full'
              src={media.url}
              mode='widthFix'
              lazyLoad
              onError={() => markImageFailed(entry.id)}
            />
          </View>
        ) : (
          <View className='relative w-full' style={{ paddingTop: '75%' }}>
            <View className='absolute inset-0 flex flex-col items-center justify-center gap-2 border-b border-dashed border-[rgba(0,0,0,0.08)] bg-[rgba(0,0,0,0.015)]'>
              <Icon name={cardIcon(entry, imageFailed, kind)} className='h-5 w-5' />
              <Text className='text-ios-caption1 text-[rgba(0,0,0,0.58)]'>
                {placeholderText(entry, imageFailed, kind)}
              </Text>
            </View>
          </View>
        )}

        {/* 多选勾选圈（HistoryCard.tsx:311-331）：长按或「多选」后出现在左上角。 */}
        {selectionMode && !synthetic ? (
          <View
            className={`absolute left-3 top-3 z-20 flex h-6 w-6 items-center justify-center rounded-full ${
              selected
                ? 'bg-[#007AFF] text-white shadow-[0_4px_12px_rgba(0,122,255,0.32)]'
                : 'bg-[rgba(255,255,255,0.78)] text-transparent'
            }`}
          >
            <Text style={{ fontSize: '14px', lineHeight: '14px', fontWeight: 700 }}>✓</Text>
          </View>
        ) : null}

        {/* 操作条（HistoryCard.tsx:353-421）：收藏恒在最右列，触摸设备常驻。 */}
        {!inProgress && !selectionMode ? (
          <View className='hist-card-actions absolute right-3 top-3 z-20 flex gap-1.5'>
            <View
              className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.72)] shadow-[0_2px_10px_rgba(0,0,0,0.10)]'
              onClick={(event) => {
                event.stopPropagation()
                void toggleStar(entry)
              }}
            >
              <Text
                className={entry.starred ? 'text-[#FFB300]' : 'text-[rgba(0,0,0,0.55)]'}
                style={{ fontSize: '17px', lineHeight: '17px' }}
              >
                {entry.starred ? '★' : '☆'}
              </Text>
            </View>
            {media ? (
              <View
                className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.72)] text-[rgba(0,0,0,0.55)] shadow-[0_2px_10px_rgba(0,0,0,0.10)]'
                onClick={(event) => {
                  event.stopPropagation()
                  void handleSave(entry)
                }}
              >
                <Icon
                  name='loader-2-a60'
                  className={`h-3.5 w-3.5 ${busyEntryId === entry.id ? 'ic-spin' : 'hidden'}`}
                />
                <Icon
                  name='download-a45'
                  className={`h-3.5 w-3.5 ${busyEntryId === entry.id ? 'hidden' : ''}`}
                />
              </View>
            ) : null}
            {rerunnable ? (
              <View
                className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.72)] text-[rgba(0,0,0,0.55)] shadow-[0_2px_10px_rgba(0,0,0,0.10)]'
                onClick={(event) => {
                  event.stopPropagation()
                  void handleRerun(entry)
                }}
              >
                <Icon name='rerun-a55' className='h-3.5 w-3.5' />
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 类型徽章（HistoryCard.tsx:333-350）：右下角，图片记录不挂。 */}
        {!inProgress && kind !== 'image' ? (
          <View className='lg-float pointer-events-none absolute bottom-3 right-3 z-10 inline-flex items-center gap-1 rounded-full px-2 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)]'>
            <Icon
              name={kind === 'video' ? 'clapperboard-a40' : kind === 'audio' ? 'music-a40' : 'folder-kanban-a45'}
              className='h-3 w-3'
            />
            <Text>{KIND_LABELS[kind]}</Text>
          </View>
        ) : null}
      </View>
    )
  }

  const countLabel = hasFilters
    ? `筛选出 ${visibleEntries.length} 条`
    : total > 0
      ? `共 ${total} 条`
      : ''

  return (
    <PageBoundary>
      <PageShell>
        <View className='flex flex-col' style={{ height: `calc(100vh - ${navHeight}px)` }}>
          <View className='shrink-0 px-4 pt-4'>
            {/* 页头（HistoryClient.tsx:518-557）：多选态由「取消 / 已选 N / 全选 / 删除」接管。 */}
            {selectionMode ? (
              <View className='mb-4 flex items-center justify-between gap-3'>
                <Text
                  className='shrink-0 text-ios-footnote font-medium text-[#007AFF]'
                  onClick={exitSelection}
                >
                  取消
                </Text>
                <Text className='min-w-0 flex-1 text-center text-ios-body font-semibold text-[rgba(0,0,0,0.85)]'>
                  已选 {selectedIds.size} 条
                </Text>
                <View className='flex shrink-0 items-center gap-3'>
                  <Text
                    className='text-ios-footnote font-medium text-[rgba(0,0,0,0.62)]'
                    onClick={toggleSelectAll}
                  >
                    {allSelected ? '取消全选' : '全选'}
                  </Text>
                  <Text
                    className={`text-ios-footnote font-semibold ${
                      selectedIds.size > 0 ? 'text-[#FF3B30]' : 'text-[rgba(0,0,0,0.30)]'
                    }`}
                    onClick={() => void handleDeleteSelected()}
                  >
                    删除
                  </Text>
                </View>
              </View>
            ) : (
              <View className='mb-4 flex items-center justify-between gap-3'>
                <View
                  className='inline-flex shrink-0 items-center gap-1.5 text-ios-body font-semibold text-[rgba(0,0,0,0.85)]'
                  onClick={goHome}
                >
                  <Icon name='arrow-left-a85' className='h-4 w-4' />
                  <Text>生成历史</Text>
                </View>
                <View className='flex items-center gap-3'>
                  {countLabel ? (
                    <Text className='text-ios-footnote tabular-nums text-[rgba(0,0,0,0.58)]'>{countLabel}</Text>
                  ) : null}
                  {displayEntries.length > 0 || hasFilters ? (
                    <Text
                      className='rounded-full px-2 py-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.58)]'
                      onClick={() => setSelectionMode(true)}
                    >
                      多选
                    </Text>
                  ) : null}
                </View>
              </View>
            )}

            {/* 非致命错误（HistoryClient.tsx:613-627） */}
            {error && entries.length > 0 ? (
              <View className='mb-4 flex items-center justify-between gap-3 rounded-ios-2xl bg-[rgba(255,59,48,0.08)] px-4 py-3'>
                <Text className='min-w-0 flex-1 text-ios-footnote text-[#FF3B30]'>{error}</Text>
                <Text
                  className='shrink-0 text-ios-caption1 text-[rgba(255,59,48,0.70)]'
                  onClick={() => setError('')}
                >
                  知道了
                </Text>
              </View>
            ) : null}

            {notice ? (
              <View className='mb-4 rounded-ios-2xl bg-[rgba(0,122,255,0.08)] px-4 py-3'>
                <Text className='text-ios-footnote text-[#007AFF]'>{notice}</Text>
              </View>
            ) : null}

            {/* 筛选栏（HistoryFilterBar.tsx:151-353 的手机端布局） */}
            {!selectionMode && (displayEntries.length > 0 || hasFilters) ? (
              <View className='relative mb-4 space-y-3'>
                <View className='relative flex items-center'>
                  <Icon
                    name='search-a40'
                    className='pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2'
                  />
                  <Input
                    className='box-border w-full rounded-ios-xl border-0 bg-[rgba(0,0,0,0.05)] py-2.5 pl-9 pr-20 text-ios-footnote text-[rgba(0,0,0,0.85)]'
                    value={keyword}
                    onInput={(event) => setKeyword(event.detail.value)}
                    confirmType='search'
                  />
                  {/* 原生 placeholder 在真机/模拟器上会出现字叠字（同一串被绘制两层），
                      改成自绘文案，与网页版 placeholder 同一颜色与字号。 */}
                  {!keyword ? (
                    <View className='pointer-events-none absolute inset-y-0 left-9 flex items-center'>
                      <Text className='text-ios-footnote text-[rgba(0,0,0,0.46)]'>搜索提示词或模型…</Text>
                    </View>
                  ) : null}
                  {keyword ? (
                    <View
                      className='absolute right-11 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[rgba(0,0,0,0.44)]'
                      onClick={() => setKeyword('')}
                    >
                      <Icon name='x-a45' className='h-3 w-3' />
                    </View>
                  ) : null}
                  <View
                    className={`absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full ${
                      filtersOpen || activeFilterCount
                        ? 'bg-[rgba(0,122,255,0.12)] text-[#007AFF]'
                        : 'bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.62)]'
                    }`}
                    onClick={() => setFiltersOpen((open) => !open)}
                  >
                    <Icon name='filter-a62' className='h-3.5 w-3.5' />
                    {activeFilterCount > 0 ? (
                      <View className='absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[rgba(0,122,255,0.12)] px-1 text-ios-caption2 font-medium tabular-nums text-[#007AFF]'>
                        <Text>{activeFilterCount}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                <ScrollView scrollX enableFlex className='-mx-4 px-4 pb-1'>
                  <View className='flex items-center gap-2'>
                    <View
                      className={`style-chip ${
                        !filters.starredOnly && !filters.withImageOnly && kind === 'all' ? 'active' : ''
                      }`}
                      onClick={clearFilters}
                    >
                      <Text>全部</Text>
                    </View>

                    <View
                      className={`style-chip gap-1.5 ${filters.starredOnly ? 'active' : ''}`}
                      onClick={() =>
                        setFilters((prev) => ({
                          ...prev,
                          starredOnly: prev.starredOnly ? undefined : true,
                        }))
                      }
                    >
                      <Text className={filters.starredOnly ? 'text-[#FFB300]' : ''}>
                        {filters.starredOnly ? '★' : '☆'}
                      </Text>
                      <Text>收藏</Text>
                      {facets ? (
                        <Text
                          className={`tabular-nums ${
                            filters.starredOnly ? 'text-[rgba(0,122,255,0.62)]' : 'text-[rgba(0,0,0,0.58)]'
                          }`}
                        >
                          {facets.starredCount}
                        </Text>
                      ) : null}
                    </View>

                    {(['image', 'video', 'audio'] as HistoryEntryKind[]).map((value) => (
                      <View
                        key={value}
                        className={`style-chip gap-1.5 ${kind === value ? 'active' : ''}`}
                        onClick={() => {
                          setKind(kind === value ? 'all' : value)
                          setFilters((prev) => ({ ...prev, withImageOnly: undefined }))
                        }}
                      >
                        <Icon
                          name={value === 'image' ? 'image-a40' : value === 'video' ? 'clapperboard-a40' : 'music-a40'}
                          className='h-3.5 w-3.5'
                        />
                        <Text>{KIND_LABELS[value]}</Text>
                      </View>
                    ))}

                    <View
                      className={`style-chip gap-1.5 ${filters.withImageOnly ? 'active' : ''}`}
                      onClick={() => {
                        setKind('all')
                        setFilters((prev) => ({ ...prev, withImageOnly: prev.withImageOnly ? undefined : true }))
                      }}
                    >
                      <Icon name='image-a40' className='h-3.5 w-3.5' />
                      <Text>有图</Text>
                      {facets ? (
                        <Text
                          className={`tabular-nums ${
                            filters.withImageOnly ? 'text-[rgba(0,122,255,0.62)]' : 'text-[rgba(0,0,0,0.58)]'
                          }`}
                        >
                          {facets.withImageCount}
                        </Text>
                      ) : null}
                    </View>

                    {hasFilters ? (
                      <View
                        className='shrink-0 rounded-full px-2.5 py-1.5 text-ios-footnote text-[rgba(0,0,0,0.58)]'
                        onClick={clearFilters}
                      >
                        <Text>清除筛选</Text>
                      </View>
                    ) : null}
                  </View>
                </ScrollView>

                {filtersOpen ? (
                  <View className='space-y-2.5 rounded-ios-2xl bg-[rgba(0,0,0,0.025)] p-3'>
                    {facets && facets.models.length > 1 ? (
                      <View>
                        <Text className='mb-1.5 block text-ios-caption1 font-medium text-[rgba(0,0,0,0.58)]'>
                          模型
                        </Text>
                        <View className='flex flex-wrap gap-1.5'>
                          {facets.models.map((bucket) => (
                            <View
                              key={bucket.value}
                              className={`style-chip ${filters.modelId === bucket.value ? 'active' : ''}`}
                              onClick={() =>
                                setFilters((prev) => ({
                                  ...prev,
                                  modelId: prev.modelId === bucket.value ? undefined : bucket.value,
                                }))
                              }
                            >
                              <Text>{formatModelLabel(bucket.label || bucket.value)}</Text>
                              <Text
                                className={`tabular-nums ${
                                  filters.modelId === bucket.value
                                    ? 'text-[rgba(0,122,255,0.62)]'
                                    : 'text-[rgba(0,0,0,0.58)]'
                                }`}
                              >
                                {bucket.count}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    ) : null}

                    {facets && facets.imageSizes.length > 1 ? (
                      <View>
                        <Text className='mb-1.5 block text-ios-caption1 font-medium text-[rgba(0,0,0,0.58)]'>
                          尺寸
                        </Text>
                        <View className='flex flex-wrap gap-1.5'>
                          {facets.imageSizes.map((bucket) => (
                            <View
                              key={bucket.value}
                              className={`style-chip ${filters.imageSize === bucket.value ? 'active' : ''}`}
                              onClick={() =>
                                setFilters((prev) => ({
                                  ...prev,
                                  imageSize: prev.imageSize === bucket.value ? undefined : bucket.value,
                                }))
                              }
                            >
                              <Text>{bucket.label || bucket.value}</Text>
                              <Text
                                className={`tabular-nums ${
                                  filters.imageSize === bucket.value
                                    ? 'text-[rgba(0,122,255,0.62)]'
                                    : 'text-[rgba(0,0,0,0.58)]'
                                }`}
                              >
                                {bucket.count}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    ) : null}

                    {/* 统计（HistoryStats.tsx:15-28）＋导出（HistoryFilterBar.tsx:333-350） */}
                    <View className='border-t border-[rgba(0,0,0,0.06)] pt-2.5'>
                      <Text className='text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.58)]'>
                        留存 {showSkeleton ? '—' : stats.images} 张（{stats.entries} 条记录）· 收藏{' '}
                        {facets?.starredCount ?? stats.starred}
                      </Text>
                    </View>

                    <View className='flex gap-2'>
                      <View
                        className='inline-flex items-center gap-1.5 rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)]'
                        onClick={() => void handleExport('csv')}
                      >
                        <Icon
                          name='loader-2-a60'
                          className={`h-3.5 w-3.5 ${exporting === 'csv' ? 'ic-spin' : 'hidden'}`}
                        />
                        <Icon name='library-a45' className={`h-3.5 w-3.5 ${exporting === 'csv' ? 'hidden' : ''}`} />
                        <Text>导出 CSV</Text>
                      </View>
                      <View
                        className='inline-flex items-center gap-1.5 rounded-ios-xl bg-[rgba(0,0,0,0.05)] px-3 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.62)]'
                        onClick={() => void handleExport('json')}
                      >
                        <Icon
                          name='loader-2-a60'
                          className={`h-3.5 w-3.5 ${exporting === 'json' ? 'ic-spin' : 'hidden'}`}
                        />
                        <Icon name='copy-a40' className={`h-3.5 w-3.5 ${exporting === 'json' ? 'hidden' : ''}`} />
                        <Text>导出 JSON</Text>
                      </View>
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>

          <ScrollView
            id='hist-scroll'
            scrollY
            className='min-h-0 flex-1'
            style={{ flex: 1, minHeight: 0 }}
            scrollTop={scrollTop}
            lowerThreshold={180}
            onScrollToLower={() => void loadMore()}
            refresherEnabled
            refresherTriggered={refreshing}
            onRefresherRefresh={() => void handleRefresh()}
          >
            <View className='px-4 pb-28 pt-1'>
              {showSkeleton ? (
                // 骨架屏（HistorySkeleton.tsx:4-19）：高度刻意不一致，看起来就是瀑布流本身。
                <View>
                  {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
                    <View key={index} className='hist-card hist-masonry-item'>
                      <View
                        className='hist-skeleton w-full'
                        style={{ paddingTop: ['75%', '100%', '133%', '100%', '125%', '133%'][index % 6] }}
                      />
                    </View>
                  ))}
                </View>
              ) : error && entries.length === 0 ? (
                // 错误空态（HistoryEmptyState.tsx:79-89 的「重试」分支）
                <View className='lg-card relative overflow-hidden rounded-ios-3xl'>
                  <View className='pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70' />
                  <View className='flex flex-col items-center justify-center gap-4 py-20 text-center'>
                    <View className='flex h-14 w-14 items-center justify-center rounded-ios-2xl bg-[rgba(0,0,0,0.04)]'>
                      <Icon name='alert-circle-a44' className='h-6 w-6' />
                    </View>
                    <View>
                      <Text className='block text-ios-body font-medium text-[rgba(0,0,0,0.85)]'>
                        历史记录加载失败
                      </Text>
                      <Text className='mt-1 block text-ios-footnote text-[rgba(0,0,0,0.58)]'>{error}</Text>
                    </View>
                    <View
                      className='mt-1 rounded-full bg-[#007AFF] px-5 py-2 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)]'
                      onClick={() => void loadFirstPage(filtersRef.current)}
                    >
                      <Text>重试</Text>
                    </View>
                  </View>
                </View>
              ) : visibleEntries.length === 0 ? (
                // 空态（HistoryEmptyState.tsx:16-77）：filtered 与 empty 两种文案。
                <View className='lg-card relative overflow-hidden rounded-ios-3xl'>
                  <View className='pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-70' />
                  <View className='flex flex-col items-center justify-center gap-4 py-20 text-center'>
                    <View className='flex h-14 w-14 items-center justify-center rounded-ios-2xl bg-[rgba(0,0,0,0.04)]'>
                      <Icon name={hasFilters ? 'search-a40' : 'image-a40'} className='h-6 w-6' />
                    </View>
                    <View>
                      <Text className='block text-ios-body font-medium text-[rgba(0,0,0,0.85)]'>
                        {hasFilters ? '没有符合条件的记录' : '还没有生成记录'}
                      </Text>
                      <Text className='mt-1 block text-ios-footnote text-[rgba(0,0,0,0.58)]'>
                        {hasFilters ? '换个关键词，或清除筛选看看' : '做完图会自动出现在这里'}
                      </Text>
                    </View>
                    {hasFilters ? (
                      <View
                        className='mt-1 rounded-full bg-[rgba(0,0,0,0.06)] px-5 py-2 text-ios-footnote font-medium text-[rgba(0,0,0,0.56)]'
                        onClick={clearFilters}
                      >
                        <Text>清除筛选</Text>
                      </View>
                    ) : (
                      <View
                        className='mt-1 rounded-full bg-[#007AFF] px-5 py-2 text-ios-footnote font-semibold text-white shadow-[0_4px_16px_rgba(0,122,255,0.30)]'
                        onClick={goHome}
                      >
                        <Text>去做图</Text>
                      </View>
                    )}
                  </View>
                </View>
              ) : (
                <View>
                  {groups.map((group) => (
                    <View key={group.bucket} className='mb-6'>
                      <View className='mb-2.5 flex items-baseline gap-2'>
                        <Text className='text-ios-subhead font-semibold text-[rgba(0,0,0,0.72)]'>
                          {group.label}
                        </Text>
                        <Text className='text-ios-caption1 tabular-nums text-[rgba(0,0,0,0.58)]'>
                          {group.entries.length}
                        </Text>
                      </View>
                      {group.entries.map((entry) => renderCard(entry))}
                    </View>
                  ))}
                </View>
              )}

              {/* 无限滚动底部状态：加载中 / 没有了 两种（需求原文）。 */}
              {!showSkeleton && visibleEntries.length > 0 ? (
                loadingMore ? (
                  <View className='flex items-center justify-center gap-2 py-6'>
                    <Icon name='loader-2-a60' className='ic-spin h-4 w-4' />
                    <Text className='text-ios-footnote text-[rgba(0,0,0,0.58)]'>加载中…</Text>
                  </View>
                ) : !cursor ? (
                  <View className='py-6 text-center'>
                    <Text className='text-ios-caption1 text-[rgba(0,0,0,0.46)]'>没有了</Text>
                  </View>
                ) : null
              ) : null}
            </View>
          </ScrollView>
        </View>
      </PageShell>
    </PageBoundary>
  )
}
