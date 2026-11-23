import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import type { AgentItem } from './types'

/**
 * 出图卡（真源：src/components/agent-chat/AgentImageCard.tsx，702 行）。
 *
 * 平台差异（白名单）：
 *   - 全屏查看器（createPortal + Pointer Events 手势）→ Taro.previewImage
 *     （原生双指缩放 / 下滑关闭，小程序里比自绘手势稳）；
 *   - 存图 / 下载 → Taro.downloadFile + saveImageToPhotosAlbum；
 *   - <img> → <Image>。
 *
 * 覆盖网页版分支：单图 / 多图网格（AgentImageGroup）、尺寸标注、存图库 / 改图 /
 * 放大 / 下载 / 分享 / 再来 N 组 / 微调变体、加载失败态（骨架 → 失败 + 重试）。
 */

type ImageItem = Extract<AgentItem, { kind: 'image' }>

export interface AgentImageCardProps {
  item: ImageItem
  /** 存图库：true＝已存入／本来就在；false＝失败（短暂「未存入」）。 */
  onSaveToLibrary?: (item: ImageItem) => Promise<boolean>
  /** 改图：把图抓回并加进输入框附件（true＝已交付附件）。 */
  onEdit?: (item: ImageItem) => Promise<boolean>
  /** 下载：true＝已触发下载；false/抛错＝按钮短暂「失败」。 */
  onDownload?: (item: ImageItem) => Promise<boolean>
  onRerun?: (item: ImageItem) => void
  onRerunVariant?: (item: ImageItem) => void
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 内置保存：下载原图 → 存相册。失败不装成功。 */
async function saveImageToAlbum(url: string): Promise<boolean> {
  try {
    const res = await Taro.downloadFile({ url })
    if (res.statusCode !== 200) return false
    await Taro.saveImageToPhotosAlbum({ filePath: res.tempFilePath })
    return true
  } catch {
    return false
  }
}

/** 出图卡上的动作按钮：回调缺席时保持 disabled（与网页接线前逐位一致）。 */
function ImageAction({
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

function preview(urls: string[], current: string): void {
  void Taro.previewImage({ urls, current })
}

function copyUrl(url: string): void {
  void Taro.setClipboardData({ data: url }).catch(() => {
    void Taro.showToast({ title: '复制失败', icon: 'none' })
  })
}

function ImageFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <View className='absolute inset-0 flex flex-col items-center justify-center gap-3 p-4'>
      <View className='flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10'>
        <Icon name='alert-triangle-red' className='h-6 w-6' />
      </View>
      <Text className='text-ios-subhead font-medium text-muted-foreground'>图片加载失败</Text>
      <View
        className='flex h-11 items-center gap-1.5 rounded-full bg-ios-blue/10 px-4 text-ios-subhead font-medium text-ios-blue'
        onClick={(event) => {
          event.stopPropagation()
          onRetry()
        }}
      >
        <Icon name='rotate-cw-blue' className='h-4 w-4' />
        <Text>重试</Text>
      </View>
    </View>
  )
}

/** 尺寸标注（单图与网格共用）：真实像素，读不到就不标。 */
function Dimensions({ size, className }: { size: { w: number; h: number } | null; className?: string }) {
  if (size === null) return null
  return (
    <Text className={cn('text-ios-caption1 tabular-nums text-foreground/40', className)}>
      {size.w} × {size.h}
    </Text>
  )
}

export function AgentImageCard({
  item,
  onSaveToLibrary,
  onEdit,
  onDownload,
  onRerun,
  onRerunVariant,
}: AgentImageCardProps) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [retryKey, setRetryKey] = useState(0)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'loading' | 'saved' | 'failed'>('idle')
  const [editState, setEditState] = useState<'idle' | 'loading' | 'failed'>('idle')
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

