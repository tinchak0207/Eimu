import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { saveAgentMediaToHistory, downloadAgentMedia } from '../../lib/agent-media-history'
import { Icon } from './icons'
import { AgentRerunMenu } from './AgentRerunMenu'
import type { AgentItem } from './types'

/**
 * 出声卡。结构 / 类名逐行复制自 src/components/agent-chat/AgentAudioCard.tsx：
 *   - 抬头（封面/歌名/类别徽章） :148-178
 *   - 主操作 + 次要试听          :179-227
 *   - 歌词对齐行 / 金币行        :229-240
 *   - 动作条                     :241-278（AudioAction :43-76）
 * 平台差异（白名单第 2 条）：网页版 openLyricPlayer 跳 store 播放器，小程序改用
 * Taro.createInnerAudioContext 就地播放同一份音源；原生 <audio controls> 的控件
 * 外观不可移植（Taro Audio 的默认皮是灰色大块），改为同尺寸的试听条：
 * 渐变封面 + 波形进度 + 真实时长。波形不做真实解码（平台无 WebAudio 解码通道），
 * 用细轨道 + 实心进度条取代假波形柱（见下方进度轨道注释）。
 */

type AudioItem = Extract<AgentItem, { kind: 'audio' }>

export interface AgentAudioCardProps {
  item: AudioItem
  onSaveToLibrary?: (item: AudioItem) => Promise<boolean>
  onDownload?: (item: AudioItem) => Promise<boolean>
  onRerun?: (item: AudioItem, count: number) => void
  onVariant?: (item: AudioItem) => void
}

function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 从音频 URL 猜一个可读标题（与网页版 lyric-player-url.ts:46-57 同义）：
 * media-123.m4a / music-gen-xxx 这类机器名不冒充歌名，返回 undefined。
 * 小程序基础库不保证有 URL 构造器，这里用正则取 pathname。
 */
export function guessAudioTitleFromUrl(url: string): string | undefined {
  const path = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url)?.[1]
  if (!path) return undefined
  const base = path.split('/').pop() ?? ''
  const name = base.replace(/\.(m4a|mp3|wav|aac|ogg|flac)$/i, '')
  if (!name || /^media-\d+/i.test(name) || /^music-gen-/i.test(name)) return undefined
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** 秒 → 试听条时间（0:00 / 0:02）。 */
function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 试听条波形：柱高为静态样式，只按播放进度着色。
 * 平台差异（白名单第 4 条）：小程序没有 WebAudio 解码通道，拿不到真实振幅，
 * 保留与网页播放条同尺寸同版式的静态替代，不伪造真实波形。
 */

/** 出音频卡上的动作按钮（AgentAudioCard.tsx:43-76）。 */
function AudioAction({
  label,
  disabled,
  onClick,
  children,
  tone,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
  tone?: 'danger'
}) {
  return (
    <View
      aria-label={label}
      className={cn(
        'flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-ios-footnote transition-colors',
        disabled ? 'text-foreground/45' : 'text-muted-foreground',
        tone === 'danger' && 'text-destructive',
      )}
      onClick={() => {
        if (!disabled) onClick()
      }}
    >
      {children}
      <Text>{label}</Text>
    </View>
  )
}

