import { useMemo, useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { Icon } from './icons'
import type { AgentItem } from './types'

/**
 * 导演台小卡。结构 / 类名逐行复制自 src/components/agent-chat/AgentDirectorCard.tsx：
 *   - 壳 / 顶缘亮线 :48-53
 *   - 头行          :55-74
 *   - 方案摘要      :76-78
 *   - 健康问题      :80-94
 *   - 摘要行        :105-110
 *   - 底部操作行    :112-131
 * 平台差异（白名单第 2 条 + 渲染能力）：网页版的 DirectorMiniViewport 是 WebGL
 * 即时视口，小程序无等价物；按网页版 WebGL 失败时的降级面（同尺寸 #0b0f14 视口 +
 * SVG 示意图 + 角标）渲染，不伪造 3D。
 */

type DirectorItem = Extract<AgentItem, { kind: 'director' }>

export interface AgentDirectorCardProps {
  item: DirectorItem
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** UTF-8 字串 → base64（小程序无 btoa；纯查表，不引依赖）。 */
function utf8ToBase64(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) ?? 0
    if (code > 0xffff) i += 1
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += BASE64_CHARS[(triple >> 18) & 63]
    out += BASE64_CHARS[(triple >> 12) & 63]
    out += b1 === undefined ? '=' : BASE64_CHARS[(triple >> 6) & 63]
    out += b2 === undefined ? '=' : BASE64_CHARS[triple & 63]
  }
  return out
}

/** 与网页版 svg-data-url.ts 同义：只接受 <svg 开头的字串（禁 dangerouslySetInnerHTML）。 */
function svgToDataUrl(svg: string | undefined): string | null {
  const trimmed = (svg ?? '').trim()
  if (!trimmed.startsWith('<svg')) return null
  return `data:image/svg+xml;base64,${utf8ToBase64(trimmed)}`
}

/** 帧数 → 秒展示（24fps 对齐 gateway duration_frames 口径）：48 → "2s"。 */
function formatDuration(frames: number): string {
  if (!Number.isFinite(frames) || frames <= 0) return '0s'
  const seconds = frames / 24
  return `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10}s`
}

export function AgentDirectorCard({ item }: AgentDirectorCardProps) {
  const plan = item.plan
  const shot = item.activeShot
  const issues = item.health.issues
  const [schematicBroken, setSchematicBroken] = useState(false)
  // 网页版 WebGL 初始化失败 → topView / cameraView SVG 兜底（DirectorMiniViewport:411-455）。
  const schematicSrc = useMemo(
    () => svgToDataUrl(item.schematic?.top_view_svg) ?? svgToDataUrl(item.schematic?.camera_view_svg),
    [item.schematic],
  )

  return (
    <View className='agent-rise lg-sheet relative flex flex-col gap-2.5 overflow-hidden rounded-[20px] px-3.5 py-3'>
      {/* 顶缘 specular 亮线（:50-53）。 */}
      <View className='pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80' />
      {/* 头行：方案名 + 镜头数 + 健康状态（:55-74）。 */}
      <View className='flex items-center gap-2.5'>
        <View className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-muted-foreground'>
          <Icon name='clapperboard-a40' className='h-4 w-4' />
        </View>
        <Text className='min-w-0 flex-1 truncate text-ios-subhead font-semibold text-foreground'>
          {plan ? plan.name : '导演台'}
        </Text>
        <Text className='inline-flex shrink-0 items-center whitespace-nowrap text-ios-footnote font-semibold tabular-nums text-muted-foreground'>
          {item.counts.shots} 镜头
        </Text>
        <View
          className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-ios-footnote font-semibold tabular-nums',
            item.health.ok ? 'text-[#248A3D]' : 'text-[rgba(120,90,20,0.9)]',
          )}
        >
          <Icon name={item.health.ok ? 'circle-check-green' : 'alert-triangle-issue'} className='h-3.5 w-3.5' />
          <Text>{item.health.ok ? '分镜健康' : `待修正 · ${issues.length}`}</Text>
        </View>
      </View>

      {plan?.summary ? (
        <Text className='text-ios-caption1 leading-relaxed text-muted-foreground'>{plan.summary}</Text>
      ) : null}

      {/* 健康问题列表（琥珀态，先给前 3 条；:80-94）。 */}
      {!item.health.ok && issues.length > 0 ? (
        <View className='flex flex-col gap-1 px-0.5'>
          {issues.slice(0, 3).map((issue, index) => (
            <Text key={`${issue.code}-${index}`} className='text-ios-caption1 leading-snug text-[rgba(120,90,20,0.9)]'>
              {issue.message || issue.code}
            </Text>
          ))}
          {issues.length > 3 ? (
            <Text className='text-ios-caption1 text-[rgba(120,90,20,0.65)]'>
              其余 {issues.length - 3} 条在导演台中查看
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* DirectorMiniViewport（:96-103）：小程序无 WebGL 即时视口，渲染网页版同一降级面。 */}
      <View className='relative flex h-[11.25rem] w-full items-center justify-center overflow-hidden rounded-[12px] bg-[#0b0f14]'>
        {schematicSrc && !schematicBroken ? (
          <Image
            src={schematicSrc}
            mode='aspectFit'
            className='h-full w-full'
            onError={() => setSchematicBroken(true)}
          />
        ) : (
          <Text className='text-ios-caption1 text-white/45'>3D 视口不可用</Text>
        )}
        <View className='absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/45 px-2 py-0.5'>
          <Text className='text-ios-caption1 text-white/70'>3D 视口不可用，显示示意图</Text>
        </View>
      </View>

      {/* 摘要行：active_shot 名 / 时长 / 运镜 / 景别（:105-110）。 */}
      <Text className='truncate text-[0.8125rem] leading-relaxed text-muted-foreground'>
        {shot
          ? `镜头 ${shot.no} · ${shot.name} · ${formatDuration(shot.duration_frames)} · ${shot.camera_move || '未定运镜'}${shot.shot_scale ? ` · ${shot.shot_scale}` : ''}`
          : '暂无活跃镜头'}
      </Text>

      {/* 底部操作行：全屏二期 C6 才开通，disabled + 标注；revision 小字留痕（:112-131）。 */}
      <View className='flex items-center gap-2 pt-0.5'>
        <View className='flex h-11 items-center gap-1.5 rounded-full px-3.5 text-ios-subhead font-medium lg-float text-foreground/45'>
          <Icon name='monitor-play-a45' className='h-4 w-4' />
          <Text>在新分页开启导演台 · 即将上线</Text>
        </View>
        <Text className='ml-auto shrink-0 text-ios-caption2 tabular-nums text-foreground/40'>
          rev {item.revision}
        </Text>
      </View>
    </View>
  )
}
