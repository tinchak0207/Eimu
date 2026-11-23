import { Text, View } from '@tarojs/components'
import './agent-batch-progress.scss'
import { Icon } from './icons'
import type { AgentItem } from './types'

/**
 * 批量许愿进度。结构 / 类名逐行复制自
 * src/components/agent-chat/AgentBatchProgress.tsx:50-122：
 * 只从 transcript 派生（image 条目数 / tool.costCoins 累加），总数未知时不假装百分比。
 * 平台差异（白名单第 2 条）：网页版 <style>{INDETERMINATE_CSS}</style> 内联样式块
 * 在 weapp 不可用，同样的 CSS 放进 component-scoped scss（app.scss 不在本轮所有权内）。
 */

export interface AgentBatchProgressProps {
  items: AgentItem[]
  total?: number
  onStop?: () => void
  stopPending?: boolean
}

/** 币值格式化（AgentBatchProgress.tsx:33-38）。 */
function formatCoins(n: number): string {
  if (Number.isInteger(n)) return String(n)
  if (Math.abs(n) >= 1) return n.toFixed(2)
  return String(Math.max(0, Math.floor(n * 1e5) / 1e5))
}

const isQuoteTool = (tool: string): boolean => /quote/i.test(tool)

export function AgentBatchProgress({ items, onStop, stopPending = false, total }: AgentBatchProgressProps) {
  let images = 0
  let coins = 0

  for (const item of items) {
    if (item.kind === 'image') {
      images += 1
    } else if (
      item.kind === 'tool' &&
      typeof item.costCoins === 'number' &&
      item.status !== 'failed' &&
      !isQuoteTool(item.tool)
    ) {
      // 报价类回的是估价不是扣费；失败工具同理不算花费（:57-62）。
      coins += item.costCoins
    }
  }

  if (images === 0 && coins === 0) return null

  // 有真实分母才谈百分比（:68-70）。
  const hasTotal = typeof total === 'number' && Number.isFinite(total) && total > 0
  const totalCount = hasTotal ? (total as number) : 0
  const pct = hasTotal ? Math.min(100, Math.round((images / totalCount) * 100)) : 0

  return (
    <View className='agent-rise flex flex-col'>
      {hasTotal ? (
        <View className='h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]'>
          <View className='lg-transition h-full rounded-full bg-ios-blue' style={{ width: pct + '%' }} />
        </View>
      ) : (
        <View className='agent-batch-indeterminate' />
      )}
      <View className='mt-1.5 flex min-h-11 items-center justify-between gap-2'>
        <Text className='min-w-0 flex-1 truncate text-ios-footnote leading-[1.4] text-muted-foreground'>
          正在生成 {images} 张
          {hasTotal ? ' / 共 ' + totalCount + ' 张 · 已完成 ' + pct + '%' : ''}
          {coins !== 0 ? ' · 已用 ' + formatCoins(coins) + ' 币' : ''}
        </Text>
        {onStop ? (
          <View
            className='flex min-h-11 shrink-0 items-center rounded-lg px-2.5 text-ios-footnote font-medium text-ios-red/85'
            onClick={() => {
              if (!stopPending) onStop()
            }}
          >
            {stopPending ? <Icon name='loader-2-red' className='ic-spin mr-1 h-3.5 w-3.5' /> : null}
            <Text>停止</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}
