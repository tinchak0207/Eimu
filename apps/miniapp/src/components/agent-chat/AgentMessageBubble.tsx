import { useEffect, useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { AgentAttachmentCards, parseUserAttachmentBlock } from './AgentAttachmentCards'
import { AgentMarkdown } from './AgentMarkdown'
import { Icon, type IconName } from './icons'
import type { AgentItem, AgentSteerStatus } from './types'

/**
 * 消息气泡（真源：src/components/agent-chat/AgentMessageBubble.tsx，247 行）。
 *
 * - 助手正文走 AgentMarkdown（表格/粗体/列表/代码块；图片直链转缩略图、行内代码弱化）；
 * - 思维链默认收合（流式中展开，结算后自动收成「已思考 · N 秒」一行；手动 toggle 优先）；
 * - 思维链一键复制（Taro.setClipboardData）；steer 六态徽章；
 * - 用户消息里的 [ATTACHMENTS_BLOCK] 摘成附件卡（罪状 1）。
 */

type BubbleItem = Extract<AgentItem, { kind: 'user' | 'assistant' }>

/** REQ-D2：steer 状态 → 人话（六态都必须说清「生效了没有」）。 */
function steerStatusLabel(status: AgentSteerStatus, position?: number): string {
  switch (status) {
    case 'queued':
      return `引导已排队${typeof position === 'number' ? `（第 ${position} 条）` : ''}·本回合结束后生效`
    case 'injected':
      return '引导已注入本回合'
    case 'applied':
      return '引导已生效'
    case 'aborted':
      return '引导已中止（未生效）'
    case 'failed':
      return '引导未能送达（未生效）'
    case 'uncertain':
      return '引导未确认（未重送）'
  }
}

/** steer 徽章的语义色。 */
function steerTone(status: AgentSteerStatus): { tone: string; icon: IconName } {
  if (status === 'injected' || status === 'applied') return { tone: 'text-ios-green', icon: 'navigation-green' }
  if (status === 'aborted' || status === 'failed') return { tone: 'text-ios-red/80', icon: 'navigation-red' }
  if (status === 'uncertain') return { tone: 'text-ios-orange', icon: 'navigation-orange' }
  return { tone: 'text-foreground/45', icon: 'navigation-a45' }
}

export interface AgentMessageBubbleProps {
  item: BubbleItem
  hideReasoning?: boolean
  onSend?: (text: string) => void
  /** 当前会话 id：附件卡铸读取票的兜底（path 自带会话段时无需）。 */
  sessionId?: string | null
}

export function AgentMessageBubble({ item, sessionId, hideReasoning = false, onSend }: AgentMessageBubbleProps) {
  const isUser = item.kind === 'user'

  // 罪状 1：用户消息里的 [ATTACHMENTS_BLOCK] 不再以裸文本示人。
  // 解析结果永远以 cleanText 为准（不能因为 refs 为空就退回原文——那正是
  // 未摘净的 JSON 尾巴漏进气泡的路径）。
  const userParsed = isUser ? parseUserAttachmentBlock(item.text) : null
  const hasAttachments = userParsed !== null && userParsed.refs.length > 0
  const suppressed = userParsed !== null && userParsed.suppressed
  const displayText = userParsed !== null ? userParsed.cleanText : item.text

  // 思维链：流式中展开、结算后自动收合；使用者手动点过就不再自动介入。
  const reasoningStreaming = item.kind === 'assistant' && item.streaming === true
  const [reasoningOpen, setReasoningOpen] = useState(reasoningStreaming)
  const reasoningTouched = useRef(false)
  useEffect(() => {
    if (!reasoningStreaming && !reasoningTouched.current) setReasoningOpen(false)
  }, [reasoningStreaming])

  const [reasoningCopied, setReasoningCopied] = useState(false)
  const copyReasoning = (): void => {
    if (item.kind !== 'assistant' || !item.reasoning) return
    void Taro.setClipboardData({ data: item.reasoning })
      .then(() => {
        setReasoningCopied(true)
        setTimeout(() => setReasoningCopied(false), 1500)
      })
      .catch(() => {
        // 剪贴板不可用时静默失败（用户仍可手动选取复制）。
      })
  }

  // 收合行文案：已结算＝「已思考 · N 秒」（至少 1 秒），还在想＝「正在思考…」，
  // 无计时资料＝「已思考」——不编秒数。
  const reasoningMs = item.kind === 'assistant' ? item.reasoningMs : undefined
  const reasoningLabel =
    reasoningMs !== undefined
      ? `已思考 · ${Math.max(1, Math.round(reasoningMs / 1000))} 秒`
      : item.kind === 'assistant' && item.streaming
        ? '正在思考…'
        : '已思考'

  // 内部注入（收件箱/后台命令通知）或摘不干净的脏正文：整段不回显，
  // 连气泡壳都不留——它本来就不是用户说的话。
  if (isUser && suppressed && !hasAttachments) return null
  if (hideReasoning && item.kind === 'assistant' && item.reasoning && !displayText.trim()) return null

  return (
    <View className={cn('agent-rise flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <View
        className={cn(
          'agent-turn-text min-w-0 break-words text-[0.9375rem]',
          isUser ? 'whitespace-pre-wrap max-w-[85%]' : 'w-full',
          isUser
            ? 'ml-auto rounded-[20px] rounded-br-[6px] lg-float px-3.5 py-2.5 text-foreground leading-[1.45]'
            : 'text-foreground leading-[1.55]',
        )}
      >
        {item.kind === 'assistant' && item.reasoning && !hideReasoning ? (
          <View className='mb-1.5'>
            <View
              className='brain-summary flex min-h-11 items-center gap-1.5 text-ios-footnote font-medium text-muted-foreground'
              onClick={() => {
                reasoningTouched.current = true
                setReasoningOpen((value) => !value)
              }}
            >
              <Icon name='brain-a40' className='h-3.5 w-3.5 shrink-0' />
              <Text>{reasoningLabel}</Text>
              <Icon
                name='chevron-down-a35'
                className={cn('brain-chevron h-3.5 w-3.5 shrink-0 transition-transform', reasoningOpen && 'rotate-180')}
              />
              <View
                className='ml-1 flex h-7 w-7 items-center justify-center rounded-full'
                onClick={(event) => {
                  event.stopPropagation()
                  copyReasoning()
                }}
                aria-label='复制思考过程'
              >
                <Icon name={reasoningCopied ? 'check-green' : 'copy-a40'} className='h-3.5 w-3.5' />
              </View>
            </View>
            {reasoningOpen ? (
              <View className='lg-float mt-1 whitespace-pre-wrap break-words rounded-[14px] px-3 py-2.5 text-ios-footnote leading-[1.6] text-muted-foreground'>
                <Text className='whitespace-pre-wrap break-words'>{item.reasoning}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 空文本时用零宽空格撑住气泡高度，避免 streaming 首帧内容突跳。 */}
        {displayText ? (
          item.kind === 'assistant' ? (
            <AgentMarkdown text={displayText} isStreaming={item.streaming} onSend={onSend} />
          ) : (
            <Text className='whitespace-pre-wrap break-words'>{displayText}</Text>
          )
        ) : (
          <Text className='whitespace-pre-wrap'>{'\u200b'}</Text>
        )}

        {/* REQ-D2：回合中追加的指引（steer）状态徽章。 */}
        {item.kind === 'user' && item.steer ? (
          <View
            className={cn('mt-1.5 flex items-center gap-1 text-[0.75rem] leading-[1.4]', steerTone(item.steer.status).tone)}
            data-steer-status={item.steer.status}
          >
            <Icon name={steerTone(item.steer.status).icon} className='h-3 w-3 shrink-0' />
            <Text>{steerStatusLabel(item.steer.status, item.steer.position)}</Text>
          </View>
        ) : null}

        {/* 附件卡（罪状 1）：只在解析出附件时渲染。 */}
        {hasAttachments && userParsed !== null ? (
          <AgentAttachmentCards refs={userParsed.refs} sessionId={sessionId} />
        ) : null}

        {/* 串流中的打字光标：只在有可读正文时渲染（白字元撑不出游标）。 */}
        {item.kind === 'assistant' && item.streaming && displayText.trim().length > 0 ? (
          <View className='agent-caret' aria-hidden='true' />
        ) : null}
      </View>
    </View>
  )
}
