import { Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import type { BatchAnchor } from './agent-batch-anchor'

/**
 * D-26 首张锚定卡。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentAnchorCard.tsx:27-113。
 * 两颗按钮都只是「送一句话进对话」，没有隐藏后端调用。
 */

export interface AgentAnchorCardProps {
  anchor: BatchAnchor
  onAnchor: () => void
  onReanchor: () => void
  onDismiss: () => void
  busy?: boolean
}

export function AgentAnchorCard({ anchor, onAnchor, onReanchor, onDismiss, busy = false }: AgentAnchorCardProps) {
  // 只展示前 4 项，卡片是「锚什么」的摘要不是参数表（:29-30）。
  const preview = anchor.params.slice(0, 4)
  const rest = anchor.params.length - preview.length

  return (
    <View className='agent-rise lg-sheet relative overflow-hidden rounded-ios-2xl p-3.5'>
      <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
      <View className='flex items-start gap-3'>
        <View className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-muted-foreground'>
          <Icon name='anchor-a52' className='h-4 w-4' />
        </View>
        <View className='min-w-0 flex-1'>
          <Text className='text-ios-subhead font-semibold text-foreground'>
            第 {anchor.seq} 张出来了，就按这张的风格出完整批？
          </Text>
          <Text className='mt-0.5 text-sm leading-[1.55] text-muted-foreground'>
            锚定后整批沿用同一套参数，第 100 张不会跟第 1 张跑偏。
          </Text>
          {preview.length > 0 ? (
            <View className='mt-2 flex flex-wrap gap-1.5'>
              {preview.map((param) => (
                <Text
                  key={param.key}
                  className='min-w-0 rounded-full bg-black/5 px-2.5 py-1 text-sm leading-[1.4] text-muted-foreground break-words'
                >
                  {param.label} {param.value}
                </Text>
              ))}
              {rest > 0 ? (
                <Text className='rounded-full bg-black/5 px-2.5 py-1 text-sm leading-[1.4] text-muted-foreground'>
                  另 {rest} 项
                </Text>
              ) : null}
            </View>
          ) : null}
          {/* 上游截断过就说出来（:68-73）。 */}
          {anchor.truncated ? (
            <Text className='mt-1.5 text-sm text-foreground/45'>上游只回传了参数摘要，可能有参数锚不住</Text>
          ) : null}
        </View>
      </View>

      {/* 窄屏：次按钮并排在上，主按钮整行垫底（:77-113）。 */}
      <View className='mt-3 flex flex-col gap-2'>
        <View className='flex w-full gap-2'>
          <View
            className={cn(
              'min-h-11 flex-1 rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors duration-150',
              busy && 'opacity-40',
            )}
            onClick={() => {
              if (!busy) onDismiss()
            }}
          >
            <Text>不用了</Text>
          </View>
          <View
            className={cn(
              'inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-black/5 px-4 text-sm font-semibold text-muted-foreground transition-colors duration-150',
              busy && 'opacity-40',
            )}
            onClick={() => {
              if (!busy) onReanchor()
            }}
          >
            <Icon name='refresh-cw-a52' className='h-3.5 w-3.5' />
            <Text>换个方向</Text>
          </View>
        </View>
        <View
          className={cn(
            'inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-full bg-[#2d3142] px-5 text-ios-subhead font-semibold text-white shadow-[0_8px_20px_rgba(45,49,66,0.18)] transition-all duration-200',
            busy && 'bg-black/[0.12] text-foreground/45 shadow-none',
          )}
          onClick={() => {
            if (!busy) onAnchor()
          }}
        >
          <Text>就按这张</Text>
        </View>
      </View>
    </View>
  )
}
