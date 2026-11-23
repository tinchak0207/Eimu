import { readWindow } from '../../lib/system'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, ScrollView, Text, Video, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import {
  collectImageUrls,
  isBareOpenUIInfo,
  isOpenUILang,
  parseAgentMarkdown,
  type MdBlock,
  type MdInline,
} from '../../lib/agent-markdown'
import { Icon } from './icons'

/**
 * 助理消息的 Markdown 渲染（真源：src/components/agent-chat/AgentMarkdown.tsx，315 行）。
 *
 * 平台差异（白名单）：
 *   - lucide → icons.tsx 的 PNG；<img>/<video> → <Image>/<Video>；
 *   - 放大灯罩（createPortal）→ Taro.previewImage（原生双指缩放，体验等价且更稳）；
 *   - EntityText（@标签 chip）→ 纯文本（小程序没有实体库）；
 *   - OpenUI 渲染器（@openuidev/react-ui，DOM 组件库）→ 占位卡 + 可折叠源码。
 *
 * 罪状 9：`[标题](…png)` 这类图片连结在**解析层**就转成 img span
 * （agent-markdown.ts matchLink/mediaInline），这里只负责画缩略图。
 */

function copyLink(href: string): void {
  if (!href) return
  void Taro.setClipboardData({ data: href }).catch(() => {
    void Taro.showToast({ title: '链接复制失败', icon: 'none' })
  })
}

/** 气泡可用宽度（模块顶层不调平台 API：首次用到时取一次并缓存）。 */
let cachedContentWidth: number | null = null
function contentWidth(): number {
  if (cachedContentWidth !== null) return cachedContentWidth
  try {
    cachedContentWidth = Math.max(160, readWindow().windowWidth - 64)
  } catch {
    cachedContentWidth = 311
  }
  return cachedContentWidth
}

/** 消息内图片缩略：按原始宽高比收进 224px 高、气泡宽以内，点开走原生预览。 */
function MarkdownImage({ src, alt, onOpen }: { src: string; alt: string; onOpen: () => void }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const onLoad = (event: { detail?: { width?: string | number; height?: string | number } }): void => {
    const width = Number(event.detail?.width ?? 0)
    const height = Number(event.detail?.height ?? 0)
    if (!width || !height) return
    const ratio = width / height
    const displayW = Math.min(contentWidth(), 224 * ratio)
    const displayH = Math.round(displayW / ratio)
    setSize({ w: Math.round(displayW), h: displayH })
  }
  return (
    <View
      className='relative my-1 max-w-full overflow-hidden rounded-ios-lg border border-black/[0.06] bg-black/[0.03]'
      style={{ width: size ? `${size.w}px` : '100%', height: size ? `${size.h}px` : '150px' }}
      onClick={onOpen}
    >
      <Image
        src={src}
        mode='aspectFill'
        lazyLoad
        className='block h-full w-full'
        onLoad={onLoad}
        onError={() => setFailed(true)}
        aria-label={alt ? `放大查看图片：${alt}` : `放大查看图片：${src}`}
      />
      {failed ? (
        <View className='absolute inset-0 flex items-center justify-center bg-black/[0.03]'>
          <Text className='text-ios-caption1 text-foreground/45'>图片加载失败</Text>
        </View>
      ) : size === null ? (
        <View className='skeleton absolute inset-0' />
      ) : null}
    </View>
  )
}

/** 行内音频：Taro.createInnerAudioContext（平台白名单第 4 条）。 */
function InlineAudio({ src }: { src: string }) {
  const [playing, setPlaying] = useState(false)
  const playerRef = useRef<ReturnType<typeof Taro.createInnerAudioContext> | null>(null)

  useEffect(() => {
    return () => {
      playerRef.current?.destroy()
      playerRef.current = null
    }
  }, [])

  const toggle = (): void => {
    let player = playerRef.current
    if (player === null) {
      player = Taro.createInnerAudioContext()
      player.src = src
      player.onEnded(() => setPlaying(false))
      player.onStop(() => setPlaying(false))
      player.onError(() => {
        setPlaying(false)
        void Taro.showToast({ title: '音频播放失败', icon: 'none' })
      })
      playerRef.current = player
    }
    if (playing) {
      player.pause()
      setPlaying(false)
      return
    }
    player.play()
    setPlaying(true)
  }

  return (
    <View
      className='my-1 flex w-full max-w-md items-center gap-2 rounded-ios-lg border border-black/[0.06] bg-black/[0.035] px-3 py-2'
      onClick={toggle}
      aria-label={`音频：${src}`}
    >
      <Icon name={playing ? 'square-red' : 'play-a45'} className='h-4 w-4 shrink-0' />
      <Text className='min-w-0 flex-1 truncate text-ios-footnote text-foreground/60'>
        {playing ? '播放中…（点按暂停）' : '点按播放音频'}
      </Text>
    </View>
  )
}