  // item.url 变化（同实例换图）时重置加载态，避免旧图的 loaded/failed 串台。
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
    setSize(null)
  }, [item.url])

  const handleRetry = (): void => {
    setFailed(false)
    setLoaded(false)
    setRetryKey((key) => key + 1)
  }

  const handleSave = useCallback(async () => {
    if (saveState === 'loading' || saveState === 'saved') return
    setSaveState('loading')
    let ok = false
    try {
      ok = onSaveToLibrary ? await onSaveToLibrary(item) : await saveImageToAlbum(item.url)
    } catch {
      ok = false
    }
    if (ok) {
      setSaveState('saved')
      return
    }
    flash(
      () => setSaveState('failed'),
      () => setSaveState((state) => (state === 'failed' ? 'idle' : state)),
      2000,
    )
    void Taro.showToast({ title: '保存失败，请检查相册权限', icon: 'none' })
  }, [item, onSaveToLibrary, saveState, flash])

  const handleEdit = useCallback(async () => {
    if (!onEdit || editState === 'loading') return
    setEditState('loading')
    let ok = false
    try {
      ok = await onEdit(item)
    } catch {
      ok = false
    }
    if (ok) {
      setEditState('idle')
      return
    }
    flash(
      () => setEditState('failed'),
      () => setEditState((state) => (state === 'failed' ? 'idle' : state)),
      2000,
    )
  }, [item, onEdit, editState, flash])

  const handleDownload = useCallback(async () => {
    if (downState === 'loading') return
    setDownState('loading')
    let ok = false
    try {
      ok = onDownload ? await onDownload(item) : await saveImageToAlbum(item.url)
    } catch {
      ok = false
    }
    if (ok) {
      setDownState('idle')
      return
    }
    flash(
      () => setDownState('failed'),
      () => setDownState((state) => (state === 'failed' ? 'idle' : state)),
      2000,
    )
  }, [item, onDownload, downState, flash])

  return (
    <View className='agent-rise flex w-full flex-col'>
      <View
        className='relative aspect-square max-h-[min(420px,52dvh)] w-full overflow-hidden rounded-[18px] bg-black/[0.03]'
        onClick={() => {
          if (!failed) preview([item.url], item.url)
        }}
      >
        {!failed && !loaded ? <View className='skeleton absolute inset-0' /> : null}
        {failed ? (
          <ImageFailed onRetry={handleRetry} />
        ) : (
          <Image
            key={retryKey}
            src={item.url}
            mode='aspectFit'
            lazyLoad
            aria-label='智能体生成的图片'
            className={cn(
              'absolute inset-0 h-full w-full transition-opacity duration-300',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
            onLoad={(event) => {
              setLoaded(true)
              const width = Number(event.detail?.width ?? 0)
              const height = Number(event.detail?.height ?? 0)
              if (width > 0 && height > 0) setSize({ w: width, h: height })
            }}
            onError={() => setFailed(true)}
          />
        )}
      </View>

      {item.costCoins !== undefined || size !== null ? (
        <View className='flex items-center gap-2 px-3.5 pt-2.5'>
          {item.costCoins !== undefined ? (
            <View className='flex items-center gap-1 text-ios-footnote text-muted-foreground'>
              <Icon name='coins-a40' className='h-3.5 w-3.5' />
              <Text>消耗 {formatCoins(item.costCoins)} 金币</Text>
            </View>
          ) : null}
          <Dimensions size={size} />
        </View>
      ) : null}

      <View className='mt-1 flex flex-wrap gap-1 px-3.5 pb-3'>
        <ImageAction
          label={saveState === 'saved' ? '已存' : saveState === 'failed' ? '未存入' : '存图库'}
          disabled={saveState === 'loading' || saveState === 'saved'}
          tone={saveState === 'failed' ? 'danger' : undefined}
          onClick={() => void handleSave()}
        >
          {saveState === 'loading' ? (
            <Icon name='loader-2-a45' className='ic-spin h-3.5 w-3.5' />
          ) : saveState === 'saved' ? (
            <Icon name='check-green' className='h-3.5 w-3.5' />
          ) : (
            <Icon name='library-a45' className='h-3.5 w-3.5' />
          )}
        </ImageAction>
        <ImageAction
          label={editState === 'failed' ? '失败' : '改图'}
          disabled={!onEdit || editState === 'loading'}
          tone={editState === 'failed' ? 'danger' : undefined}
          onClick={() => void handleEdit()}
        >
          {editState === 'loading' ? (
            <Icon name='loader-2-a45' className='ic-spin h-3.5 w-3.5' />
          ) : (
            <Icon name='image-plus-a45' className='h-3.5 w-3.5' />
          )}
        </ImageAction>
        <ImageAction label='放大' disabled={failed} onClick={() => !failed && preview([item.url], item.url)}>
          <Icon name='zoom-in-a65' className='h-3.5 w-3.5' />
        </ImageAction>
        <ImageAction
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
        </ImageAction>
        <ImageAction label='原图链接' disabled={false} onClick={() => copyUrl(item.url)}>
          <Icon name='share-a45' className='h-3.5 w-3.5' />
        </ImageAction>
        {onRerun !== undefined ? (
          <ImageAction label='再来 N 组' disabled={false} onClick={() => onRerun(item)}>
            <Icon name='layers-a45' className='h-3.5 w-3.5' />
          </ImageAction>
        ) : null}
        {onRerunVariant !== undefined ? (
          <ImageAction label='微调变体' disabled={false} onClick={() => onRerunVariant(item)}>
            <Icon name='sliders-horizontal-a45' className='h-3.5 w-3.5' />
          </ImageAction>
        ) : null}
      </View>
    </View>
  )
}

export interface AgentImageGroupProps {
  items: ImageItem[]
  onSaveToLibrary?: (item: ImageItem) => Promise<boolean>
}

/**
 * 多图网格（≥2 张连续出图）。网页版每张图各占一条卡片；小程序屏幕窄，
 * 多图并排（2 列）才能一眼比稿。点击整组进原生预览（左右滑看全组）。
 */
export function AgentImageGroup({ items, onSaveToLibrary }: AgentImageGroupProps) {
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})
  const urls = items.map((item) => item.url)

  const save = useCallback(
    async (item: ImageItem) => {
      let ok = false
      try {
        ok = onSaveToLibrary ? await onSaveToLibrary(item) : await saveImageToAlbum(item.url)
      } catch {
        ok = false
      }
      void Taro.showToast({
        title: ok ? '已保存到相册' : '保存失败，请检查相册权限',
        icon: none(ok),
      })
    },
    [onSaveToLibrary],
  )

  if (items.length === 0) return null

  return (
    <View className='agent-rise grid w-full grid-cols-2 gap-1.5'>
      {items.map((item) => (
        <View
          key={item.id}
          className='relative aspect-square overflow-hidden rounded-[14px] border border-black/[0.06] bg-black/[0.03]'
          onClick={() => {
            if (!failed[item.id]) preview(urls, item.url)
          }}
          onLongPress={() => {
            if (!failed[item.id]) void save(item)
          }}
        >
          {failed[item.id] ? (
            <ImageFailed onRetry={() => setFailed((prev) => ({ ...prev, [item.id]: false }))} />
          ) : (
            <Image
              src={item.url}
              mode='aspectFill'
              lazyLoad
              aria-label='智能体生成的图片'
              className='absolute inset-0 h-full w-full'
              onLoad={(event) => {
                const width = Number(event.detail?.width ?? 0)
                const height = Number(event.detail?.height ?? 0)
                if (width > 0 && height > 0) {
                  setSizes((prev) => ({ ...prev, [item.id]: { w: width, h: height } }))
                }
              }}
              onError={() => setFailed((prev) => ({ ...prev, [item.id]: true }))}
            />
          )}
          {sizes[item.id] !== undefined ? (
            <View className='pointer-events-none absolute bottom-1 right-1 rounded-full bg-black/50 px-1.5 py-0.5'>
              <Dimensions size={sizes[item.id]} className='text-white/85' />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  )
}

function none(ok: boolean): 'success' | 'none' {
  return ok ? 'success' : 'none'
}
