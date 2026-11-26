import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import type { AgentItem } from './types'

/**
 * 系统提示行。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentNoticeRow.tsx:25-63：
 * 图标 + 文案 + 可关闭按钮（44×44）；错误红 / 普通灰。
 * 平台差异（白名单第 2 条）：prefersReducedMotion 读 window.matchMedia 的部分去掉，
 * 入场动画沿用既有 .agent-rise。
 */

type NoticeItem = Extract<AgentItem, { kind: 'notice' }>

export interface AgentNoticeRowProps {
  item: NoticeItem
}

export function AgentNoticeRow({ item }: AgentNoticeRowProps) {
  const isError = item.tone === 'error'
  const [dismissed, setDismissed] = useState(false)

  // 使用者点掉提示：本机隐藏（资料模型不动，下次新 notice 是新 key 的新行；:31-32）。
  if (dismissed) return null

  return (
    <View
      className={cn(
        'agent-rise flex w-full items-start gap-1.5 rounded-ios-2xl py-1 pl-3.5 pr-1.5 text-ios-footnote leading-[1.5]',
        isError ? 'text-ios-red' : 'text-muted-foreground',
      )}
    >
      <Icon
        name={isError ? 'alert-triangle-red' : 'info-a45'}
        className='mt-3 h-4 w-4 shrink-0'
      />
      <Text className='flex min-h-11 min-w-0 flex-1 items-center break-words py-1'>
        {item.text}
      </Text>
      {/* 可关闭：点掉让提示让路；44×44 触控目标（:53-61）。 */}
      <View
        className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground/45'
        onClick={() => setDismissed(true)}
      >
        <Icon name='x-a45' className='h-4 w-4' />
      </View>
    </View>
  )
}
