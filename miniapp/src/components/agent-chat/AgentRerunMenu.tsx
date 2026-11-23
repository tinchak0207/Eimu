import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'

/**
 * 影片／音频卡共用的「再来 N 组」小选单。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentRerunMenu.tsx:36-88。
 * 平台差异（白名单第 2 条）：document 点外即收改为覆盖层点击收起；
 * 档位与历史卡同源（HISTORY_RERUN_COUNT_OPTIONS = [1,2,3,5,8]）。
 */

export const RERUN_COUNT_OPTIONS = [1, 2, 3, 5, 8] as const

export interface AgentRerunMenuProps {
  label: string
  disabled?: boolean
  onPick: (count: number) => void
}

export function AgentRerunMenu({ label, disabled = false, onPick }: AgentRerunMenuProps) {
  const [open, setOpen] = useState(false)

  return (
    <View className='relative'>
      <View
        aria-label={label}
        className={cn(
          'flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote text-muted-foreground transition-colors',
          disabled && 'text-foreground/45',
        )}
        onClick={() => {
          if (!disabled) setOpen((previous) => !previous)
        }}
      >
        <Icon name='copy-plus-a45' className='h-3.5 w-3.5' />
        <Text>{label}</Text>
      </View>
      {open && !disabled ? (
        <View>
          {/* 点外面收起：透明覆盖层（对应网页版 document pointerdown）。 */}
          <View className='fixed inset-0 z-10' onClick={() => setOpen(false)} />
          <View className='absolute bottom-full left-0 z-20 mb-1 flex gap-1 rounded-lg bg-white/95 p-1 shadow-[0_6px_20px_rgba(31,34,48,0.12)] ring-1 ring-black/5 backdrop-blur-md'>
            {RERUN_COUNT_OPTIONS.map((count) => (
              <View
                key={count}
                aria-label={`再来 ${count} 组`}
                className='flex h-9 w-9 items-center justify-center rounded-md text-ios-footnote font-medium text-muted-foreground'
                onClick={() => {
                  setOpen(false)
                  onPick(count)
                }}
              >
                <Text>{count}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  )
}
