import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import type { AgentItem } from './types'

/**
 * 子代理产出卡（F3/F4）。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentSubagentReportCard.tsx:37-100：
 * 一行预览（truncate）+ 整行可点 + ChevronDown 旋转，展开区放全文。
 * 小程序没有 id/aria-controls 的 DOM 语义，展开态仍用同一套 grid-rows 0fr→1fr。
 */

type ReportItem = Extract<AgentItem, { kind: 'subagent_result' }>

export interface AgentSubagentReportCardProps {
  item: ReportItem
}

const STATUS_META: Record<ReportItem['status'], { label: string; badge: string }> = {
  ok: { label: '完成', badge: 'bg-black/[0.05] text-muted-foreground' },
  error: { label: '失败', badge: 'bg-ios-red/10 text-ios-red' },
  interrupted: { label: '已中止', badge: 'bg-black/[0.05] text-muted-foreground' },
  stopped: { label: '已停止', badge: 'bg-black/[0.05] text-muted-foreground' },
}

/** 预览行：全文的第一个非空行（渲染层截断，模型层保留全文；:30-35）。 */
export function reportPreview(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim().length > 0) return line.trim()
  }
  return ''
}

export function AgentSubagentReportCard({ item }: AgentSubagentReportCardProps) {
  const [open, setOpen] = useState(false)
  const meta = STATUS_META[item.status]
  const preview = reportPreview(item.text)

  return (
    <View className='agent-rise relative flex w-full flex-col gap-1 overflow-hidden rounded-[18px] bg-black/[0.03] px-3 py-2'>
      {/* 顶缘 specular 亮线（:45-49）。 */}
      <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
      <View
        className='flex w-full items-center gap-2 rounded-md'
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name='bot-a40' className='h-3.5 w-3.5 shrink-0' />
        <Text className='min-w-0 max-w-[45%] shrink-0 truncate text-ios-footnote font-semibold text-foreground'>
          {item.label}
        </Text>
        <Text className='min-w-0 flex-1 truncate text-ios-footnote text-muted-foreground'>
          {preview || '（无输出）'}
        </Text>
        <View
          className={cn(
            'inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-ios-caption2 font-semibold',
            meta.badge,
          )}
        >
          {item.status === 'ok' ? <Icon name='check-green' className='mr-0.5 h-3 w-3' /> : null}
          <Text>{meta.label}</Text>
        </View>
        <Icon
          name='chevron-down-a35'
          className={cn('h-3 w-3 shrink-0 transition-transform duration-300', open && 'rotate-180')}
        />
      </View>
      {/* 展开区：grid-rows 0fr→1fr（:85-97）。 */}
      <View
        className={cn(
          'grid grid-rows-[0fr] transition-[grid-template-rows] duration-300',
          open && 'grid-rows-[1fr]',
        )}
      >
        <View className='min-h-0 overflow-hidden'>
          <Text className='whitespace-pre-wrap break-words px-0.5 pb-1 pt-1.5 text-ios-footnote leading-relaxed text-muted-foreground'>
            {item.text || '（无输出）'}
          </Text>
        </View>
      </View>
    </View>
  )
}
