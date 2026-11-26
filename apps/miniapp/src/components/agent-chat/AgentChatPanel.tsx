import { useEffect, useState } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import { AgentAnchorCard } from './AgentAnchorCard'
import { AgentBatchProgress } from './AgentBatchProgress'
import { AgentComposer } from './AgentComposer'
import { AgentQuestionCard } from './AgentQuestionCard'
import { AgentSubagentBar } from './AgentSubagentBar'
import { AgentTranscript, type AgentTranscriptProps } from './AgentTranscript'
import { AgentConfirmCard } from './AgentConfirmCard'
import { AgentSubagentView } from './AgentSubagentView'
import { useHideAgentReasoning } from '../../lib/agent-display-preferences'
import type { BatchAnchor } from './agent-batch-anchor'
import type {
  AgentConnection,
  AgentItem,
  AgentPendingConfirm,
  AgentPendingQuestion,
  ThinkingLevel,
} from './types'

/**
 * 对话面板。结构 / 类名逐行复制自 src/components/agent-chat/AgentChatPanel.tsx：
 *   - 空态        :536-598（含 2026-10-01 光晕 548-555、H2 558、chips 562-596）
 *   - 转录区      :526-634
 *   - 确认卡      :673-703 + AgentConfirmCard.tsx:106-170
 *   - 输入区摆位  :429-473 / 722-730
 */

export const AGENT_EXAMPLE_PROMPTS = [
  '画一只戴帽子的橘猫，水彩风格',
  '让这瓶香水出现在落日海滩，自然光',
  '把我这篇小说改成成片，先给我分镜表',
] as const

export interface AgentChatPanelProps {
  items: AgentItem[]
  sessionId?: string | null
  onSendText?: (text: string) => void | Promise<void>
  imageActions?: AgentTranscriptProps['imageActions']
  videoActions?: AgentTranscriptProps['videoActions']
  audioActions?: AgentTranscriptProps['audioActions']
  confirms: AgentPendingConfirm[]
  /** 待回答的 opencode question（AgentChatPanel.tsx:705-719）。 */
  questions: AgentPendingQuestion[]
  connection: AgentConnection
  closedReason?: string
  errorText: string
  booting: boolean
  turnActive: boolean
  turnStatus?: string
  sending: boolean
  stopPending: boolean
  sessionStarting: boolean
  pendingExample: string | null
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>
  onAnswerQuestion: (requestId: string, answers: string[][]) => Promise<boolean | void>
  onExampleSend: (text: string) => void
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange: (level: ThinkingLevel) => void
  onRetry: () => void
  /** D-26 首张锚定（AgentChatPanel.tsx:651-660）。 */
  anchor?: BatchAnchor | null
  onAnchor?: () => void
  onReanchor?: () => void
  onAnchorDismiss?: () => void
  anchorBusy?: boolean
}