/** 行内影片：内嵌播放器，不再是一串裸 URL。 */
function InlineVideo({ src }: { src: string }) {
  return (
    <Video
      src={src}
      controls
      className='my-1 block w-full rounded-ios-lg bg-black'
      style={{ height: '200px' }}
      aria-label={`影片：${src}`}
    />
  )
}

type MediaSpan = Extract<MdInline, { k: 'img' | 'video' | 'audio' }>

function isMediaSpan(span: MdInline): span is MediaSpan {
  return span.k === 'img' || span.k === 'video' || span.k === 'audio'
}

interface InlineRunProps {
  spans: MdInline[]
  onOpenImage: (src: string) => void
}

/** 一段连续的行内 span（不含媒体：媒体由 splitMedia 拆成独立块）。 */
function InlineRun({ spans, onOpenImage }: InlineRunProps) {
  return (
    <Text className='whitespace-pre-wrap break-words'>
      {spans
        .filter((span) => !isMediaSpan(span))
        .map((span, index) => (
          <InlineNode key={index} span={span} onOpenImage={onOpenImage} />
        ))}
    </Text>
  )
}

function InlineNode({ span, onOpenImage }: { span: MdInline; onOpenImage: (src: string) => void }) {
  switch (span.k) {
    case 'text':
      return <>{span.text}</>
    case 'strong':
      return (
        <Text className='font-semibold'>
          <InlineRun spans={span.children} onOpenImage={onOpenImage} />
        </Text>
      )
    case 'em':
      return (
        <Text className='italic'>
          <InlineRun spans={span.children} onOpenImage={onOpenImage} />
        </Text>
      )
    case 'del':
      return (
        <Text className='text-foreground/45 line-through'>
          <InlineRun spans={span.children} onOpenImage={onOpenImage} />
        </Text>
      )
    case 'code':
      // 罪状 9：task_id / 端点路径等行内代码弱化——低调等宽小字，不删原文。
      return (
        <Text className='break-all rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[0.75rem] leading-none text-foreground/55'>
          {span.text}
        </Text>
      )
    case 'link':
      return (
        <Text className='break-all text-ios-blue underline underline-offset-2' onClick={() => copyLink(span.href)}>
          <InlineRun spans={span.children} onOpenImage={onOpenImage} />
        </Text>
      )
    case 'br':
      return <>{'\n'}</>
    case 'img':
      // 兜底：媒体正常已由 RichSpans 提到顶层；这里只可能来自畸形嵌套，
      // 用文字占位而不是把 <view> 塞进 <text>（非法结构）。
      return <>［图片］</>
    case 'video':
      return <>［影片］</>
    case 'audio':
      return <>［音频］</>
  }
}

/**
 * 把嵌在强调（strong/em/del）里的媒体提到顶层。小程序的 <text> 只能嵌 <text>，
 * `<view>/<image>` 放进 <text> 是非法结构；媒体提到顶层后由 splitMedia 单独成块。
 * 强调会被媒体切开（前后各留一段），文字样式不丢。
 */
function flattenMedia(spans: MdInline[]): MdInline[] {
  const flattenSpan = (span: MdInline): MdInline[] => {
    if (isMediaSpan(span)) return [span]
    if (span.k === 'strong' || span.k === 'em' || span.k === 'del') {
      const out: MdInline[] = []
      let buffer: MdInline[] = []
      const flush = (): void => {
        if (buffer.length > 0) {
          out.push({ k: span.k, children: buffer } as MdInline)
          buffer = []
        }
      }
      for (const child of span.children) {
        for (const flat of flattenSpan(child)) {
          if (isMediaSpan(flat)) {
            flush()
            out.push(flat)
          } else {
            buffer.push(flat)
          }
        }
      }
      flush()
      return out
    }
    return [span]
  }
  const out: MdInline[] = []
  for (const span of spans) out.push(...flattenSpan(span))
  return out
}

