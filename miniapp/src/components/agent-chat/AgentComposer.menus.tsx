import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import {
  THINKING_LEVEL_HINTS,
  THINKING_LEVEL_LABELS,
  type ThinkingLevel,
} from './types'

/**
 * 工具行下拉（小程序版）。
 *
 * 网页版 src/components/agent-chat/AgentComposer.menus.tsx 用 createPortal + fixed
 * 量座标；小程序没有 document/portal（平台差异白名单），改为「相对触发钮的
 * absolute bottom-full 内联浮层 + fixed 透明遮罩点外收起」。材质类名
 * （agent-pop / rounded-[18px] / 顶缘高光线 / z-[85]）逐项照抄。
 */

/** 选项列：标题＋说明行（两行都直接可见）→ 选中时右端勾。 */
export function MenuOptionRow({
  title,
  subtitle,
  selected,
  disabled,
  onClick,
}: {
  title: string
  subtitle: string
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <View
      className={cn(
        'flex w-full items-start gap-2 rounded-[12px] px-2.5 py-2',
        disabled && 'opacity-50',
        selected && 'bg-ios-blue/[0.10]',
      )}
      onClick={() => {
        if (!disabled) onClick()
      }}
    >
      <View className='flex min-w-0 flex-col'>
        <Text className='whitespace-nowrap text-ios-footnote font-medium text-foreground'>{title}</Text>
        <Text className='mt-0.5 max-w-[15rem] text-ios-caption2 leading-snug text-foreground/50'>
          {subtitle}
        </Text>
      </View>
      {selected ? <Icon name='check-green' className='ml-auto h-3.5 w-3.5 shrink-0' /> : null}
    </View>
  )
}

/**
 * 思考级别菜单：收起态＝脑图标＋级别字＋小 chevron（零框零底零影）；
 * 展开态＝四档清单（标题＋说明＋勾）。状态由父层持有（页面已接
 * fetchAgentThinkingLevel / saveAgentThinkingLevel），本层只受控渲染。
 *
 * 工具行不再另放硬编码的「中」语言钮：思考级别自身带下拉且显示当前档位，
 * 两颗「中」并排会被误读成两个语言控件。
 */
export function ThinkingLevelMenu({
  level,
  onChange,
  disabled,
}: {
  level: ThinkingLevel
  onChange: (level: ThinkingLevel) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = THINKING_LEVEL_LABELS[level]

  return (
    <View className='relative ml-0.5 shrink-0'>
      <View
        className={cn(
          'flex w-max min-h-11 shrink-0 items-center gap-1 whitespace-nowrap leading-none text-foreground/60',
          disabled && 'opacity-40',
        )}
        onClick={() => {
          if (!disabled) setOpen((value) => !value)
        }}
      >
        <Icon name='brain-a60' className='h-4 w-4 shrink-0' />
        <Text className='whitespace-nowrap text-ios-footnote font-medium'>{label}</Text>
        <Icon
          name='chevron-down-a60'
          className={cn('h-3.5 w-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-180')}
        />
      </View>

      {open ? <View className='fixed inset-0 z-[84]' onClick={() => setOpen(false)} /> : null}
      {open ? (
        <View className='agent-pop absolute bottom-full left-0 z-[85] mb-2 w-max max-h-[min(60vh,22rem)] overflow-y-auto rounded-[18px] p-1.5'>
          <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
          {(Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map((item) => (
            <MenuOptionRow
              key={item}
              title={THINKING_LEVEL_LABELS[item]}
              subtitle={THINKING_LEVEL_HINTS[item]}
              selected={item === level}
              onClick={() => {
                onChange(item)
                setOpen(false)
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}
