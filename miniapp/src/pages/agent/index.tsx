import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from '@tarojs/components'
import Taro, { useUnload } from '@tarojs/taro'
import {
  abortAgentSession,
  connectAgentStream,
  createAgentSession,
  createSession,
  deleteSession,
  fetchAgentHistory,
  fetchAgentThinkingLevel,
  listAgentSessions,
  listSessions,
  parseQuotaChanged,
  parseQuestionRequest,
  patchAgentSessionMemory,
  reduceAgentItems,
  renameSession,
  replyAgentQuestion,
  resolveAgentConfirm,
  saveAgentThinkingLevel,
  sendAgentMessage,
  startAgentPolling,
  type AgentPollingHandle,
  type AgentSessionSummary,
  type AgentSseEvent,
  type AgentStreamHandle,
  type AgentThinkingLevel,
} from '../../lib/agent'
import { createFrameBatcher, type FrameBatcher } from '../../lib/agent-frame-batch'
import { clearPersisted, loadPersisted, savePersisted } from '../../lib/agent-persistence'
import { ApiError } from '../../lib/request'
import { ensureLogin, fetchMe, type MiniUser } from '../../lib/session'
import { QUOTA_PER_COIN } from '../../lib/quota'
import { Navbar } from '../../components/Navbar'
import { MobileDrawer } from '../../components/MobileDrawer'
import { PageBoundary } from '../../components/pages/PageBoundary'
import { AgentChatSurface } from '../../components/agent-chat/AgentChatSurface'
import {
  buildAnchorMessage,
  buildReanchorMessage,
  deriveBatchAnchor,
  shouldOfferBatchAnchor,
} from '../../components/agent-chat/agent-batch-anchor'
import type {
  AgentConnection,
  AgentItem,
  AgentPendingConfirm,
  AgentPendingQuestion,
} from '../../components/agent-chat/types'

