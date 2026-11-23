import { useCallback, useEffect, useRef, useState } from 'react'
import { Text, Video, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import { AgentRerunMenu } from './AgentRerunMenu'
import type { AgentItem } from './types'

/**
 * 出片卡。结构 / 类名逐行复制自 src/components/agent-chat/AgentVideoCard.tsx：
 *   - 媒体面        :246-327（figure / aspect-video / 骨架 / 失败态 / media_kind 徽章）
 *   - 金币行        :328-333
 *   - 动作条        :334-371（VideoAction :33-66）
 *   - 全屏查看器    :71-164（createPortal → 小程序内 fixed 覆盖层，白名单第 2 条）
 * 回调缺席＝按钮 disabled（与网页接线前逐位一致）。
 */

type VideoItem = Extract<AgentItem, { kind: 'video' }>

export interface AgentVideoCardProps {
  item: VideoItem
  onSaveToLibrary?: (item: VideoItem) => Promise<boolean>
  onDownload?: (item: VideoItem) => Promise<boolean>
  onRerun?: (item: VideoItem, count: number) => void
  onVariant?: (item: VideoItem) => void
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴（AgentVideoCard.tsx:27-29）。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 出片卡上的动作按钮（AgentVideoCard.tsx:33-66）。 */
function VideoAction({
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

/** 全屏影片播放器（AgentVideoCard.tsx:71-164）。 */
function VideoLightbox({
  src,
  onClose,
  onDownload,
}: {
  src: string
  onClose: () => void
  onDownload?: () => void
}) {
  return (
    <View
      aria-label='影片查看器'
      className='agent-chat-surface fixed inset-0 z-[95] flex min-h-[100dvh] select-none items-center justify-center bg-[rgba(18,20,28,0.92)] backdrop-blur-xl'
      onClick={onClose}
    >
      <View
        className='absolute right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.14] text-white backdrop-blur-md'
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <Icon name='x-white' className='h-5 w-5' />
      </View>
      <View className='flex max-h-full max-w-full items-center justify-center' onClick={(event) => event.stopPropagation()}>
        <Video
          src={src}
          controls
          autoplay
          className='max-h-[82dvh] w-[92vw] rounded-[1.5rem] bg-black'
        />
      </View>
      <View className='absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] flex justify-center' onClick={(event) => event.stopPropagation()}>
        {/* 下载钮（AgentVideoCard.tsx:137-162）：回调缺席＝disabled，文字与图标一起降到 white/40。 */}
        <View
          aria-label='下载'
          className={cn(
            'flex h-11 items-center gap-1.5 rounded-full bg-white/[0.14] px-4 text-ios-subhead font-medium backdrop-blur-md',
            onDownload ? 'text-white' : 'text-white/40',
          )}
          onClick={() => {
            if (onDownload) onDownload()
          }}
        >
          <Icon name='download-white' className='h-4 w-4' />
          <Text>下载</Text>
        </View>
      </View>
    </View>
  )
}

export function AgentVideoCard({ item, onSaveToLibrary, onDownload, onRerun, onVariant }: AgentVideoCardProps) {
  const [viewerOpen, setViewerOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'loading' | 'saved' | 'failed'>('idle')
  const [downState, setDownState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const flash = useCallback((apply: () => void, revert: () => void, delayMs: number) => {
    apply()
    timersRef.current.push(setTimeout(revert, delayMs))
  }, [])
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach(clearTimeout)
    }
  }, [])

  const handleSave = useCallback(async () => {
    if (!onSaveToLibrary || saveState === 'loading' || saveState === 'saved') return
    setSaveState('loading')
    let ok = false
    try {
      ok = await onSaveToLibrary(item)
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
    if (!onDownload || downState === 'loading') return
    setDownState('loading')
    let ok = false
    try {
      ok = await onDownload(item)
    } catch {
      ok = false
    }
    if (ok) {
      setDownState('idle')
      return
    }
    flash(() => setDownState('failed'), () => setDownState((s) => (s === 'failed' ? 'idle' : s)), 2000)
  }, [item, onDownload, downState, flash])

  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [item.url])

  const handleRetry = (): void => {
    setFailed(false)
    setLoaded(false)
    setRetryKey((k) => k + 1)
  }

  return (
    <View className='agent-rise flex w-full flex-col'>
      <View
        className='group relative aspect-video max-h-[min(420px,52dvh)] w-full select-none overflow-hidden rounded-[18px] bg-black/[0.03]'
        onClick={() => {
          if (!failed) setViewerOpen(true)
        }}
      >
        {!failed && !loaded ? <View className='skeleton absolute inset-0' /> : null}
        {failed ? (
          <View className='absolute inset-0 flex flex-col items-center justify-center gap-3 p-4'>
            <View className='flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive'>
              <Icon name='alert-triangle-red' className='h-6 w-6' />
            </View>
            <Text className='text-ios-subhead font-medium text-muted-foreground'>视频加载失败</Text>
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
          <Video
            key={retryKey}
            src={item.url}
            aria-label='智能体生成的影片'
            controls
            objectFit='contain'
            showFullscreenBtn
            onLoadedMetaData={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              'absolute inset-0 h-full w-full bg-black transition-opacity duration-300',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        )}
        {/* media_kind 徽章：film=成片、其余（含缺省）=影片（:318-326）。 */}
        <View
          className={cn(
            'pointer-events-none absolute left-2.5 top-2.5 rounded-full px-2 py-0.5 text-ios-caption1 font-medium backdrop-blur-md',
            failed ? 'hidden' : 'bg-black/55 text-white/90',
          )}
        >
          <Text>{item.mediaKind === 'film' ? '成片' : '影片'}</Text>
        </View>
      </View>
      {item.costCoins !== undefined ? (
        <View className='flex items-center gap-1 px-3.5 pt-2.5 text-ios-footnote text-muted-foreground'>
          <Icon name='coins-a40' className='h-3.5 w-3.5' />
          <Text>消耗 {formatCoins(item.costCoins)} 金币</Text>
        </View>
      ) : null}
      <View className='mt-1 flex flex-wrap gap-1 px-3.5 pb-3'>
        <VideoAction
          label={saveState === 'saved' ? '已存' : saveState === 'failed' ? '未存入' : '存图库'}
          disabled={!onSaveToLibrary || saveState === 'loading' || saveState === 'saved'}
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
        </VideoAction>
        <VideoAction
          label={downState === 'failed' ? '失败' : '下载'}
          disabled={!onDownload || downState === 'loading'}
          tone={downState === 'failed' ? 'danger' : undefined}
          onClick={() => void handleDownload()}
        >
          {downState === 'loading' ? (
            <Icon name='loader-2-a45' className='ic-spin h-3.5 w-3.5' />
          ) : (
            <Icon name='download-a45' className='h-3.5 w-3.5' />
          )}
        </VideoAction>
        {/* AgentRerunMenu（:363-367）：回调缺席＝disabled，档位选单不渲染。 */}
        <AgentRerunMenu label='再来 N 组' disabled={!onRerun} onPick={(count) => onRerun?.(item, count)} />
        <VideoAction label='微调' disabled={!onVariant} onClick={() => onVariant?.(item)}>
          <Icon name='sliders-horizontal-a45' className='h-3.5 w-3.5' />
        </VideoAction>
      </View>
      {viewerOpen ? (
        <VideoLightbox
          src={item.url}
          onClose={() => setViewerOpen(false)}
          onDownload={onDownload ? () => void onDownload(item) : undefined}
        />
      ) : null}
    </View>
  )
}
