import { useMemo, useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import { parseToolParams } from './agent-tool-params'
import { Icon } from './icons'

/**
 * 工具参数折叠区（真源：src/components/agent-chat/AgentParamDisclosure.tsx，228 行）。
 *
 * 平台差异：网页版窄屏＝底部抽屉、宽屏＝就地手风琴；小程序只有窄屏一种布局，
 * 因此**只保留抽屉**（useIsNarrow / 键盘焦点还原 / body 滚动锁这些 DOM 细节去掉）。
 *
 * F2 铁律：默认渲染（DOM）里不许出现 raw JSON / 原始函数名——展开区在「首次展开」
 * 之前不挂载，参数一律先走 agent-tool-params 解析成人话 key：value。
 */

export interface ParamDisclosureApi {
  open: boolean
  toggle: () => void
}

export interface AgentParamDisclosureProps {
  argsSummary: string
  /** 抽屉的 DOM id 前缀，同一页多张卡不能撞。 */
  idPrefix: string
  /** 抽屉标题里的工具名，让人知道这张参数属于哪次调用。 */
  toolName?: string
  /** 该工具已结算的花费；未结算时不显示，绝不猜。 */
  costCoins?: number
  /** 整行触发器：宿主把整行交给这里渲染，点行即展开。 */
  trigger?: (api: ParamDisclosureApi) => ReactNode
}

/** 展示用的币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 参数行：key：value；一个参数都捞不到时退回原文（仍只在抽屉里）。 */
function ParamLines({ argsSummary, costCoins }: { argsSummary: string; costCoins?: number }) {
  const parsed = useMemo(() => parseToolParams(argsSummary), [argsSummary])
  const params = parsed?.params ?? []
  const raw = params.length === 0 ? parsed?.raw : undefined
  return (
    <View className='flex flex-col gap-1'>
      {params.map((param) => (
        <Text
          key={param.key}
          className='whitespace-pre-wrap break-words text-ios-footnote leading-[1.5] text-muted-foreground'
        >
          <Text className='text-foreground/45'>{param.label}：</Text>
          {param.value}
        </Text>
      ))}
      {raw !== undefined ? (
        <Text className='whitespace-pre-wrap break-words font-mono text-ios-caption1 leading-[1.5] text-muted-foreground'>
          {raw}
        </Text>
      ) : null}
      {costCoins !== undefined ? (
        <Text className='text-ios-footnote leading-[1.5] text-muted-foreground'>
          <Text className='text-foreground/45'>消耗：</Text>
          {formatCoins(costCoins)} 币
        </Text>
      ) : null}
      {parsed?.truncated ? (
        <Text className='text-ios-caption1 leading-[1.5] text-foreground/45'>
          上游只回传了参数摘要，可能不完整
        </Text>
      ) : null}
    </View>
  )
}

export function AgentParamDisclosure({
  argsSummary,
  idPrefix,
  toolName,
  costCoins,
  trigger,
}: AgentParamDisclosureProps) {
  const [open, setOpen] = useState(false)
  // F2：首次展开前不挂载内容，默认渲染里没有 raw JSON / 原始函数名。
  const [everOpened, setEverOpened] = useState(false)

  const toggle = (): void => {
    setOpen((value) => !value)
    setEverOpened(true)
  }
  const close = (): void => setOpen(false)

  return (
    <>
      {trigger ? (
        trigger({ open, toggle })
      ) : (
        <View
          className='inline-flex min-h-11 w-fit items-center gap-1.5 self-start rounded-full px-2.5 text-ios-subhead font-medium text-ios-blue'
          onClick={toggle}
        >
          <Icon name='sliders-horizontal-a45' className='h-4 w-4' />
          <Text>查看参数</Text>
        </View>
      )}

      {open ? (
        <View
          // 遮罩与抽屉材质照网页版 .agent-param-scrim / .agent-param-drawer lg-sheet：
          // rgba(0,0,0,.28)+blur(2px)；抽屉限高 76dvh、20px 顶圆角、底补安全区。
          className='fixed inset-0 z-[110] flex flex-col justify-end bg-[rgba(0,0,0,0.28)] backdrop-blur-[2px]'
          onClick={close}
        >
          <View
            id={`${idPrefix}-params`}
            className='agent-param-drawer lg-sheet relative flex max-h-[76vh] flex-col rounded-t-[20px] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2'
            onClick={(event) => event.stopPropagation()}
          >
            <View className='mx-auto mb-2 h-1 w-9 rounded-full bg-black/[0.18]' />
            <View className='flex items-center gap-2 pb-2'>
              <Text className='min-w-0 flex-1 text-ios-subhead font-semibold text-foreground'>
                {toolName ? `${toolName} 的参数` : '这次用到的参数'}
              </Text>
              <View
                className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/5'
                onClick={close}
                aria-label='关闭参数'
              >
                <Icon name='x-a45' className='h-5 w-5' />
              </View>
            </View>
            <ScrollView scrollY className='min-h-0 flex-1' style={{ maxHeight: '60vh' }}>
              {everOpened && toolName !== undefined ? (
                <Text className='mb-1.5 block font-mono text-ios-caption1 text-foreground/45'>{toolName}</Text>
              ) : null}
              <ParamLines argsSummary={argsSummary} costCoins={costCoins} />
            </ScrollView>
          </View>
        </View>
      ) : null}
    </>
  )
}