/** 把 span 序列按媒体切成「行内段 / 媒体块」，媒体独占一行（不挤在文字流里）。 */
function splitMedia(spans: MdInline[]): Array<{ kind: 'inline'; spans: MdInline[] } | { kind: 'media'; span: MediaSpan }> {
  const parts: Array<{ kind: 'inline'; spans: MdInline[] } | { kind: 'media'; span: MediaSpan }> = []
  let buffer: MdInline[] = []
  const flush = (): void => {
    if (buffer.length > 0) {
      parts.push({ kind: 'inline', spans: buffer })
      buffer = []
    }
  }
  for (const span of spans) {
    if (isMediaSpan(span)) {
      flush()
      parts.push({ kind: 'media', span })
    } else {
      buffer.push(span)
    }
  }
  flush()
  return parts
}

function RichSpans({ spans, onOpenImage }: InlineRunProps) {
  const parts = useMemo(() => splitMedia(flattenMedia(spans)), [spans])
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'inline' ? (
          <InlineRun key={index} spans={part.spans} onOpenImage={onOpenImage} />
        ) : part.span.k === 'img' ? (
          <MarkdownImage
            key={index}
            src={part.span.src}
            alt={part.span.alt}
            onOpen={() => onOpenImage(part.span.src)}
          />
        ) : part.span.k === 'video' ? (
          <InlineVideo key={index} src={part.span.src} />
        ) : (
          <InlineAudio key={index} src={part.span.src} />
        ),
      )}
    </>
  )
}

