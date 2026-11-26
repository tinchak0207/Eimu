import { useCallback, useEffect, useRef, useState } from 'react'
import { Input, Text, View } from '@tarojs/components'
import { activateAgentAssetPack, listAgentAssets, type AgentAssetPack, type AgentSessionSummary } from '../../lib/agent'
import { AgentChatPanel, type AgentChatPanelProps } from './AgentChatPanel'
import { AgentSessionList } from './AgentSessionList'
import { Icon } from './icons'
import { useTemporaryChat } from '../../lib/agent-temporary-chat'

/**
 * 聊天区外壳。结构逐行复制自 src/components/agent-chat/AgentChatSurface.tsx:336-345
 * （根 div：agent-chat-surface + flex min-h-0 flex-1 flex-col overflow-hidden pb-1）
 * 与 :359-604（顶栏）；手机端五颗既有钮全部 max-sm:hidden，唯一可见的是
 * CanvasChatWorkstation.tsx:95-107 的「项目」入口（headerExtra），这里接汉堡抽屉。
 *
 * 「我的资产」面板（:82-85 / :244-254 / :367-379 / :540-601）不是独立页，
 * 由顶栏按钮打开；小程序端保留同一入口与同一浮层结构，数据走 /api/assets。
 * 「历史会话」同构迁移（AgentSessionList 三态 + 相对时间 + 状态点）。
 */

/** 历史会话抽屉的数据与动作（页面持有数据源，外壳只负责浮层）。 */
export interface AgentHistoryPanelProps {
  sessions: AgentSessionSummary[] | null
  loadError?: string | null
  currentSessionId: string | null
  switchingTo?: string | null
  startingNew?: boolean
  /** 首次打开 / 每次打开时通知页面拉目录。 */
  onOpen?: () => void
  onPick: (sessionId: string) => void
  onStartNew: () => void
  /** 长按某行（重命名 / 删除菜单）。 */
  onRowAction?: (session: AgentSessionSummary) => void
}

export type AgentChatSurfaceProps = AgentChatPanelProps & {
  onOpenProjects: () => void
  onStartTemporary?: () => void
  /**
   * 抽屉「我的资产」的受控开关：值变化且 >0 时打开资产浮层。
   * 顶栏按钮行为不变（仍走 toggleAssets）。
   */
  openAssetsSignal?: number
  /** 历史会话浮层；缺席＝不显示入口（并行开发期间保持向后兼容）。 */
  history?: AgentHistoryPanelProps
}