export function AgentAudioCard({ item, onSaveToLibrary, onDownload, onRerun, onVariant }: AgentAudioCardProps) {
  const [failed, setFailed] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'loading' | 'saved' | 'failed'>('idle')
  const [downState, setDownState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [playing, setPlaying] = useState(false)
  const [currentSec, setCurrentSec] = useState(0)
  const [durationSec, setDurationSec] = useState(0)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const playerRef = useRef<Taro.InnerAudioContext | null>(null)

  // item.url 变化（同实例换曲）时重置加载态与播放器，避免旧曲的时长/进度串台。
  useEffect(() => {
    setFailed(false)
    setPlaying(false)
    setCurrentSec(0)
    setDurationSec(0)
    playerRef.current?.destroy()
    playerRef.current = null
  }, [item.url])

  const flash = useCallback((apply: () => void, revert: () => void, delayMs: number) => {
    apply()
    timersRef.current.push(setTimeout(revert, delayMs))
  }, [])
  useEffect(() => {
    const timers = timersRef.current
    const player = playerRef
    return () => {
      timers.forEach(clearTimeout)
      player.current?.destroy()
      player.current = null
    }
  }, [])

  const handleRetry = (): void => {
    setFailed(false)
    setPlaying(false)
    setCurrentSec(0)
    setDurationSec(0)
    playerRef.current?.destroy()
    playerRef.current = null
  }

  const handleSave = useCallback(async () => {
    if (saveState === 'loading' || saveState === 'saved') return
    setSaveState('loading')
    let ok = false
    try {
      ok = onSaveToLibrary ? await onSaveToLibrary(item) : await saveAgentMediaToHistory(item)
    } catch {
      ok = false
    }
    if (ok) {
      setSaveState('saved')
      return
    }
    flash(() => setSaveState('failed'), () => setSaveState((s) => (s === 'failed' ? 'idle' : s)), 2000)
  }, [item, onSaveToLibrary, saveState, flash])

  const handleDownload = useCallback(async () => {
    if (downState === 'loading') return
    setDownState('loading')
    let ok = false
    try {
      ok = onDownload ? await onDownload(item) : await downloadAgentMedia(item)
    } catch {
      ok = false
    }
    if (ok) {
      setDownState('idle')
      return
    }
    flash(() => setDownState('failed'), () => setDownState((s) => (s === 'failed' ? 'idle' : s)), 2000)
  }, [item, onDownload, downState, flash])

  /** 主操作：网页版跳滚动歌词播放器（AgentAudioCard.tsx:138-143）；小程序就地播放。 */
  const handleOpenPlayer = useCallback((): void => {
    const current = playerRef.current
    if (current) {
      if (playing) current.pause()
      else current.play()
      return
    }
    const player = Taro.createInnerAudioContext()
    player.src = item.url
    // 时长只认平台回报的 duration；拿不到就保持未知（不写死 00:00）。
    const syncDuration = (): void => {
      const total = player.duration
      if (Number.isFinite(total) && total > 0) setDurationSec(total)
    }
    player.onCanplay(syncDuration)
    player.onTimeUpdate(() => {
      const position = player.currentTime
      setCurrentSec(Number.isFinite(position) ? position : 0)
      syncDuration()
    })
    player.onPlay(() => setPlaying(true))
    player.onPause(() => setPlaying(false))
    player.onStop(() => {
      setPlaying(false)
      setCurrentSec(0)
    })
    player.onEnded(() => {
      setPlaying(false)
      setCurrentSec(0)
    })
    player.onError(() => {
      setPlaying(false)
      setFailed(true)
    })
    playerRef.current = player
    player.play()
  }, [item.url, playing])

  const title = item.title?.trim() ?? ''
  const cover = item.cover?.trim() ?? ''
  // 试听条标题：真歌名优先，没有就从 URL 猜；猜不出不摆「音频」这类泛化占位。
  const playerTitle = title || guessAudioTitleFromUrl(item.url) || ''
  const progress = durationSec > 0 ? Math.min(1, currentSec / durationSec) : 0

  return (
    <View className='agent-rise flex w-full flex-col'>
      {/* 抬头：有真封面才显示缩略图；有真歌名才显示标题；徽章说类别（:150-178）。 */}
      <View className='flex items-center gap-2.5 px-3.5 pt-3'>
        {cover ? (
          <Image
            src={cover}
            aria-hidden='true'
            mode='aspectFill'
            lazyLoad
            className='h-11 w-11 shrink-0 rounded-[10px] bg-black/[0.05]'
          />
        ) : null}
        <View className='flex min-w-0 flex-1 flex-col items-start gap-1'>
          {title ? (
            <Text className='max-w-full truncate text-ios-subhead font-semibold text-foreground'>{title}</Text>
          ) : null}
          <Text className='rounded-full bg-black/[0.05] px-2 py-0.5 text-ios-caption1 font-medium text-muted-foreground'>
            {item.mediaKind === 'music' ? '音乐' : '音频'}
          </Text>
        </View>
      </View>
      <View className='px-3.5 pt-2.5'>
        {failed ? (
          <View className='flex flex-col items-center justify-center gap-3 bg-black/[0.03] p-4'>
            <View className='flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive'>
              <Icon name='alert-triangle-red' className='h-6 w-6' />
            </View>
            <Text className='text-ios-subhead font-medium text-muted-foreground'>音频加载失败</Text>
            <View
              className='flex h-11 items-center gap-1.5 rounded-full bg-ios-blue/10 px-4 text-ios-subhead font-medium text-ios-blue backdrop-blur-[22px]'
              onClick={(event) => {
                event.stopPropagation()
                handleRetry()
              }}
            >
              <Icon name='rotate-cw-blue' className='h-4 w-4' />
              <Text>重试</Text>
            </View>
          </View>
        ) : (
          <View className='flex flex-col gap-2.5'>
            <View
              className={cn(
                'flex min-h-12 w-full items-center justify-center gap-2 rounded-[14px]',
                'bg-ios-blue text-white text-ios-subhead font-semibold',
                'shadow-[0_1px_0_rgba(255,255,255,0.18)_inset]',
              )}
              onClick={handleOpenPlayer}
            >
              <Icon name='mic-2-white' className='h-[1.125rem] w-[1.125rem]' />
              <Text>{playing ? '暂停播放' : '播放音频'}</Text>
            </View>
            {/* 次要试听（AgentAudioCard.tsx:216-225）：网页版是原生 <audio controls>；
                小程序的 Taro Audio 默认皮是灰色大块，改为同尺寸试听条。 */}
            <View className='flex w-full items-center gap-2.5 rounded-[14px] bg-black/[0.03] px-2.5 py-2'>
              <View className='flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-ios-blue to-ios-indigo'>
                <Icon name='mic-2-white' className='h-[1.125rem] w-[1.125rem]' />
              </View>
              <View className='flex min-w-0 flex-1 flex-col gap-1.5'>
                {playerTitle ? (
                  <Text className='max-w-full truncate text-ios-footnote font-medium text-foreground/80'>
                    {playerTitle}
                  </Text>
                ) : null}
                <View className='flex items-center gap-2'>
                  {/* 进度轨道：网页版这里是原生 <audio controls> 的 scrubber。
                      Taro Audio 的默认皮是灰色大块、且波形要 WebAudio 解码（小程序没有），
                      所以用同语义的细轨道 + 实心进度取代 24 根假波形柱——假柱子既不像
                      原生控件、也读不出进度。 */}
                  <View className='h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/15'>
                    <View
                      className='h-full rounded-full bg-ios-blue transition-[width] duration-200'
                      style={{ width: `${Math.round((durationSec > 0 ? progress : 0) * 100)}%` }}
                    />
                  </View>
                  <Text className='shrink-0 text-ios-caption1 tabular-nums text-muted-foreground'>
                    {/* 拿到平台回报的真实时长前显示 --:--，不写死 00:00 冒充已加载。 */}
                    {durationSec > 0 ? `${formatClock(currentSec)} / ${formatClock(durationSec)}` : '--:--'}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        )}
      </View>
      {item.lyricStatus === 'aligning' ? (
        <View className='flex items-center gap-1.5 px-3.5 pt-2 text-ios-caption1 text-muted-foreground'>
          <Icon name='loader-2-a45' className='ic-spin h-3.5 w-3.5' />
          <Text>歌词对齐中，完成后自动更新</Text>
        </View>
      ) : null}
      {item.costCoins !== undefined ? (
        <View className='flex items-center gap-1 px-3.5 pt-2.5 text-ios-footnote text-muted-foreground'>
          <Icon name='coins-a40' className='h-3.5 w-3.5' />
          <Text>消耗 {formatCoins(item.costCoins)} 金币</Text>
        </View>
      ) : null}
      <View className='mt-1 flex flex-wrap gap-1 px-3.5 pb-3'>
        <AudioAction
          label={saveState === 'saved' ? '已存' : saveState === 'failed' ? '未存入' : '存图库'}
          disabled={saveState === 'loading' || saveState === 'saved'}
          tone={saveState === 'failed' ? 'danger' : undefined}
          onClick={() => void handleSave()}
        >
          {saveState === 'loading' ? (
            <Icon name='loader-2-a45' className='ic-spin h-3.5 w-3.5' />
          ) : saveState === 'saved' ? (
            <Icon name='check-a56' className='h-3.5 w-3.5' />
          ) : (
            <Icon name='library-a45' className='h-3.5 w-3.5' />
          )}
        </AudioAction>
        <AudioAction
          label={downState === 'failed' ? '失败' : '下载'}
          disabled={downState === 'loading'}
          tone={downState === 'failed' ? 'danger' : undefined}
          onClick={() => void handleDownload()}
        >
          {downState === 'loading' ? (
            <Icon name='loader-2-a45' className='ic-spin h-3.5 w-3.5' />
          ) : (
            <Icon name='download-a45' className='h-3.5 w-3.5' />
          )}
        </AudioAction>
        <AgentRerunMenu label='再来 N 组' disabled={!onRerun} onPick={(count) => onRerun?.(item, count)} />
        <AudioAction label='微调' disabled={!onVariant} onClick={() => onVariant?.(item)}>
          <Icon name='sliders-horizontal-a45' className='h-3.5 w-3.5' />
        </AudioAction>
      </View>
    </View>
  )
}