/** OpenUI 兜底（唯一不可移植项）：占位卡 + 可折叠源码，绝不当正文铺开。 */
function OpenUIPlaceholder({ code, bare }: { code: string; bare: boolean }) {
  const [open, setOpen] = useState(false)
  if (bare) {
    // 裸 DSL 识别包出来的块：按普通可读文本显示（与网页版 OpenUIFallback 同语义）。
    return <Text className='my-1 whitespace-pre-wrap break-words'>{code}</Text>
  }
  return (
    <View className='my-1.5 overflow-hidden rounded-[10px] border border-black/[0.08] bg-black/[0.03]'>
      <View
        className='flex min-h-9 items-center gap-2 px-3 py-1.5'
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name='layout-grid-a40' className='h-3.5 w-3.5 shrink-0' />
        <Text className='min-w-0 flex-1 text-[0.75rem] text-foreground/55'>
          生成式界面 · 需在网页版查看
        </Text>
        <Icon
          name='chevron-down-a35'
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </View>
      {open ? (
        <ScrollView scrollX className='px-3 pb-2.5'>
          <Text className='whitespace-pre font-mono text-[0.8125rem] leading-[1.6] text-foreground/80'>
            {code}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

interface BlockProps {
  block: MdBlock
  onOpenImage: (src: string) => void
}

function BlockNode({ block, onOpenImage }: BlockProps) {
  switch (block.type) {
    case 'p':
      return (
        <View className='my-1 break-words [overflow-wrap:anywhere] first:mt-0 last:mb-0'>
          <RichSpans spans={block.children} onOpenImage={onOpenImage} />
        </View>
      )
    case 'h': {
      // 手机端阶梯锚点（agent-chat.css ≤639.98px）：h1 → 18px/26px（.agent-turn-title），
      // h2/h3 → 17px/25px（.agent-turn-text）；桌面原 class 序列不动（网页版 :185-194 同）。
      const size =
        block.level <= 1
          ? 'text-base font-bold agent-turn-title'
          : block.level === 2
            ? 'text-[0.9375rem] font-bold agent-turn-text'
            : 'text-[0.9375rem] font-semibold agent-turn-text'
      return (
        <View className={cn('mt-2 mb-1 break-words first:mt-0', size)}>
          <RichSpans spans={block.children} onOpenImage={onOpenImage} />
        </View>
      )
    }
    case 'code': {
      if (isOpenUILang(block.lang)) {
        return <OpenUIPlaceholder code={block.text} bare={isBareOpenUIInfo(block.lang)} />
      }
      return (
        <ScrollView scrollX className='my-1.5 rounded-[10px] bg-black/[0.045] px-3 py-2.5'>
          <Text className='whitespace-pre font-mono text-[0.8125rem] leading-[1.6] text-foreground/80'>
            {block.text}
          </Text>
        </ScrollView>
      )
    }
    case 'quote':
      return (
        <View className='my-1.5 border-l-2 border-black/15 pl-3 text-foreground/60'>
          {block.blocks.map((child, index) => (
            <BlockNode key={index} block={child} onOpenImage={onOpenImage} />
          ))}
        </View>
      )
    case 'list':
      // 网页版 list-disc/list-decimal + pl-5＝内容起点 20px；小程序用等宽记号列（w-5，右对齐）
      // 复刻同一缩进。行距/字级继承气泡（agent-turn-text，手机 17px/25px），不再本地钉
      // 15px/1.55（那会让列表比正文紧一档）。
      return (
        <View className='my-1.5 flex flex-col gap-1'>
          {block.items.map((item, index) => (
            <View key={index} className='flex items-start'>
              {/* 记号列＝固定 20px 盒子（View 承载宽度，避免 text 的 inline 宽度失效），
                  右对齐 + 4px 内距，正文起点与网页版 pl-5 的 20px 对齐。
                  无序项用 5px 圆点而不是「•」字形：字形在小程序里随字体下沉/偏小，
                  与网页版 list-disc 的实心圆在视觉上对不上；圆点按首行 25px 光学居中。 */}
              <View className='flex w-5 shrink-0 justify-end pr-1'>
                {block.ordered ? (
                  <Text className='agent-turn-text block whitespace-nowrap text-right'>
                    {`${index + 1}.`}
                  </Text>
                ) : (
                  <View className='mt-[10px] h-[5px] w-[5px] rounded-full bg-current opacity-70' />
                )}
              </View>
              <View className='agent-turn-text min-w-0 flex-1 break-words'>
                <RichSpans spans={item} onOpenImage={onOpenImage} />
              </View>
            </View>
          ))}
        </View>
      )
    case 'table':
      // 表格横向可滚动（窄气泡不撑爆），单元格逐格渲染行内 span。
      return (
        <ScrollView scrollX className='my-1.5 rounded-[10px] border border-black/[0.07]'>
          <View className='flex min-w-full flex-col'>
            <View className='flex bg-black/[0.035]'>
              {block.head.map((cell, index) => (
                <View
                  key={index}
                  className='min-w-[110px] flex-1 border-b border-black/[0.08] px-2.5 py-1.5 text-left text-[0.8125rem] font-semibold text-foreground/75'
                >
                  <RichSpans spans={cell} onOpenImage={onOpenImage} />
                </View>
              ))}
            </View>
            {block.rows.map((row, rowIndex) => (
              <View key={rowIndex} className={cn('flex', rowIndex % 2 === 1 && 'bg-black/[0.015]')}>
                {row.map((cell, cellIndex) => (
                  <View
                    key={cellIndex}
                    className='min-w-[110px] flex-1 border-b border-black/[0.05] px-2.5 py-1.5 text-[0.8125rem] text-foreground/80'
                  >
                    <RichSpans spans={cell} onOpenImage={onOpenImage} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
  }
}

export interface AgentMarkdownProps {
  text: string
  /** 该条 assistant 消息是否仍在流式输出（保留与网页版同签名；OpenUI 不渲染）。 */
  isStreaming?: boolean
  /** 既有发送通道（网页版 OpenUI 的 @ToAssistant 按钮用；小程序占位卡不需要）。 */
  onSend?: (text: string) => void
}

export function AgentMarkdown({ text }: AgentMarkdownProps) {
  const blocks = useMemo(() => parseAgentMarkdown(text), [text])
  const imageUrls = useMemo(() => collectImageUrls(blocks), [blocks])

  const openImage = useCallback(
    (src: string) => {
      const urls = imageUrls.includes(src) ? imageUrls : [src]
      void Taro.previewImage({ urls, current: src })
    },
    [imageUrls],
  )

  return (
    <>
      {blocks.map((block, index) => (
        <BlockNode key={index} block={block} onOpenImage={openImage} />
      ))}
    </>
  )
}

export { isImageUrl, isVideoUrl, isAudioUrl } from '../../lib/agent-markdown'