/** 会改变 transcript 条目的事件（其余只改页面级状态）。 */
const ITEM_EVENT_NAMES = new Set([
  'message.delta',
  'reasoning.delta',
  'tool.invoke',
  'tool.progress',
  'tool.result',
  'image.done',
  'image.failed',
  'video.done',
  'audio.done',
  'director.done',
  'turn.plan',
  'turn.done',
  'confirm.resolved',
  'question.replied',
  'question.rejected',
  'session.error',
  'session.closed',
  'subagent.started',
  'subagent.delta',
  'subagent.done',
  'subagent.tool',
  'steer.status',
])

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export default function AgentPage() {
  const [statusBarHeight, setStatusBarHeight] = useState(20)
  const [user, setUser] = useState<MiniUser | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const [items, setItems] = useState<AgentItem[]>([])
  const [sessionId, setSessionId] = useState('')
  const [connection, setConnection] = useState<AgentConnection>('connecting')
  const [closedReason, setClosedReason] = useState<string | undefined>(undefined)
  const [turnActive, setTurnActive] = useState(false)
  const [turnStatus, setTurnStatus] = useState<string | undefined>(undefined)
  const [confirms, setConfirms] = useState<AgentPendingConfirm[]>([])
  const [questions, setQuestions] = useState<AgentPendingQuestion[]>([])
  const [anchorAskedFor, setAnchorAskedFor] = useState<string | null>(null)
  const [anchorBusy, setAnchorBusy] = useState(false)
  const [assetsSignal, setAssetsSignal] = useState(0)
  const [errorText, setErrorText] = useState('')
  const [booting, setBooting] = useState(true)
  const [sending, setSending] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [sessionStarting, setSessionStarting] = useState(false)
  const [pendingExample, setPendingExample] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState<AgentThinkingLevel>('medium')
  // 历史会话目录（null＝未加载；[]＝已加载但为空）。服务端目录是真源。
  const [historySessions, setHistorySessions] = useState<AgentSessionSummary[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  const sessionIdRef = useRef('')
  const streamRef = useRef<AgentStreamHandle | null>(null)
  const pollRef = useRef<AgentPollingHandle | null>(null)
  const fallbackRef = useRef(false)
  const mountedRef = useRef(true)
  const cursorRef = useRef(0)
  const itemsRef = useRef<AgentItem[]>([])
  const sendingRef = useRef(false)
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exampleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 切会话竞态闸：只有最后一次 bootstrapSession 能落地状态/开流。
  const bootSeqRef = useRef(0)
  // 账号身份：本地缓存按账号隔离（读不到该账号就当没有存档）。
  const ownerIdRef = useRef<number | null>(null)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const clearSendWatch = useCallback(() => {
    if (sendTimerRef.current !== null) {
      clearTimeout(sendTimerRef.current)
      sendTimerRef.current = null
    }
  }, [])

  const markTurnStarted = useCallback(() => {
    clearSendWatch()
    sendingRef.current = false
    setSending(false)
    setPendingExample(null)
    if (exampleTimerRef.current !== null) {
      clearTimeout(exampleTimerRef.current)
      exampleTimerRef.current = null
    }
  }, [clearSendWatch])

  // ─────────────────── SSE 事件 → 条目（照 agent-chat-reducer 的分支语义）
  // 条目生成统一走 lib/agent.ts 的 reduceAgentItems（reduce-messages.ts /
  // reduce-runs.ts / actions.ts 的规则），本页只维护页面级状态。
  const closedRef = useRef(false)
  const applyEvent = useCallback(
    (event: AgentSseEvent) => {
      if (!mountedRef.current) return
      const data = event.data ?? {}
      const id = event.eventId || 0

      if (ITEM_EVENT_NAMES.has(event.name)) {
        // 死会话上的迟到帧不再改动条目（agent-chat-reducer.ts:62-68 的同一语义）。
        if (event.name !== 'session.closed' && closedRef.current) {
          if (id > cursorRef.current) cursorRef.current = id
          return
        }
        if (event.name === 'session.closed') {
          if (closedRef.current) {
            if (id > cursorRef.current) cursorRef.current = id
            return
          }
          closedRef.current = true
        }
        setItems((previous) => reduceAgentItems(previous, event))
      }

      switch (event.name) {
        case 'message.delta':
          if (!readString(data, 'text')) return
          markTurnStarted()
          setTurnStatus(undefined)
          setTurnActive(true)
          break
        case 'reasoning.delta':
          if (!readString(data, 'text')) return
          markTurnStarted()
          setTurnActive(true)
          break
        case 'tool.invoke':
          if (!readString(data, 'tool')) return
          markTurnStarted()
          setTurnStatus(undefined)
          setTurnActive(true)
          break
        case 'tool.progress':
          setTurnActive(true)
          break
        case 'tool.result':
          setTurnStatus(undefined)
          break
        case 'image.done':
        case 'image.failed':
        case 'video.done':
        case 'audio.done':
        case 'director.done':
          setTurnActive(true)
          setTurnStatus(undefined)
          break
        case 'turn.plan':
          if (!readString(data, 'plan').trim()) return
          markTurnStarted()
          setTurnActive(true)
          setTurnStatus(undefined)
          break
        case 'turn.status': {
          const text = readString(data, 'text')
          setTurnStatus(text)
          setTurnActive(true)
          break
        }
        case 'turn.done': {
          setTurnActive(false)
          setTurnStatus(undefined)
          clearSendWatch()
          sendingRef.current = false
          setSending(false)
          setPendingExample(null)
          setStopPending(false)
          break
        }
        case 'confirm.request': {
          const requestId = readString(data, 'request_id')
          const amount = readNumber(data, 'amount_coins')
          if (!requestId || amount === undefined) return
          setConfirms((previous) =>
            previous.some((card) => card.requestId === requestId)
              ? previous
              : [
                  ...previous,
                  {
                    requestId,
                    amountCoins: amount,
                    ...(readString(data, 'description') ? { description: readString(data, 'description') } : {}),
                  },
                ],
          )
          break
        }
        case 'confirm.resolved': {
          const requestId = readString(data, 'request_id')
          if (!requestId) return
          setConfirms((previous) => previous.filter((card) => card.requestId !== requestId))
          break
        }
        case 'question.request': {
          const question = parseQuestionRequest({ ...data, event_id: id })
          if (!question) return
          setQuestions((previous) =>
            previous.some((item) => item.requestId === question.requestId) ? previous : [...previous, question],
          )
          setTurnActive(true)
          break
        }
        case 'question.replied':
        case 'question.rejected': {
          const requestId = readString(data, 'request_id')
          if (!requestId) return
          setQuestions((previous) => previous.filter((item) => item.requestId !== requestId))
          break
        }
        case 'quota.changed': {
          const quota = parseQuotaChanged(data)
          if (!quota || quota.balanceCoins === null) return
          const balance = quota.balanceCoins
          setUser((previous) => (previous ? { ...previous, quota: balance * QUOTA_PER_COIN } : previous))
          break
        }
        case 'subagent.started':
        case 'subagent.delta':
        case 'subagent.tool':
          setTurnActive(true)
          break
        case 'subagent.done':
          // reduce-runs.ts:151-178：done 不改 turnActive（异步子代理可能跨回合）。
          break
        case 'session.error':
          break
        case 'session.closed': {
          const reason = readString(data, 'reason')
          setTurnActive(false)
          setConnection('closed')
          setClosedReason(reason || undefined)
          setQuestions([])
          setConfirms([])
          break
        }
        default:
          break
      }

      if (id > cursorRef.current) cursorRef.current = id
    },
    [clearSendWatch, markTurnStarted],
  )

  const applyEventRef = useRef(applyEvent)
  applyEventRef.current = applyEvent

  // SSE 帧并批：文字 delta 合批，其余帧直通（agent-frame-batch 语义）。
  const batcherRef = useRef<FrameBatcher | null>(null)
  if (batcherRef.current === null) {
    batcherRef.current = createFrameBatcher({ apply: (event) => applyEventRef.current(event) })
  }

  /** 立即落一次本地加速快照（切会话 / 离开页面前用）。失败静默。 */
  const persistSnapshot = useCallback((): void => {
    const id = sessionIdRef.current
    if (!id || ownerIdRef.current === null) return
    savePersisted(
      { sessionId: id, lastEventId: cursorRef.current, items: itemsRef.current },
      ownerIdRef.current,
    )
  }, [])

  // 本地加速快照：items 变化后防抖写一次（服务端仍是真源，仅加速下次恢复）。
  // 空 transcript 不落盘：切会话时的清场渲染不得把上一会话的加速存档擦掉。
  useEffect(() => {
    if (!sessionId || ownerIdRef.current === null || items.length === 0) return
    const timer = setTimeout(() => {
      if (sessionIdRef.current !== sessionId) return
      savePersisted(
        { sessionId, lastEventId: cursorRef.current, items: itemsRef.current },
        ownerIdRef.current,
      )
    }, 800)
    return () => clearTimeout(timer)
  }, [items, sessionId])

  // ─────────────────── 流 / 轮询
  const startFallback = useCallback((id: string) => {
    if (fallbackRef.current || !id) return
    fallbackRef.current = true
    pollRef.current?.stop()
    pollRef.current = startAgentPolling(id, {
      onSnapshot: (snapshot) => {
        if (!mountedRef.current) return
        if (sessionIdRef.current !== id) return
        // 轮询快照已涵盖 ≤event_counter 的全部内容：同时推进续传游标，
        // 之后若重新开 SSE 不会重放已渲染过的帧。
        if (snapshot.eventCounter > cursorRef.current) cursorRef.current = snapshot.eventCounter
        setItems(snapshot.items)
        setTurnStatus(undefined)
      },
    })
  }, [])

  const openStream = useCallback(
    (id: string, cursor: number) => {
      streamRef.current?.close()
      setConnection('connecting')
      streamRef.current = connectAgentStream(id, {
        lastEventId: cursor,
        onConnected: () => {
          if (mountedRef.current) setConnection('open')
        },
        onEvent: (event) => batcherRef.current?.push(event),
        onUnavailable: () => {
          if (!mountedRef.current) return
          // 小程序平台不支持 chunked / 连续重连失败：先把已缓冲的文字帧落地，
          // 再转轮询静默兜底。
          batcherRef.current?.flush()
          setConnection('open')
          startFallback(id)
        },
      })
    },
    [startFallback],
  )

  // ─────────────────── 会话引导（首次进入 / 切会话 / 开新对话共用）
  // 切会话顺序（照 use-agent-chat.ts:601-726 的语义）：
  //   落旧会话快照 → 断开旧 SSE、丢弃并批缓冲 → 清空旧条目与游标 →
  //   本地存档先画一帧（仅加速）→ 拉服务端全量历史并用归一化条目覆盖 →
  //   用 event_counter 当 last_event_id 重开流（重连不重复、不回退）。
  const bootstrapSession = useCallback(
    async (targetId?: string): Promise<boolean> => {
      const seq = ++bootSeqRef.current
      // 换轨前把当前会话的进度落盘（否则连续切换会丢掉上一段的加速快照）。
      persistSnapshot()
      batcherRef.current?.drop()
      streamRef.current?.close()
      streamRef.current = null
      pollRef.current?.stop()
      pollRef.current = null
      fallbackRef.current = false
      closedRef.current = false
      cursorRef.current = 0
      setConnection('connecting')
      setClosedReason(undefined)
      setErrorText('')
      setConfirms([])
      setQuestions([])
      setTurnActive(false)
      setTurnStatus(undefined)
      setStopPending(false)
      setAnchorAskedFor(null)
      setPendingExample(null)
      setBooting(true)
      setItems([])
      itemsRef.current = []

      // 账号级加速存档（过期 / 坏数据一律当没有）。
      const cached = loadPersisted()
      let id = targetId ?? ''
      // 从服务端目录 / 新建分支都可能换号；标记是否为本轮新建（新建不补注记忆）。
      let createdFresh = false
      if (!id && cached) id = cached.sessionId
      if (!id) {
        try {
          const sessions = await listAgentSessions()
          id = sessions.length > 0 ? sessions[0].session_id : ''
        } catch {
          id = ''
        }
      }
      if (!id) {
        try {
          id = await createAgentSession()
          createdFresh = true
        } catch (error) {
          if (!mountedRef.current || seq !== bootSeqRef.current) return false
          setErrorText(error instanceof Error ? error.message : '建立会话失败，请稍后重试')
          setBooting(false)
          setConnection('idle')
          return false
        }
      }
      if (!mountedRef.current || seq !== bootSeqRef.current) return false
      sessionIdRef.current = id
      setSessionId(id)

      const sameCached = cached !== null && cached.sessionId === id
      // 本地加速：先把该会话的存档画出来（服务端历史稍后覆盖）。
      let cursor = 0
      if (sameCached) {
        setItems(cached.items)
        itemsRef.current = cached.items
        cursor = cached.lastEventId
      }

      let serverItems: AgentItem[] = []
      let serverCounter = 0
      try {
        const history = await fetchAgentHistory(id)
        if (!mountedRef.current || seq !== bootSeqRef.current) return false
        // replay_only＝网关明说全量历史不可得：按降级路径（用存档或空态）。
        if (history.fallback !== 'replay_only') {
          serverItems = history.items
          serverCounter = history.eventCounter
        }
      } catch (error) {
        if (!mountedRef.current || seq !== bootSeqRef.current) return false
        if (error instanceof ApiError && error.status === 404) {
          // 明确点选的会话已不存在：如实报错，不偷偷换一个新号。
          if (targetId || sameCached) {
            if (sameCached) clearPersisted(ownerIdRef.current)
            setErrorText('该会话不存在或已过期')
            setBooting(false)
            setConnection('idle')
            return false
          }
          try {
            const fresh = await createAgentSession()
            if (!mountedRef.current || seq !== bootSeqRef.current) return false
            id = fresh
            createdFresh = true
            sessionIdRef.current = fresh
            setSessionId(fresh)
            setItems([])
            itemsRef.current = []
            serverItems = []
          } catch {
            // 建新会话也失败：保留原 id，错误会在发送时如实显示。
          }
        }
        // 其它错误（网络 / 5xx）：保留存档画面上屏，游标沿用存档，稍后重试。
      }
      if (!mountedRef.current || seq !== bootSeqRef.current) return false

      if (serverItems.length > 0) {
        // 历史重建已涵盖 ≤counter 的所有内容：SSE 只收其后的增量。
        setItems(serverItems)
        itemsRef.current = serverItems
        cursor = serverCounter
      } else if (!sameCached) {
        // 空会话 / 历史不可得且无存档：回空态，让网关按游标 0 回放。
        setItems([])
        itemsRef.current = []
        cursor = 0
      }

      cursorRef.current = cursor
      setBooting(false)
      openStream(id, cursor)
      // 老会话补注账户画像（resume/switch 语义，best-effort，失败静默）。
      if (!createdFresh) void patchAgentSessionMemory(id)
      return true
    },
    [openStream, persistSnapshot],
  )

  /** 拉历史会话目录（服务端为真源；失败给一句人话，不挡聊天）。 */
  const refreshHistory = useCallback((): void => {
    setHistoryError('')
    void listSessions()
      .then((items) => {
        if (mountedRef.current) setHistorySessions(items)
      })
      .catch(() => {
        if (mountedRef.current) setHistoryError('历史加载失败，请重新打开重试。')
      })
  }, [])

  // ─────────────────── 首次进入
  useEffect(() => {
    mountedRef.current = true
    let disposed = false

    const info = Taro.getWindowInfo ? Taro.getWindowInfo() : Taro.getSystemInfoSync()
    setStatusBarHeight(Number(info.statusBarHeight ?? 20))

    async function boot(): Promise<void> {
      try {
        const current = await ensureLogin()
        if (disposed) return
        setUser(current)
        ownerIdRef.current = typeof current.id === 'number' ? current.id : null
        void fetchAgentThinkingLevel().then((level) => {
          if (!disposed) setThinkingLevel(level)
        })
        refreshHistory()
      } catch (error) {
        if (disposed) return
        setErrorText(error instanceof Error ? error.message : '登录失败，请稍后重试')
        setBooting(false)
        setConnection('idle')
        return
      }
      await bootstrapSession()
    }

    void boot()

    return () => {
      disposed = true
      mountedRef.current = false
      clearSendWatch()
      persistSnapshot()
      batcherRef.current?.drop()
      if (exampleTimerRef.current !== null) clearTimeout(exampleTimerRef.current)
      streamRef.current?.close()
      streamRef.current = null
      pollRef.current?.stop()
      pollRef.current = null
    }
  }, [clearSendWatch, bootstrapSession, persistSnapshot, refreshHistory])

  useUnload(() => {
    mountedRef.current = false
    clearSendWatch()
    persistSnapshot()
    batcherRef.current?.drop()
    streamRef.current?.close()
    streamRef.current = null
    pollRef.current?.stop()
    pollRef.current = null
  })

  // ─────────────────── 发送
  const sendText = useCallback(
    async (raw: string, viaExample = false): Promise<void> => {
      const text = raw.trim()
      if (!text || sendingRef.current) return
      sendingRef.current = true
      setSending(true)
      setErrorText('')
      setDraft('')
      if (viaExample) setPendingExample(text)

      // 乐观插入用户气泡（appendUserTurn，actions.ts:6-27）。
      setItems((previous) => [...previous, { kind: 'user', id: nextId('user'), text }])
      setTurnActive(true)
      setTurnStatus(undefined)

      clearSendWatch()
      sendTimerRef.current = setTimeout(() => {
        sendTimerRef.current = null
        sendingRef.current = false
        setSending(false)
        setPendingExample(null)
      }, 20_000)
      if (viaExample) {
        if (exampleTimerRef.current !== null) clearTimeout(exampleTimerRef.current)
        exampleTimerRef.current = setTimeout(() => setPendingExample(null), 20_000)
      }

      let id = sessionIdRef.current
      try {
        if (!id) {
          setSessionStarting(true)
          id = await createAgentSession()
          sessionIdRef.current = id
          setSessionId(id)
          setSessionStarting(false)
        }
        await sendAgentMessage(id, text)
        if (!fallbackRef.current) {
          const current = streamRef.current
          if (!current || current.isClosed()) {
            openStream(id, current?.getCursor() ?? cursorRef.current)
          }
        }
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : '发送失败，请重试')
        setDraft(text)
        setTurnActive(false)
        clearSendWatch()
        sendingRef.current = false
        setSending(false)
        setSessionStarting(false)
        setPendingExample(null)
      }
    },
    [clearSendWatch, openStream],
  )

  const handleSend = useCallback(() => {
    void sendText(draft)
  }, [draft, sendText])

  const handleExampleSend = useCallback(
    (text: string) => {
      void sendText(text, true)
    },
    [sendText],
  )

  const handleStop = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current
    if (!id || stopPending) return
    setStopPending(true)
    try {
      await abortAgentSession(id)
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : '中止失败，请重试')
      setStopPending(false)
    }
  }, [stopPending])

  const handleConfirm = useCallback(
    async (requestId: string, approved: boolean): Promise<void> => {
      const id = sessionIdRef.current
      if (!id) return
      setConfirms((previous) =>
        previous.map((card) => (card.requestId === requestId ? { ...card, resolving: true } : card)),
      )
      try {
        await resolveAgentConfirm(id, requestId, approved)
        // 权威收敛靠网关 confirm.resolved；这里先乐观收起。
        setConfirms((previous) => previous.filter((card) => card.requestId !== requestId))
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : '确认失败，请重试')
        setConfirms((previous) =>
          previous.map((card) => (card.requestId === requestId ? { ...card, resolving: false } : card)),
        )
      }
    },
    [],
  )

  const handleRetry = useCallback(() => {
    setErrorText('')
    const id = sessionIdRef.current
    if (!id) {
      setBooting(true)
      void ensureLogin()
        .then(() => setBooting(false))
        .catch((error) => {
          setErrorText(error instanceof Error ? error.message : '登录失败，请稍后重试')
          setBooting(false)
        })
      return
    }
    fallbackRef.current = false
    pollRef.current?.stop()
    pollRef.current = null
    batcherRef.current?.flush()
    openStream(id, cursorRef.current)
  }, [openStream])

  const handleThinkingLevelChange = useCallback((level: AgentThinkingLevel) => {
    setThinkingLevel(level)
    void saveAgentThinkingLevel(level)
  }, [])

  // D-26 首张锚定（AgentChatSurface.session-actions.ts:591-627）。
  const derivedAnchor = useMemo(() => deriveBatchAnchor(items), [items])
  const anchor =
    derivedAnchor && derivedAnchor.imageId !== anchorAskedFor && shouldOfferBatchAnchor(items)
      ? derivedAnchor
      : null

  const handleAnchor = useCallback((): void => {
    if (!anchor || anchorBusy) return
    setAnchorAskedFor(anchor.imageId)
    setAnchorBusy(true)
    void Promise.resolve(sendText(buildAnchorMessage(anchor))).finally(() => setAnchorBusy(false))
  }, [anchor, anchorBusy, sendText])

  const handleReanchor = useCallback((): void => {
    if (!anchor || anchorBusy) return
    setAnchorAskedFor(anchor.imageId)
    setAnchorBusy(true)
    void Promise.resolve(sendText(buildReanchorMessage(anchor))).finally(() => setAnchorBusy(false))
  }, [anchor, anchorBusy, sendText])

  const handleAnchorDismiss = useCallback((): void => {
    if (anchor) setAnchorAskedFor(anchor.imageId)
  }, [anchor])

  /** 回复 opencode question（session.ts:242-246）。 */
  const handleAnswerQuestion = useCallback(
    async (requestId: string, answers: string[][]): Promise<boolean> => {
      const id = sessionIdRef.current
      if (!id) return false
      try {
        await replyAgentQuestion(id, requestId, answers)
        // 权威收敛靠网关 question.replied / question.rejected；这里先乐观收起。
        setQuestions((previous) => previous.filter((item) => item.requestId !== requestId))
        return true
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : '提交失败，请重试')
        return false
      }
    },
    [],
  )

  // ─────────────────── 抽屉接线（MobileDrawer 的会话切换 / 新对话 / 资产 / 设置）
  const handlePickSession = useCallback(
    (targetSessionId: string): void => {
      setDrawerOpen(false)
      if (switchingTo !== null) return
      setSwitchingTo(targetSessionId)
      void bootstrapSession(targetSessionId)
        .then((ok) => {
          if (ok) refreshHistory()
        })
        .finally(() => setSwitchingTo(null))
    },
    [bootstrapSession, refreshHistory, switchingTo],
  )

  const handleStartNewSession = useCallback((): void => {
    setDrawerOpen(false)
    setSwitchingTo(null)
    void (async () => {
      try {
        // 开新＝回空态：旧会话留在服务端历史里可切回，本地加速存档清掉。
        clearPersisted(ownerIdRef.current)
        const id = await createSession()
        await bootstrapSession(id)
        refreshHistory()
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : '建立会话失败，请稍后重试')
      }
    })()
  }, [bootstrapSession, refreshHistory])

  /** 长按历史会话行：重命名 / 删除（Taro 原生菜单，不另造浮层）。 */
  const handleSessionRowAction = useCallback(
    (session: AgentSessionSummary): void => {
      void Taro.showActionSheet({ itemList: ['重命名', '删除'] })
        .then(async (result) => {
          if (result.tapIndex === 0) {
            // editable 是微信 showModal 的真实能力，@tarojs/taro 4.3 的类型未声明。
            const modal = (await Taro.showModal({
              title: '重命名会话',
              editable: true,
              placeholderText: '输入会话标题',
              content: session.title ?? '',
            } as unknown as Parameters<typeof Taro.showModal>[0])) as unknown as {
              confirm: boolean
              content?: string
            }
            if (!modal.confirm) return
            const title = (modal.content ?? '').trim()
            if (!title) return
            await renameSession(session.session_id, title)
            refreshHistory()
            return
          }
          if (result.tapIndex === 1) {
            const modal = await Taro.showModal({
              title: '删除会话',
              content: '删除后不可恢复，确定继续？',
              confirmText: '删除',
              confirmColor: '#d33',
            })
            if (!modal.confirm) return
            await deleteSession(session.session_id)
            if (sessionIdRef.current === session.session_id) {
              // 删掉的正是当前会话：清场回空态，下一条消息懒建新会话。
              clearPersisted(ownerIdRef.current)
              batcherRef.current?.drop()
              streamRef.current?.close()
              streamRef.current = null
              pollRef.current?.stop()
              pollRef.current = null
              fallbackRef.current = false
              cursorRef.current = 0
              sessionIdRef.current = ''
              setSessionId('')
              setItems([])
              itemsRef.current = []
              setConfirms([])
              setQuestions([])
              setTurnActive(false)
              setTurnStatus(undefined)
              setConnection('idle')
            }
            refreshHistory()
          }
        })
        .catch((error) => {
          // 用户取消（showActionSheet reject）静默；真实网络/服务错误如实上横幅。
          if (error instanceof ApiError) setErrorText(error.message)
        })
    },
    [refreshHistory],
  )

  const handleOpenAssets = useCallback((): void => {
    setDrawerOpen(false)
    setAssetsSignal((value) => value + 1)
  }, [])

  const handleOpenSettings = useCallback((): void => {
    setDrawerOpen(false)
    void Taro.navigateTo({ url: '/pages/mine/index' })
  }, [])

  const handleKey = useCallback(() => {
    void Taro.showToast({ title: '请在网页版管理 API 密钥', icon: 'none' })
  }, [])

  const handleTopUp = useCallback(() => {
    void Taro.navigateTo({ url: '/pages/pricing/index' })
  }, [])

  const handleLogout = useCallback(() => {
    void Taro.showModal({
      title: '退出登录',
      content: '小程序使用微信登录，退出后将重新建立匿名会话。',
      success: (result) => {
        if (!result.confirm) return
        void ensureLogin()
          .then((next) => {
            setUser(next)
            void Taro.showToast({ title: '已刷新登录态', icon: 'none' })
          })
          .catch((error) => {
            setErrorText(error instanceof Error ? error.message : '登录失败，请稍后重试')
          })
      },
    })
  }, [])

  const userName = user?.display_name || user?.username || 'Eimu 用户'
  const userSubtitle = user?.email || (user ? `ID ${user.id}` : '未登录')

  return (
    <PageBoundary>
      <View className='agent-page'>
      <View
        className='agent-page-card'
        style={{
          paddingTop: `calc(${statusBarHeight}px + 64px)`,
          paddingLeft: '12px',
          paddingRight: '12px',
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <AgentChatSurface
          items={items}
          confirms={confirms}
          questions={questions}
          connection={connection}
          closedReason={closedReason}
          errorText={errorText}
          booting={booting}
          turnActive={turnActive}
          turnStatus={turnStatus}
          sending={sending}
          stopPending={stopPending}
          sessionStarting={sessionStarting}
          pendingExample={pendingExample}
          draft={draft}
          onDraftChange={setDraft}
          onSend={handleSend}
          onStop={() => void handleStop()}
          onConfirm={(requestId, approved) => void handleConfirm(requestId, approved)}
          onAnswerQuestion={handleAnswerQuestion}
          onExampleSend={handleExampleSend}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={handleThinkingLevelChange}
          onRetry={handleRetry}
          anchor={anchor}
          onAnchor={handleAnchor}
          onReanchor={handleReanchor}
          onAnchorDismiss={handleAnchorDismiss}
          anchorBusy={anchorBusy}
          openAssetsSignal={assetsSignal}
          onOpenProjects={() => setDrawerOpen(true)}
          history={{
            sessions: historySessions,
            loadError: historyError,
            currentSessionId: sessionId || null,
            switchingTo,
            startingNew: sessionStarting,
            onOpen: refreshHistory,
            onPick: handlePickSession,
            onStartNew: handleStartNewSession,
            onRowAction: handleSessionRowAction,
          }}
        />
      </View>

      <Navbar
        user={user}
        statusBarHeight={statusBarHeight}
        onOpenDrawer={() => setDrawerOpen(true)}
        onTopUp={handleTopUp}
        onKey={handleKey}
        onLogout={handleLogout}
      />

      <MobileDrawer
        open={drawerOpen}
        userName={userName}
        userSubtitle={userSubtitle}
        onClose={() => setDrawerOpen(false)}
        statusBarHeight={statusBarHeight}
        currentSessionId={sessionId || null}
        onPickSession={handlePickSession}
        onStartNew={handleStartNewSession}
        onOpenAssets={handleOpenAssets}
        onOpenSettings={handleOpenSettings}
        onOpenPricing={handleTopUp}
      />
      </View>
    </PageBoundary>
  )
}