export function AgentChatSurface({
  onOpenProjects,
  onStartTemporary,
  openAssetsSignal = 0,
  history,
  ...panelProps
}: AgentChatSurfaceProps) {
  const temporaryChat = useTemporaryChat(panelProps.sessionId)
  // null = 未加载，[] = 已加载但为空（AgentChatSurface.tsx:82-85）。
  const [showAssets, setShowAssets] = useState(false)
  const [assetPacks, setAssetPacks] = useState<AgentAssetPack[] | null>(null)
  const [assetQuery, setAssetQuery] = useState('')
  const [activatingPackId, setActivatingPackId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')

  /** 拉资产列表（失败保留原列表 / 空列表，不弹错）。 */
  const loadAssets = useCallback((query: string): void => {
    void listAgentAssets(query)
      .then((packs) => setAssetPacks(packs))
      .catch(() => setAssetPacks((previous) => previous ?? []))
  }, [])

  // 抽屉入口（MobileDrawer onOpenAssets）→ 打开同一张浮层并按需拉全量。
  // 只在信号真的变化且 >0 时触发，挂载时 signal=0 不动作。
  const lastAssetsSignalRef = useRef(openAssetsSignal)
  useEffect(() => {
    if (openAssetsSignal <= 0) return
    if (lastAssetsSignalRef.current === openAssetsSignal) return
    lastAssetsSignalRef.current = openAssetsSignal
    setShowAssets(true)
    loadAssets(assetQuery)
    // assetQuery 只作首拉词，不作为重开触发器（打字由 handleAssetQuery 负责）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAssetsSignal, loadAssets])

  /** 我的资产：开关。首次打开拉全量（session-actions.ts:167-181）。 */
  const toggleAssets = useCallback((): void => {
    const next = !showAssets
    setShowAssets(next)
    if (next) setShowHistory(false)
    if (!next) return
    loadAssets(assetQuery)
  }, [assetQuery, loadAssets, showAssets])

  /** 历史会话：开关。每次打开通知页面拉目录（服务端为准）。 */
  const toggleHistory = useCallback((): void => {
    const next = !showHistory
    setShowHistory(next)
    if (next) {
      setShowAssets(false)
      setHistoryQuery('')
      history?.onOpen?.()
    }
  }, [history, showHistory])

  /** 选中历史会话＝收起浮层再切换。 */
  const pickHistorySession = useCallback(
    (sessionId: string): void => {
      setShowHistory(false)
      history?.onPick(sessionId)
    },
    [history],
  )

  /** 空态 CTA：收起浮层再开新对话。 */
  const startNewFromHistory = useCallback((): void => {
    setShowHistory(false)
    history?.onStartNew()
  }, [history])

  /** 搜索：输入即拉（网页版 300ms debounce，小程序同一端点）。 */
  const handleAssetQuery = useCallback((value: string): void => {
    setAssetQuery(value)
    void listAgentAssets(value)
      .then((packs) => setAssetPacks(packs))
      .catch(() => undefined)
  }, [])

  /** 使用此包：把该包 active:true 写回，成功后收面板（session-actions.ts:200-220）。 */
  const handleActivate = useCallback(
    (pack: AgentAssetPack): void => {
      if (activatingPackId !== null) return
      setActivatingPackId(pack.id)
      void activateAgentAssetPack(pack)
        .then((ok) => {
          if (ok) setShowAssets(false)
        })
        .finally(() => setActivatingPackId(null))
    },
    [activatingPackId],
  )

  return (
    <View className='agent-chat-surface flex min-h-0 flex-1 flex-col overflow-hidden pb-1'>
      <View className='flex shrink-0 flex-col pb-2'>
        <View className='flex flex-wrap items-center gap-x-1 gap-y-1 max-sm:justify-between'>
          {/* 左簇：资产按钮（AgentChatSurface.tsx:367-379）。网页端 max-sm:hidden，
              小程序是唯一的窄屏形态，这里按同一按钮样式常显。 */}
          <View className='flex items-center gap-0.5 max-sm:contents'>
            <View
              className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/45'
              onClick={toggleAssets}
            >
              <Icon name='box-a45' className='h-[1.125rem] w-[1.125rem]' />
            </View>
            {history ? (
              <View
                className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/45'
                onClick={toggleHistory}
              >
                <Icon name='library-a45' className='h-[1.125rem] w-[1.125rem]' />
              </View>
            ) : null}
          </View>

          {/* 右簇：max-sm:contents 后唯一的项目钮成为外层 flex item，靠 justify-between
              落在最左（与 p1 顶栏下方那颗文件夹图标同位置）。 */}
          <View className='ml-auto flex items-center gap-0.5 max-sm:contents'>
            {temporaryChat.temporary ? <Text className='rounded-full bg-ios-blue/[0.12] px-2 py-0.5 text-ios-caption2 font-medium text-ios-blue'>临时对话 · 不记忆</Text> : null}
            {onStartTemporary ? <View className='flex min-h-11 items-center justify-center rounded-full px-2 text-ios-caption1 text-foreground/45' onClick={onStartTemporary}><Text>临时对话</Text></View> : null}
            <View
              className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/45'
              onClick={onOpenProjects}
            >
              <Icon name='folder-kanban-a45' className='h-[1.125rem] w-[1.125rem]' />
            </View>
          </View>
        </View>
      </View>

      {/* 历史会话下拉浮层：与资产浮层同一套材料与开合语义。 */}
      {showHistory && history ? (
        <View className='fixed inset-0 z-40' onClick={() => setShowHistory(false)}>
          <View
            className='agent-pop agent-pop-in fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-72 -translate-x-1/2 rounded-[18px] p-1.5'
            onClick={(event) => event.stopPropagation()}
          >
            <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
            <Text className='px-2.5 pt-2 pb-1 text-ios-caption1 font-medium text-foreground/60'>历史会话</Text>
            <View className='relative px-2.5 pb-1'>
              <Input
                value={historyQuery}
                onInput={(event) => setHistoryQuery(event.detail.value)}
                placeholder='搜索对话…'
                className='w-full rounded-lg border border-input bg-black/5 py-1.5 pl-7 pr-3 text-ios-caption1 outline-none transition-colors'
              />
              <Icon
                name='search-a40'
                className='pointer-events-none absolute left-[13px] top-1/2 h-3.5 w-3.5 -translate-y-1/2'
              />
            </View>
            <View className='agent-pop-scroll max-h-72 overflow-y-auto overscroll-contain px-1 pb-1'>
              <AgentSessionList
                sessions={history.sessions}
                loadError={history.loadError}
                currentSessionId={history.currentSessionId}
                switchingTo={history.switchingTo}
                startingNew={history.startingNew}
                query={historyQuery}
                onPick={pickHistorySession}
                onStartNew={startNewFromHistory}
                onRowAction={history.onRowAction}
              />
            </View>
          </View>
        </View>
      ) : null}

      {/* 资产下拉浮层（AgentChatSurface.tsx:540-601）：点外即收。 */}
      {showAssets ? (
        <View className='fixed inset-0 z-40' onClick={() => setShowAssets(false)}>
          <View
            className='agent-pop agent-pop-in fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-64 -translate-x-1/2 rounded-[18px] p-1.5'
            onClick={(event) => event.stopPropagation()}
          >
            {/* DESIGN.md §5：每张 sheet 都要有一条顶缘高光线（:545-546）。 */}
            <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
            <Text className='px-2.5 pt-2 pb-1 text-ios-caption1 font-medium text-foreground/60'>我的资产</Text>
            <View className='relative px-2.5 pb-1'>
              <Input
                value={assetQuery}
                onInput={(event) => handleAssetQuery(event.detail.value)}
                placeholder='搜索资产…'
                className='w-full rounded-lg border border-input bg-black/5 py-1.5 pl-7 pr-3 text-ios-caption1 outline-none transition-colors'
              />
              <Icon
                name='search-a40'
                className='pointer-events-none absolute left-[13px] top-1/2 h-3.5 w-3.5 -translate-y-1/2'
              />
            </View>
            {assetPacks === null ? (
              <Text className='px-2.5 py-3 text-center text-ios-caption1 text-foreground/45'>
                正在加载资产…
              </Text>
            ) : assetPacks.length === 0 ? (
              <Text className='px-2.5 py-3 text-center text-ios-caption1 text-foreground/45'>
                还没有保存过资产
              </Text>
            ) : (
              <View className='agent-pop-scroll max-h-64 overflow-y-auto overscroll-contain'>
                {assetPacks.map((pack) => {
                  const activating = activatingPackId === pack.id
                  return (
                    <View
                      key={pack.id}
                      className='flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors'
                    >
                      <View className='flex min-w-0 flex-1 flex-col gap-0.5'>
                        <Text className='block truncate text-ios-caption1 font-medium text-muted-foreground'>
                          {pack.title}
                        </Text>
                        <Text className='block truncate text-ios-caption2 text-foreground/45'>
                          {pack.items.length} 项
                          {pack.digest
                            ? ` · ${pack.digest.slice(0, 48)}${pack.digest.length > 48 ? '…' : ''}`
                            : ''}
                        </Text>
                      </View>
                      <View
                        className='shrink-0 rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue'
                        onClick={() => handleActivate(pack)}
                      >
                        <Text>{activating ? '使用中…' : '使用此包'}</Text>
                      </View>
                    </View>
                  )
                })}
              </View>
            )}
            <Text className='px-2.5 pt-1 pb-1.5 text-ios-caption2 text-foreground/35'>
              新会话将携带此资产包
            </Text>
          </View>
        </View>
      ) : null}

      <View className='flex min-h-0 flex-1 flex-col'>
        <AgentChatPanel {...panelProps} />
      </View>
    </View>
  )
}
