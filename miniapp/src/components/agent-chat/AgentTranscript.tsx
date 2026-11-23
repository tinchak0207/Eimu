import { useEffect, useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { AgentAudioCard } from './AgentAudioCard'
import { AgentDirectorCard } from './AgentDirectorCard'
import { AgentImageCard, AgentImageGroup } from './AgentImageCard'
import { AgentMessageBubble } from './AgentMessageBubble'
import { AgentNoticeRow } from './AgentNoticeRow'
import { AgentSubagentReportCard } from './AgentSubagentReportCard'
import { AgentToolCard } from './AgentToolCard'
import { AgentVideoCard } from './AgentVideoCard'
import { Icon } from './icons'
import type { AgentItem, AgentToolAuthScope } from './types'

/**
 * 对话流（真源：src/components/agent-chat/AgentTranscript.tsx，160 行）。
 *
 * 2026-10-21 拆档：原先 447 行的内联版把气泡/工具卡/图片卡全塞在本档，
 * 现在按网页版结构拆成 AgentMessageBubble / AgentToolCard / AgentImageCard
 * （及附件卡、参数抽屉）各自独立，本档只负责「条目 → 元件」的分派。
 * 计划卡（AgentPlanCard）结构简单，仍留在本档，与网页版同宽独立成条。
 */

const TURN_GAP = 'flex flex-col gap-5'

type ImageItem = Extract<AgentItem, { kind: 'image' }>

/** 连续多张出图合并成一个网格段（单张仍走 AgentImageCard 的完整动作条）。 */
type Segment = { kind: 'item'; item: AgentItem } | { kind: 'image-group'; items: ImageItem[] }

function segmentItems(items: AgentItem[]): Segment[] {
  const segments: Segment[] = []
  let index = 0
  while (index < items.length) {
    const item = items[index]
    if (item.kind === 'image') {
      const run: ImageItem[] = [item]
      let next = index + 1
      while (next < items.length && items[next].kind === 'image') {
        run.push(items[next] as ImageItem)
        next += 1
      }
      if (run.length > 1) {
        segments.push({ kind: 'image-group', items: run })
        index = next
        continue
      }
    }
    segments.push({ kind: 'item', item })
    index += 1
  }
  return segments
}

function PlanCard({ item }: { item: Extract<AgentItem, { kind: 'plan' }> }) {
  const [open, setOpen] = useState(!item.collapsed)
  const manualRef = useRef(false)
  const prevCollapsed = useRef(item.collapsed)

  // 只认 false → true（结算时自动收合）；手动 toggle 优先。
  useEffect(() => {
    const was = prevCollapsed.current
    prevCollapsed.current = item.collapsed
    if (manualRef.current) return
    if (was !== true && item.collapsed === true) setOpen(false)
  }, [item.collapsed])

  const experts = item.experts ?? []
  const collapsedPreview = `${item.text.slice(0, 40)}…`

  return (
    <View className='agent-rise flex w-full flex-col'>
      <View
        className='-mx-1 flex min-h-11 w-full items-start gap-2.5 rounded-[18px] px-1 py-[7px]'
        onClick={() => {
          manualRef.current = true
          setOpen((value) => !value)
        }}
      >
        <Icon name='brain-a40' className='mt-0.5 h-4 w-4 shrink-0' />
        <View className='grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2.5'>
          <Text className='text-ios-footnote font-medium text-foreground/80'>计划</Text>
          {open ? (
            <Text className='whitespace-pre-wrap break-words text-ios-subhead leading-[1.55] text-foreground'>
              {item.text}
            </Text>
          ) : (
            <Text className='truncate text-ios-subhead leading-[1.55] text-foreground/50'>{collapsedPreview}</Text>
          )}
          {open && experts.length > 0 ? (
            <View className='col-start-2 mt-1.5 flex flex-wrap gap-1.5'>
              {experts.map((expert) => (
                <Text
                  key={expert}
                  className='inline-flex min-w-0 max-w-full items-center rounded-full bg-black/[0.05] px-2 py-0.5 text-ios-footnote text-muted-foreground'
                >
                  {expert}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
        <Icon
          name='chevron-down-a60'
          className={cn('mt-0.5 h-4 w-4 shrink-0 transition-transform duration-200', open && 'rotate-180')}
        />
      </View>
    </View>
  )
}

export interface AgentTranscriptProps {
  items: AgentItem[]
  /** 网关暂态状态行（turn.status）：新状态替换旧行，真实内容/turn.done 即清。 */
  turnStatus?: string
  /** 当前会话 id：透传给用户气泡的附件卡铸读取票。 */
  sessionId?: string | null
  /** 出图卡动作回调的预留通道：接线前缺省，按钮保持 disabled / 内置保存。 */
  imageActions?: {
    onSaveToLibrary?: (item: ImageItem) => Promise<boolean>
    onEdit?: (item: ImageItem) => Promise<boolean>
    onDownload?: (item: ImageItem) => Promise<boolean>
    onRerun?: (item: ImageItem) => void
    onRerunVariant?: (item: ImageItem) => void
  }
  /** 本机文件授权回传（小程序无本机文件通道，保留签名）。 */
  onAuthorizeLocalFiles?: (scope: AgentToolAuthScope, root?: string) => void | Promise<void>
}

export function AgentTranscript({ items, turnStatus, sessionId, imageActions, onAuthorizeLocalFiles }: AgentTranscriptProps) {
  const segments = segmentItems(items)

  return (
    <View className={TURN_GAP}>
      {segments.map((segment) => {
        if (segment.kind === 'image-group') {
          return (
            <AgentImageGroup
              key={`image-group-${segment.items[0].id}`}
              items={segment.items}
              onSaveToLibrary={imageActions?.onSaveToLibrary}
            />
          )
        }

        const item = segment.item
        switch (item.kind) {
          case 'user':
          case 'assistant':
            return <AgentMessageBubble key={item.id} item={item} sessionId={sessionId} />
          case 'plan':
            return <PlanCard key={item.id} item={item} />
          case 'tool':
            return <AgentToolCard key={item.id} item={item} onAuthorize={onAuthorizeLocalFiles} />
          case 'image':
            return <AgentImageCard key={item.id} item={item} {...imageActions} />
          case 'video':
            return <AgentVideoCard key={item.id} item={item} />
          case 'audio':
            return <AgentAudioCard key={item.id} item={item} />
          case 'director':
            return <AgentDirectorCard key={item.id} item={item} />
          case 'notice':
            return <AgentNoticeRow key={item.id} item={item} />
          case 'subagent':
            // 子代理条目不进消息流：由面板顶部 AgentSubagentBar 负责。
            return null
          case 'subagent_result':
            return <AgentSubagentReportCard key={item.id} item={item} />
          default:
            return null
        }
      })}
      {turnStatus ? (
        // 网页版这一行只有一个空的 .agent-turn-status-dot span（agent-chat.css 没有它的样式，
        // 实际不画任何点）；小程序端不新造圆点，保持与网页版同一条灰字状态行。
        <View className='agent-turn-status text-ios-caption1 text-muted-foreground'>
          <Text>{turnStatus}</Text>
        </View>
      ) : null}
    </View>
  )
}