export function AgentChatPanel({
  items,
  sessionId,
  onSendText,
  imageActions,
  videoActions,
  audioActions,
  confirms,
  questions,
  connection,
  closedReason,
  errorText,
  booting,
  turnActive,
  turnStatus,
  sending,
  stopPending,
  sessionStarting,
  pendingExample,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onConfirm,
  onAnswerQuestion,
  onExampleSend,
  thinkingLevel,
  onThinkingLevelChange,
  onRetry,
  anchor = null,
  onAnchor,
  onReanchor,
  onAnchorDismiss,
  anchorBusy = false,
}: AgentChatPanelProps) {
  const hideReasoning = useHideAgentReasoning()
  const [viewingRun, setViewingRun] = useState<Extract<AgentItem, { kind: 'subagent' }> | null>(null)
  useEffect(() => setViewingRun(null), [sessionId])
  const isEmpty = items.length === 0 && connection !== 'reconnecting' && connection !== 'closed'
  const last = items[items.length - 1]
  const subagentItems = items.filter(
    (item): item is Extract<AgentItem, { kind: 'subagent' }> => item.kind === 'subagent',
  )

  const composer = (
    <View className='agent-composer-anchor max-sm:px-1'>
      <AgentComposer
        sessionId={sessionId}
        onSendText={onSendText}
        value={draft}
        onChange={onDraftChange}
        onSend={onSend}
        onStop={onStop}
        turnActive={turnActive}
        sending={sending}
        stopPending={stopPending}
        disabled={connection === 'closed'}
        thinkingLevel={thinkingLevel}
        onThinkingLevelChange={onThinkingLevelChange}
      />
    </View>
  )

  const anchorId = `agent-bottom-${items.length}-${turnStatus ?? ''}-${turnActive ? 1 : 0}`

  const activeViewingRun = subagentItems.find((item) => item.subagentId === viewingRun?.subagentId) ?? viewingRun
  if (activeViewingRun) return <AgentSubagentView key={`${sessionId}:${activeViewingRun.subagentId}`} item={activeViewingRun} sessionId={sessionId} onBack={() => setViewingRun(null)} />

  return (
    <View className='agent-panel'>
      {connection === 'reconnecting' || (connection === 'closed' && closedReason) ? (
        <View className='agent-panel-status flex items-center gap-2 px-0.5 pb-2 pt-1 max-sm:px-1'>
          <View
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              connection === 'closed' ? 'bg-destructive' : 'bg-foreground/35',
            )}
          />
          <Text className='text-ios-caption1 font-medium text-foreground/45'>
            {connection === 'closed' ? '会话已结束' : '正在重新连接…'}
          </Text>
          {connection === 'reconnecting' ? (
            <View
              className='ml-auto inline-flex items-center gap-1.5 rounded-full bg-ios-blue/10 px-3 py-1 text-ios-caption1 font-semibold text-ios-blue'
              onClick={onRetry}
            >
              <Icon name='rotate-cw-blue' className='h-3 w-3' />
              <Text>重试</Text>
            </View>
          ) : null}
          {connection === 'closed' && closedReason ? (
            <Text className='ml-auto min-w-0 truncate text-ios-caption1 text-foreground/45'>
              原因：{closedReason}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* D-26：批量愿望的燃烧进度常驻在顶部（AgentChatPanel.tsx:507-510）。 */}
      <View className='pb-1 max-sm:px-1'>
        <AgentBatchProgress items={items} onStop={onStop} stopPending={stopPending} />
      </View>

      {/* 罪状 4：子代理状态栏，置顶于转录区之上（AgentChatPanel.tsx:512-516）。 */}
      <View className='pb-1 max-sm:px-1'>
        <AgentSubagentBar items={subagentItems} sessionId={sessionId} onOpenRun={setViewingRun} />
      </View>

      <View className='relative flex min-h-0 min-w-0 flex-1 flex-col'>
        {isEmpty ? (
          // 空态不滚（Nothing to scroll）：用 flex 置中替代网页端 ScrollView 内的
          // min-h-full——小程序 scroll-view 的百分比高度不可靠，这是平台差异白名单
          // 之外唯一的布局等价替换，内部 JSX 与 AgentChatPanel.tsx:543-598 逐行一致。
          // 外层 max-sm:px-1 = transcript 的窄屏 gutter（4px），保证输入卡宽度与网页同源。
          <View className='flex min-h-0 flex-1 flex-col max-sm:px-1'>
          <View className='relative flex min-h-0 flex-1 flex-col items-center justify-center px-5'>
            {/* 空态淡虹彩光晕（AgentChatPanel.tsx:548-555） */}
            <View
              className='pointer-events-none absolute left-1/2 top-1/2 h-full max-h-[520px] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2'
              style={{
                background:
                  'radial-gradient(closest-side at 50% 42%, rgba(140,123,240,0.13), transparent 70%), radial-gradient(closest-side at 26% 58%, rgba(91,141,239,0.11), transparent 72%), radial-gradient(closest-side at 74% 60%, rgba(229,141,186,0.11), transparent 72%)',
              }}
            />
            <View className='relative flex w-full flex-col items-center'>
              <Text className='text-2xl font-semibold tracking-tight text-foreground'>想做点什么？</Text>
              <View className='mt-8 w-full'>{composer}</View>
              <View className='mt-5 flex w-full flex-wrap items-center justify-center gap-2'>
                {AGENT_EXAMPLE_PROMPTS.map((example) => {
                  const isPending = pendingExample === example
                  const disabled = sessionStarting || turnActive || sending
                  return (
                    <View
                      key={example}
                      className={cn(
                        'min-h-11 rounded-full border border-white/80 bg-white/45 px-4 py-2 text-ios-footnote font-medium text-foreground/70 shadow-[0_2px_10px_rgba(140,123,240,0.06)] backdrop-blur-md',
                        'transition-all duration-200',
                        disabled ? 'opacity-50' : 'active:bg-white/75',
                        isPending && 'inline-flex items-center gap-1.5',
                      )}
                      onClick={() => {
                        if (!disabled) onExampleSend(example)
                      }}
                    >
                      {isPending ? <Icon name='loader-2-a60' className='ic-spin h-3.5 w-3.5 shrink-0' /> : null}
                      <Text>{example}</Text>
                    </View>
                  )
                })}
              </View>
            </View>
          </View>
          </View>
        ) : (
          <ScrollView
            scrollY
            className='agent-transcript min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-0.5 pb-2 pt-0 max-sm:px-1'
            style={{ height: 0 }}
            scrollIntoView={anchorId}
            scrollWithAnimation
          >
            <AgentTranscript items={items} turnStatus={turnStatus} sessionId={sessionId} hideReasoning={hideReasoning} onSend={onSendText} imageActions={imageActions} videoActions={videoActions} audioActions={audioActions} />

            {turnActive && last?.kind !== 'assistant' ? (
              <View className='agent-thinking flex items-center gap-2 px-1 py-2 max-sm:px-0'>
                <View className='flex items-end gap-[3px]'>
                  {[0, 160, 320].map((delay) => (
                    <View
                      key={delay}
                      className='inline-block animate-bounce rounded-full bg-black/[0.22]'
                      style={{ width: 6, height: 6, animationDelay: `${delay}ms`, animationDuration: '1.1s' }}
                    />
                  ))}
                </View>
                <Text className='text-ios-caption1 text-foreground/45'>正在思考…</Text>
              </View>
            ) : null}

            <View id={anchorId} className='h-1 w-full' />
          </ScrollView>
        )}
      </View>

      {errorText ? (
        <View className='agent-surface-error mb-2 flex shrink-0 items-center justify-between gap-3 rounded-ios-2xl bg-destructive/[0.08] px-3.5 py-2.5'>
          <Text className='min-w-0 flex-1 text-sm text-destructive'>{errorText}</Text>
          <View
            className='agent-surface-retry shrink-0 rounded-full bg-destructive/[0.14] px-3 py-1 text-ios-caption1 font-semibold text-destructive'
            onClick={onRetry}
          >
            <Text>重试</Text>
          </View>
        </View>
      ) : null}

      {/* D-26 首张锚定：紧贴输入区上方，和确认卡互斥（AgentChatPanel.tsx:651-660）。 */}
      {anchor && confirms.length === 0 && questions.length === 0 && onAnchor && onReanchor && onAnchorDismiss ? (
        <View className='pb-1.5'>
          <AgentAnchorCard
            anchor={anchor}
            onAnchor={onAnchor}
            onReanchor={onReanchor}
            onDismiss={onAnchorDismiss}
            busy={anchorBusy}
          />
        </View>
      ) : null}

      {confirms.length > 0 ? (
        <View className='agent-scroll-thin min-h-0 min-w-0 max-h-[min(62dvh,30rem)] shrink-0 overflow-x-hidden overflow-y-auto px-0.5 pb-1.5 max-sm:px-1'>
          <View className='flex flex-col gap-2'>
            {confirms.map((confirm) => (
              <AgentConfirmCard key={confirm.requestId} confirm={confirm} onConfirm={onConfirm} busy={confirm.resolving} contextText={[...items].reverse().find((item) => item.kind === 'assistant')?.kind === 'assistant' ? ([...items].reverse().find((item) => item.kind === 'assistant') as Extract<AgentItem, { kind: 'assistant' }>).text : ''} />
            ))}
          </View>
        </View>
      ) : null}

      {/* 问答卡：与确认卡同一套溢出防护容器；串行一次只出一张（AgentChatPanel.tsx:705-719）。 */}
      {confirms.length === 0 && questions.length > 0 ? (
        <View className='agent-scroll-thin min-h-0 min-w-0 max-h-[min(62dvh,30rem)] shrink-0 overflow-x-hidden overflow-y-auto px-0.5 pb-1.5 max-sm:px-1'>
          <View className='flex flex-col gap-2'>
            {questions.slice(0, 1).map((question) => (
              <AgentQuestionCard key={question.requestId} question={question} onAnswer={onAnswerQuestion} />
            ))}
          </View>
        </View>
      ) : null}

      {isEmpty ? null : composer}

      {/* 屏幕阅读器宣告（AgentChatPanel.tsx:644-646） */}
      <Text className='sr-only'>{turnActive ? '助手正在输入…' : '助手回复完成'}</Text>
      {booting && isEmpty ? <Text className='sr-only'>正在准备对话…</Text> : null}
    </View>
  )
}
