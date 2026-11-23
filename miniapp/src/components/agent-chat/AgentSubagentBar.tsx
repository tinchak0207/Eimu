import { useState } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import { toolDisplayName } from './tool-names'
import type { AgentItem, AgentSubagentToolEntry } from './types'

/**
 * 顶部子代理条。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentSubagentBar.tsx：
 *   - 折叠头          :553-567（「派出 N 个子代理」+ ChevronDown）
 *   - SubagentCard    :446-495（Bot / 标签 / 末行 / 状态词 / 状态点）
 *   - SubagentToolLines :427-444
 *   - SubagentDetailPanel :379-418（本地记录兜底路径 sessionId 缺席时的 JSX）
 * 平台差异（白名单）：跑马灯量测用 DOM（scrollLeft / ResizeObserver），小程序改为
 * 单行 truncate；远端子代理列表与转录轮询属于额外端点，本页只渲染帧内条目。
 */

type SubagentItem = Extract<AgentItem, { kind: 'subagent' }>

const STATUS_DOT: Record<SubagentItem['status'], string> = {
  running: 'bg-ios-blue',
  ok: 'bg-foreground/60',
  error: 'bg-ios-red',
  stopped: 'bg-muted-foreground',
}

const STATUS_WORD: Record<SubagentItem['status'], string> = {
  running: '运行中…',
  ok: '完成',
  error: '失败',
  stopped: '已停止',
}

const STATUS_WORD_TONE: Record<SubagentItem['status'], string> = {
  running: 'text-ios-blue',
  ok: 'text-foreground/45',
  error: 'text-ios-red',
  stopped: 'text-foreground/45',
}

const TOOL_STATUS_DOT: Record<AgentSubagentToolEntry['status'], string> = {
  running: 'bg-ios-blue',
  ok: 'bg-foreground/40',
  failed: 'bg-ios-red',
}

const TOOL_STATUS_WORD: Record<AgentSubagentToolEntry['status'], string> = {
  running: '运行中…',
  ok: '完成',
  failed: '失败',
}

const TOOL_STATUS_WORD_TONE: Record<AgentSubagentToolEntry['status'], string> = {
  running: 'text-ios-blue',
  ok: 'text-foreground/45',
  failed: 'text-ios-red',
}

/** 子代理工具活动区（AgentSubagentBar.tsx:427-444）。 */
function SubagentToolLines({ entries }: { entries: AgentSubagentToolEntry[] }) {
  const running = entries.filter((entry) => entry.status === 'running')
  const visible = (running.length > 0 ? running : entries.slice(-1)).slice(0, 3)
  if (visible.length === 0) return null
  return (
    <View className='flex min-w-0 flex-col gap-0.5 pb-1 pl-7'>
      {visible.map((entry) => (
        <View key={entry.callId} className='flex min-w-0 items-center gap-1.5 text-ios-footnote text-muted-foreground'>
          <View className={cn('h-1 w-1 shrink-0 rounded-full', TOOL_STATUS_DOT[entry.status])} />
          <Text className='min-w-0 flex-1 truncate'>{toolDisplayName(entry.tool)}</Text>
          <Text className={cn('shrink-0 whitespace-nowrap', TOOL_STATUS_WORD_TONE[entry.status])}>
            {TOOL_STATUS_WORD[entry.status]}
          </Text>
        </View>
      ))}
    </View>
  )
}

/** 本地记录兜底（AgentSubagentBar.tsx:397-404：sessionId 缺席时的既有分支）。 */
function SubagentDetailPanel({ item }: { item: SubagentItem }) {
  const fallbackText = item.text || item.activity || item.lastLine || ''
  return (
    <View className='flex min-w-0 flex-col gap-1 pb-1 pl-7 pr-2'>
      <ScrollView scrollY style={{ height: '256px' }} className='agent-scroll-thin min-w-0 overflow-y-auto overflow-x-hidden'>
        <View className='flex min-w-0 flex-col gap-1'>
          {fallbackText ? (
            <Text className='whitespace-pre-wrap break-words text-ios-footnote text-muted-foreground'>
              {fallbackText}
            </Text>
          ) : (
            <Text className='text-ios-footnote text-foreground/45'>暂无记录。</Text>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

function SubagentCard({
  item,
  open,
  onToggle,
}: {
  item: SubagentItem
  open: boolean
  onToggle: () => void
}) {
  return (
    <View className='flex min-w-0 w-full flex-col'>
      {/* 整行即按钮（:450-490）。 */}
      <View
        className='agent-rise flex min-h-11 min-w-0 w-full items-center gap-2 rounded-[12px] px-2 -mx-2 text-left'
        onClick={onToggle}
      >
        <Icon name='bot-a40' className='h-4 w-4 shrink-0' />
        <Text className='min-w-0 max-w-[45%] text-ios-footnote font-medium text-foreground/80 break-words'>
          {item.label}
        </Text>
        {/* running：活动流末行；settled：静态摘要（:466-474）。 */}
        <Text className='min-w-0 flex-1 truncate text-ios-footnote text-muted-foreground'>
          {item.summary ?? item.lastLine ?? (item.status === 'running' ? item.activity || '正在输出…' : '')}
        </Text>
        <Text className={cn('shrink-0 whitespace-nowrap text-ios-footnote tabular-nums', STATUS_WORD_TONE[item.status])}>
          {STATUS_WORD[item.status]}
        </Text>
        <View className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[item.status])} />
      </View>
      {item.status === 'running' ? <SubagentToolLines entries={item.tools ?? []} /> : null}
      {open ? <SubagentDetailPanel item={item} /> : null}
    </View>
  )
}

export interface AgentSubagentBarProps {
  items: SubagentItem[]
  initialOpen?: boolean
}

export function AgentSubagentBar({ items, initialOpen = false }: AgentSubagentBarProps) {
  // G3（2026-10-10）：默认折叠；手动展开优先于任何自动行为（:508-512）。
  const [open, setOpen] = useState(initialOpen)
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  if (items.length === 0) return null

  return (
    <View className='relative flex flex-col gap-0.5'>
      <View
        className='flex min-h-11 w-fit items-center gap-1.5 rounded-[12px] px-2 -mx-2 text-left text-ios-footnote font-medium text-muted-foreground'
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name='bot-a40' className='h-3.5 w-3.5 shrink-0' />
        <Text>派出 {items.length} 个子代理</Text>
        {/* 网页版 chevron 是 text-foreground/45；PNG 只有 a35/a60 两档，a60×0.75≈45%（平台白名单）。 */}
        <Icon
          name='chevron-down-a60'
          className={cn('lg-transition h-3.5 w-3.5 shrink-0 opacity-75', open && 'rotate-180')}
        />
      </View>
      {open
        ? items.map((item) => (
            <SubagentCard
              key={item.id}
              item={item}
              open={openRunId === item.subagentId}
              onToggle={() => setOpenRunId((current) => (current === item.subagentId ? null : item.subagentId))}
            />
          ))
        : null}
    </View>
  )
}
