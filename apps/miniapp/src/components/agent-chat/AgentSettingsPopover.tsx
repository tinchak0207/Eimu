import { useCallback, useEffect, useRef, useState } from 'react'
import { Slider, Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import {
  INTERACTION_MODES,
  getAgentSettings,
  readCachedAgentSettings,
  saveAgentSettings,
  writeCachedAgentSettings,
  type AgentInteractionMode,
  type AgentSettings,
} from '../../lib/agent'
import { Icon } from './icons'
import { MySkillsDialog } from './MySkillsDialog'
import { MyMemoriesDialog } from './MyMemoriesDialog'
import { setHideAgentReasoning, useHideAgentReasoning } from '../../lib/agent-display-preferences'

/**
 * 助理设定弹层（照 src/components/agent-chat/AgentSettingsPopover.tsx 的 2026-10-03
 * 定案）：只留两行——「我的技能」（自建 Skill 管理入口）与「互动模式」。
 *
 * 中途输入 / 模型性格 / 成本需求 / 野兽模式 四列已收拢到输入框工具行的
 * 「思考级别」菜单（AgentComposer.menus.tsx），本层不再暴露它们的 UI；
 * settings 五栏与送往网关的 payload 形状不变。
 *
 * 状态三层（照抄）：
 *   ① Taro storage 缓存（agent-settings-v1）是发送链路的即时数据源；
 *   ② 挂载时 GET /api/agent/settings 回读合并（失败静默，设定不可用不挡聊天）；
 *   ③ 改值走 saveAgentSettings：写缓存 + 异步持久化，网络失败不打扰对话。
 * 三层的唯一实作在 lib/agent-settings.ts（本档只消费，不另写第二套）。
 *
 * 平台差异（白名单）：trigger/popover 用 View 浮层；原生 range → Taro Slider。
 */

/** 三档显示名（UI 文案；枚举真源＝lib/agent-settings.ts 的 INTERACTION_MODES）。 */
const INTERACTION_TIERS = ['协作', '预设', '自动'] as const

/** 文案＝机制真话（照抄网页版）：三个停点/整包/连扣费都放行。 */
const INTERACTION_HINTS: Record<AgentInteractionMode, string> = {
  collaborate: '协作：剧本/资产/分镜三步停下等你确认，确认后自动续跑，其余环节自动',
  preset: '预设：一次整包授权，一路跑完，只有扣费与关键决策拦你',
  auto: '自动：一键发送直出结果，连扣费确认都自动放行，全程不问你',
}

export interface AgentSettingsPopoverProps {
  /** 触发钮的额外类名（由宿主顶栏决定位置时使用）。 */
  className?: string
}

export function AgentSettingsPopover({ className }: AgentSettingsPopoverProps) {
  const hideReasoning = useHideAgentReasoning()
  const [memoriesOpen, setMemoriesOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [saveError, setSaveError] = useState('')
  const aliveRef = useRef(true)
  /** 「我的技能」管理面：同一入口再开一张 lg-sheet，不造第二个入口。 */
  const [skillsOpen, setSkillsOpen] = useState(false)
  // 初值直接吃本地缓存：弹层打开立即是用户上次的值，不等网络。
  const [settings, setSettings] = useState<AgentSettings>(() => readCachedAgentSettings())

  const reload = useCallback(() => {
    setLoadState('loading')
    void getAgentSettings().then((result) => {
      if (!aliveRef.current) return
      if (!result.ok) { setLoadState('error'); return }
      setSettings(result.settings)
      writeCachedAgentSettings(result.settings)
      setLoadState('ok')
    })
  }, [])
  useEffect(() => { aliveRef.current = true; reload(); return () => { aliveRef.current = false } }, [reload])
  useEffect(() => { if (open) { setSaveError(''); reload() } }, [open, reload])
  const update = useCallback((delta: Partial<AgentSettings>) => {
    if (loadState !== 'ok') return
    const before = settings
    setSettings({ ...before, ...delta })
    setSaveError('')
    void saveAgentSettings(delta).then((result) => {
      if (!aliveRef.current) return
      if (result.ok) setSettings(result.settings)
      else { setSettings(before); setSaveError('保存失败，未生效') }
    })
  }, [loadState, settings])

  const interactionIndex = Math.max(0, INTERACTION_MODES.indexOf(settings.interaction_mode))
  const interactionMode = INTERACTION_MODES[interactionIndex] ?? 'preset'

  return (
    <View className={cn('relative', className)}>
      {/* 触发钮：与历史/开新对话/收起同一套图标语法（44px 触控区）。 */}
      <View
        className='flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-foreground/45'
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name='sliders-horizontal-a45' className='h-4 w-4' />
      </View>

      {open ? (
        <>
          {/* 点外收起（网页 pointerdown + contains 的小程序等价物）。 */}
          <View className='fixed inset-0 z-40' onClick={() => setOpen(false)} />
          <View className='agent-pop agent-pop-in fixed left-1/2 top-[var(--agent-pop-top,5rem)] z-50 w-64 -translate-x-1/2 rounded-[18px] p-1.5'>
            <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />

            {/* a0) 我的技能：站内没有公开市集，自己的技能打「/」就能直呼；入口只此一处。 */}
            <View className='px-2.5 py-2.5'>
              <View className='flex items-center justify-between gap-3'>
                <Text className='text-ios-footnote font-medium text-foreground'>我的技能</Text>
                <View
                  className='rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue'
                  onClick={() => setSkillsOpen(true)}
                >
                  <Text>管理</Text>
                </View>
              </View>
              <Text className='mt-1 block text-ios-caption2 leading-relaxed text-foreground/45'>
                把你自己的做法存成技能，输入框打「/」就能直呼
              </Text>
            </View>

            <View className='h-px bg-black/[0.06]' />

            <View className='px-2.5 py-2.5'>
              <View className='flex items-center justify-between gap-3'>
                <Text className='text-ios-footnote font-medium text-foreground'>我的记忆</Text>
                <View className='rounded-full px-2 py-0.5 text-ios-caption1 font-medium text-ios-blue' onClick={() => setMemoriesOpen(true)}><Text>管理</Text></View>
              </View>
              <Text className='mt-1 block text-ios-caption2 leading-relaxed text-foreground/45'>看看助理记住了你什么，随时改、随时删</Text>
            </View>
            <View className='px-2.5 py-2.5'>
              <View className='flex items-center justify-between gap-3'>
                <Text className='text-ios-footnote font-medium text-foreground'>隐藏思维链</Text>
                <View className='flex h-11 w-11 shrink-0 items-center rounded-lg' onClick={() => setHideAgentReasoning(!hideReasoning)}>
                  <View className={cn('relative h-6 w-11 rounded-full', hideReasoning ? 'bg-ios-blue' : 'bg-black/15')}>
                    <View className={cn('absolute top-1 h-4 w-4 rounded-full bg-white shadow', hideReasoning ? 'left-6' : 'left-1')} />
                  </View>
                </View>
              </View>
              <Text className='mt-1 block text-ios-caption2 leading-relaxed text-foreground/45'>只显示回答和任务进度</Text>
            </View>
            {loadState === 'error' ? <View className='px-2.5 text-ios-caption2 text-ios-red' onClick={reload}><Text>设置读取失败，暂不能修改 · 重试</Text></View> : null}
            {saveError ? <Text className='block px-2.5 text-ios-caption2 text-ios-red'>{saveError}</Text> : null}
            {/* d) 互动模式：三档滑条，当前档位点亮刻度点。 */}
            <View className='px-2.5 py-2.5'>
              <View className='flex items-center justify-between gap-3'>
                <Text className='text-ios-footnote font-medium text-foreground'>互动模式</Text>
                <Text className='text-ios-caption1 font-medium text-ios-blue'>
                  {INTERACTION_TIERS[interactionIndex]}
                </Text>
              </View>
              <View className='mt-2'>
                <Slider
                  disabled={loadState !== 'ok'}
                  min={0}
                  max={2}
                  step={1}
                  value={interactionIndex}
                  activeColor='#007AFF'
                  backgroundColor='rgba(0,0,0,0.12)'
                  blockColor='#ffffff'
                  blockSize={20}
                  onChange={(event) => {
                    const next = INTERACTION_MODES[Number(event.detail.value)]
                    if (next) update({ interaction_mode: next })
                  }}
                />
              </View>
              {/* 三个刻度点：当前档位点亮。 */}
              <View className='mt-1 flex justify-between px-1'>
                {INTERACTION_TIERS.map((tier, index) => (
                  <View
                    key={tier}
                    className={cn('h-1 w-1 rounded-full', index === interactionIndex ? 'bg-ios-blue' : 'bg-black/20')}
                  />
                ))}
              </View>
              <Text className='mt-1 block text-ios-caption2 leading-relaxed text-foreground/45'>
                {INTERACTION_HINTS[interactionMode]}
              </Text>
            </View>
          </View>
        </>
      ) : null}

      {/* 管理面：无公开市集，只有「我自己的技能」。 */}
      {skillsOpen ? <MySkillsDialog onClose={() => setSkillsOpen(false)} /> : null}
      {memoriesOpen ? <MyMemoriesDialog onClose={() => setMemoriesOpen(false)} /> : null}
    </View>
  )
}
