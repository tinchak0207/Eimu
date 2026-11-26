import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, Text, Video, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../../lib/cn'
import { request } from '../../lib/request'
import { Icon } from './icons'

/**
 * 用户消息里的附件卡（真源：src/components/agent-chat/AgentAttachmentCards.tsx，412 行）。
 *
 * 罪状 1：`[ATTACHMENTS_BLOCK]` 里的裸文本行不再示人——正文摘干净，附件解析成
 * 微信式卡片（图缩略 / 影片气泡 / 抽帧组 / 文档横条），渲染在正文下方。
 *
 * 平台差异：
 *   - <img>/<video> → <Image>/<Video>；点图看原图 → Taro.previewImage；
 *   - 票据：站内代理 `POST /api/agent/sessions/:id/uploads-ticket`（与网页版同一契约），
 *     session id 优先取附件 path 自带的 `uploads/<session>/…` 段——转录层拿不到
 *     AgentChatPanel 的 sessionId 时仍能铸票；铸不出票静默降级成文档卡，绝不破图。
 */

// ─────────────────────────── 解析（纯函数，与网页版逐条同义）

export interface AgentAttachmentRef {
  kind: 'image' | 'video' | 'document'
  path?: string
  name?: string
  mime?: string
  size?: number
}

export interface ParsedUserAttachments {
  /** 摘除附件区块（含前后多余空行）后的正文。 */
  cleanText: string
  refs: AgentAttachmentRef[]
  /**
   * 正文是机器注入/摘不干净的残留：调用方必须整段不回显。
   * （内部收件箱通知、未闭合标记块、摘完仍剩标记或 JSON 尾巴都走这里。）
   */
  suppressed: boolean
}

const ATTACHMENTS_BLOCK_OPEN = '[ATTACHMENTS_BLOCK]'
const ATTACHMENTS_BLOCK_CLOSE = '[/ATTACHMENTS_BLOCK]'
const ATTACHMENTS_BLOCK_RE = /\[ATTACHMENTS_BLOCK\]([\s\S]*?)\[\/ATTACHMENTS_BLOCK\]/g
/** 区块行：「1. <path> | <mime> | <size>」。 */
const ATTACHMENT_LINE_RE = /^\s*\d+\.\s*(.+?)\s*$/
/** 影片抽帧的文件名（video-frames.ts 的命名契约：<base>-frame-<N>.jpg）。 */
const VIDEO_FRAME_NAME_RE = /^(.*)-frame-\d+\.jpg$/i

/**
 * 已知的系统注入前缀（user role 投递、但不是用户写的）。
 * 真源：services/gateway/job-delivery.ts:239（耐久收件箱）、
 * services/opencode-runtime/plugin/eimu-guard.ts:521（后台命令通知）。
 * 这些讯息没有 metadata 可辨识，只能在展示层按前缀拦下，绝不冒充用户气泡。
 */
const INTERNAL_INJECTION_RE = /^(?:【生成结果耐久收件箱】|后台命令已结束[。．.])/

/** 机器负荷的键名（只用来识别「尾巴是系统 JSON」而非用户手写的代码片段）。 */
const MACHINE_JSON_KEY_RE =
  /"(?:task_id|delivery_id|download_tool|artifacts|mimeType|outputIndex|originalHttpStatus|actualSupplierModelId|sessionID|messageID)"\s*:/

/** 从 JSON 尾巴里认出系统负荷的起始行（行首的 [ 或 {，且含机器键名）。 */
function orphanJsonTailStart(text: string): number {
  const trimmed = text.trimEnd()
  for (let i = trimmed.length - 1; i > 0; i -= 1) {
    const ch = trimmed[i]
    if (ch !== '[' && ch !== '{') continue
    if (trimmed[i - 1] !== '\n') continue
    const candidate = trimmed.slice(i)
    if (!MACHINE_JSON_KEY_RE.test(candidate)) continue
    const closed = (candidate.startsWith('[') && candidate.endsWith(']')) || (candidate.startsWith('{') && candidate.endsWith('}'))
    if (closed || candidate.length > 40) return i
  }
  return -1
}

/** 区块正文 → refs（「[附件]」这类标题行自然被行正则跳过）。 */
function collectAttachmentRefs(inner: string, refs: AgentAttachmentRef[]): void {
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.match(ATTACHMENT_LINE_RE)
    if (!line) continue
    const [pathPart, mimePart, sizePart] = line[1].split('|').map((part) => part.trim())
    if (!pathPart) continue
    const mime = mimePart ?? ''
    const sizeNum = sizePart === undefined || sizePart === '' ? NaN : Number(sizePart)
    refs.push({
      kind: kindFromMime(mime),
      path: pathPart,
      name: attachmentDisplayName(pathPart),
      ...(mime ? { mime } : {}),
      ...(Number.isFinite(sizeNum) ? { size: sizeNum } : {}),
    })
  }
}

function kindFromMime(mime: string): AgentAttachmentRef['kind'] {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

/** path 取 basename 并解掉 URL 编码噪音；解不动（含孤立 % 的怪名）原样保留。 */
export function attachmentDisplayName(path: string): string {
  const raw = path.split('/').pop() ?? path
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 从用户消息文本里摘除 [ATTACHMENTS_BLOCK]…[/ATTACHMENTS_BLOCK] 整段并解析 refs。
 *
 * 边界处理（与网页版同义，另补三类历史脏数据）：
 *   1. 完整的标记块可能不止一个 → 全量摘除；
 *   2. 只有开标记没有闭标记（被截断/旧版网关）→ 从开标记起到文末整段摘除；
 *   3. 摘完仍残留孤立 JSON 尾巴（系统注入的 jobs 数组）→ 一并摘除。
 * 摘不干净（仍见标记、正文本身就是机器 JSON）或命中已知系统注入前缀时，
 * `suppressed=true`，调用方不得回显正文。
 */
export function parseUserAttachmentBlock(text: string): ParsedUserAttachments {
  const refs: AgentAttachmentRef[] = []
  let body = text

  // 1. 完整区块（可能多个）：摘除并收集 refs。
  body = body.replace(ATTACHMENTS_BLOCK_RE, (_full, inner: string) => {
    collectAttachmentRefs(inner, refs)
    return '\n'
  })

  // 2. 未闭合区块：开标记之后全是区块内容（含尾部 JSON），到文末全摘。
  const openAt = body.indexOf(ATTACHMENTS_BLOCK_OPEN)
  if (openAt !== -1) {
    collectAttachmentRefs(body.slice(openAt + ATTACHMENTS_BLOCK_OPEN.length), refs)
    body = body.slice(0, openAt)
  }

  // 3. 无标记块的孤立 JSON 尾巴：整行起的系统 JSON 一并摘掉，不铺进正文。
  const jsonAt = orphanJsonTailStart(body)
  if (jsonAt !== -1) body = body.slice(0, jsonAt)

  const clean = body.trim()

  // 摘不干净：任何标记残留、或正文本身就是机器 JSON。
  const markerLeft = clean.includes(ATTACHMENTS_BLOCK_OPEN) || clean.includes(ATTACHMENTS_BLOCK_CLOSE)
  const machineOnly = /^[[{]/.test(clean) && MACHINE_JSON_KEY_RE.test(clean)
  if (markerLeft || machineOnly) return { cleanText: '', refs, suppressed: true }

  // 已知系统注入（收件箱/后台命令通知）不是用户写的：整段不回显。
  if (INTERNAL_INJECTION_RE.test(clean)) return { cleanText: '', refs, suppressed: true }

  return { cleanText: clean, refs, suppressed: false }
}

// ─────────────────────────── 卡片模型（影片抽帧分组）

export type AttachmentCardModel =
  | { kind: 'single'; ref: AgentAttachmentRef }
  | { kind: 'video-group'; name: string; frames: AgentAttachmentRef[] }

function dirOf(path: string | undefined): string {
  const parts = (path ?? '').split('/')
  return parts.slice(0, -1).join('/')
}

/** 连续出现、同目录同前缀的抽帧（≥2 张）合并成一张视频卡；其余逐张原样。 */
export function groupAttachmentRefs(refs: AgentAttachmentRef[]): AttachmentCardModel[] {
  const out: AttachmentCardModel[] = []
  let i = 0
  while (i < refs.length) {
    const ref = refs[i]
    const name = ref.name ?? ''
    const m = name.match(VIDEO_FRAME_NAME_RE)
    if (ref.kind === 'image' && m) {
      const groupKey = `${dirOf(ref.path)}/${m[1].toLowerCase()}`
      const frames: AgentAttachmentRef[] = []
      let j = i
      while (j < refs.length) {
        const candidate = refs[j]
        const candidateMatch = (candidate.name ?? '').match(VIDEO_FRAME_NAME_RE)
        if (
          candidate.kind === 'image' &&
          candidateMatch &&
          `${dirOf(candidate.path)}/${candidateMatch[1].toLowerCase()}` === groupKey
        ) {
          frames.push(candidate)
          j += 1
        } else {
          break
        }
      }
      if (frames.length > 1) {
        out.push({ kind: 'video-group', name: attachmentDisplayName(m[1]), frames })
        i = j
        continue
      }
    }
    out.push({ kind: 'single', ref })
    i += 1
  }
  return out
}

/** 这组卡要不要读票：image 缩略、video-group 帧、video 原片气泡都要。 */
export function groupsNeedTicket(groups: AttachmentCardModel[]): boolean {
  return groups.some((group) => group.kind === 'video-group' || group.ref.kind === 'image' || group.ref.kind === 'video')
}

// ─────────────────────────── 票据（站内代理铸票，静默降级）

// 从 .env 注入（TARO_APP_AGENT_ORIGIN），默认生产域名
const AGENT_UPLOADS_ORIGIN = process.env.TARO_APP_AGENT_ORIGIN || 'https://store.tinchak0207.xyz'
const TICKET_SAFETY_MARGIN_MS = 60_000

interface TicketValue {
  value: string
  expiresAt: number
}

/** 附件 path 自带会话段（`uploads/<session>/<name>`）；拿不到再退回调用方的 sessionId。 */
export function sessionFromAttachmentPath(path: string | undefined): string | null {
  const rel = (path ?? '').replace(/^\/+/, '').replace(/^agent\/v1\//, '')
  const match = /^uploads\/([^/]+)\//.exec(rel)
  return match ? match[1] : null
}

/** 拼网关直连 URL（与网页版 buildAssetUrl 同一拼法）。 */
export function buildAssetUrl(sessionId: string, path: string, ticket: string): string {
  let rel = path.replace(/^\/+/, '').replace(/^agent\/v1\//, '')
  if (!rel.startsWith('uploads/') && sessionId) {
    rel = `uploads/${sessionId}/${rel}`
  }
  return `${AGENT_UPLOADS_ORIGIN}/agent/v1/${rel}?t=${encodeURIComponent(ticket)}`
}

function freshTicketValue(ticket: TicketValue | null): string | null {
  if (ticket === null) return null
  return Date.now() < ticket.expiresAt - TICKET_SAFETY_MARGIN_MS ? ticket.value : null
}

function useUploadsTicket(sessionId: string | null, needed: boolean): {
  ticket: string | null
  minting: boolean
} {
  const [ticket, setTicket] = useState<TicketValue | null>(null)
  const [minting, setMinting] = useState(false)
  const [failed, setFailed] = useState(false)
  const inflightRef = useRef<string | null>(null)

  // 换会话：旧票按会话铸的，直接作废。
  useEffect(() => {
    inflightRef.current = null
    setTicket(null)
    setMinting(false)
    setFailed(false)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !needed) return
    if (freshTicketValue(ticket) !== null || failed || minting || inflightRef.current !== null) return
    const epoch = sessionId
    inflightRef.current = epoch
    setMinting(true)
    request<Record<string, unknown>>({
      path: `/api/agent/sessions/${encodeURIComponent(epoch)}/uploads-ticket`,
      method: 'POST',
      data: {},
    })
      .then((data) => {
        if (inflightRef.current !== epoch) return
        const value = typeof data?.ticket === 'string' ? data.ticket : ''
        if (!value) throw new Error('ticket missing')
        const ttl =
          typeof data?.expires_in_ms === 'number' && Number.isFinite(data.expires_in_ms) && data.expires_in_ms > 0
            ? data.expires_in_ms
            : 60 * 60 * 1000
        setTicket({ value, expiresAt: Date.now() + ttl })
        setFailed(false)
      })
      .catch(() => {
        if (inflightRef.current === epoch) setFailed(true)
      })
      .then(() => {
        // 不用 Promise.finally：基础库 ES2017 目标下它不一定存在。
        if (inflightRef.current === epoch) {
          inflightRef.current = null
          setMinting(false)
        }
      })
  }, [sessionId, needed, ticket, failed, minting])

  return { ticket: freshTicketValue(ticket), minting }
}

// ─────────────────────────── 卡片

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '未知大小'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 文档式横条卡：也是 image 加载失败的统一降级壳。不可点（没有预览能力
 * 就不装有点击的样子）。
 */
function DocumentCard({ attRef }: { attRef: AgentAttachmentRef }) {
  return (
    <View className='flex items-center gap-2 rounded-ios-xl bg-foreground/[0.08] px-3 py-2'>
      <Icon name='file-text-a56' className='h-4 w-4 shrink-0' />
      <Text className='min-w-0 flex-1 truncate text-ios-footnote font-medium text-foreground'>
        {attRef.name ?? '附件'}
      </Text>
      {typeof attRef.size === 'number' && Number.isFinite(attRef.size) ? (
        <Text className='shrink-0 text-ios-caption1 tabular-nums text-muted-foreground'>
          {formatBytes(attRef.size)}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * 图片缩略（主图与大帧共用）。降级链路：
 * 铸票中 → 骨架；铸票失败 / 无票 / <Image> 挂掉 → 文档式横条卡，绝不破图。
 */
export function AttachmentThumb({
  sessionId,
  attRef,
  ticket,
  minting,
  imgClassName,
  wrapperClassName,
  chromeClassName,
  skeletonClassName,
}: {
  sessionId: string | null
  attRef: AgentAttachmentRef
  ticket: string | null
  minting: boolean
  imgClassName: string
  wrapperClassName?: string
  chromeClassName?: string
  /** 铸票中骨架的完整类名；不给则沿用 wrapper+img 的旧拼法（单图卡给出网页版同款尺寸）。 */
  skeletonClassName?: string
}) {
  const [broken, setBroken] = useState(false)
  const url = ticket !== null && attRef.path ? buildAssetUrl(sessionId ?? '', attRef.path, ticket) : null

  // 与网页版同一优先级（AgentAttachmentCards.tsx:243-262）：坏图/无票直接降级文档卡，
  // 铸票中才出骨架。
  if (broken || url === null) {
    return (
      <View className={cn('min-w-0', wrapperClassName)}>
        <DocumentCard attRef={attRef} />
      </View>
    )
  }

  if (minting) {
    return (
      <View
        className={
          skeletonClassName ??
          cn('animate-pulse rounded-ios-lg bg-foreground/10', wrapperClassName, imgClassName)
        }
      />
    )
  }

  return (
    <View
      className={cn('block overflow-hidden', wrapperClassName, chromeClassName)}
      onClick={() => void Taro.previewImage({ urls: [url], current: url })}
    >
      <Image
        src={url}
        mode='aspectFill'
        lazyLoad
        aria-label={attRef.name ?? '附件图片'}
        className={imgClassName}
        onError={() => setBroken(true)}
      />
    </View>
  )
}

/** 原片直传成功的影片气泡（微信式）：一个可播 <Video>，坏票降级成文档卡。 */
export function VideoBubble({
  sessionId,
  attRef,
  ticket,
  minting,
}: {
  sessionId: string | null
  attRef: AgentAttachmentRef
  ticket: string | null
  minting: boolean
}) {
  const [broken, setBroken] = useState(false)
  const url = ticket !== null && attRef.path ? buildAssetUrl(sessionId ?? '', attRef.path, ticket) : null

  if (broken || url === null) {
    return <DocumentCard attRef={attRef} />
  }
  if (minting) {
    return <View className='h-32 w-full max-w-xs animate-pulse rounded-ios-lg bg-foreground/10' />
  }
  return (
    <Video
      src={url}
      controls
      objectFit='contain'
      aria-label={attRef.name ?? '视频附件'}
      className='max-h-56 w-full max-w-xs rounded-ios-lg bg-black'
      style={{ height: '224px' }}
      onError={() => setBroken(true)}
    />
  )
}

export interface AgentAttachmentCardsProps {
  refs: AgentAttachmentRef[]
  /** 当前会话 id：path 里没有会话段时兜底。缺省时全部降级成文档式卡。 */
  sessionId?: string | null
}

export function AgentAttachmentCards({ refs, sessionId }: AgentAttachmentCardsProps) {
  const groups = useMemo(() => groupAttachmentRefs(refs), [refs])
  const pathSession = useMemo(() => {
    for (const ref of refs) {
      const found = sessionFromAttachmentPath(ref.path)
      if (found) return found
    }
    return null
  }, [refs])
  const effectiveSession = pathSession ?? sessionId ?? null
  const needsTicket = groupsNeedTicket(groups)
  const { ticket, minting } = useUploadsTicket(effectiveSession, needsTicket)

  if (groups.length === 0) return null

  return (
    <View className='mt-2 flex flex-col gap-1.5'>
      {groups.map((group, index) => {
        if (group.kind === 'video-group') {
          return (
            <View key={`video-${group.name}-${index}`} className='rounded-ios-xl bg-foreground/[0.06] p-2'>
              <View className='flex items-center gap-1.5 px-0.5 pb-1.5'>
                <Icon name='film-a56' className='h-3.5 w-3.5 shrink-0' />
                <Text className='min-w-0 flex-1 truncate text-ios-footnote font-semibold text-foreground'>
                  {group.name}
                </Text>
                <Text className='shrink-0 rounded-full bg-foreground/10 px-2 py-0.5 text-ios-caption1 font-medium text-foreground/80'>
                  视频
                </Text>
              </View>
              <View className='flex gap-1.5'>
                {group.frames.map((frame) => (
                  <AttachmentThumb
                    key={frame.path ?? frame.name}
                    sessionId={effectiveSession}
                    attRef={frame}
                    ticket={ticket}
                    minting={minting}
                    wrapperClassName='h-20 min-w-0 flex-1'
                    chromeClassName='rounded-ios-lg'
                    imgClassName='h-20 w-full object-cover'
                  />
                ))}
              </View>
            </View>
          )
        }

        const ref = group.ref
        if (ref.kind === 'video') {
          return (
            <VideoBubble
              key={ref.path ?? `video-${index}`}
              sessionId={effectiveSession}
              attRef={ref}
              ticket={ticket}
              minting={minting}
            />
          )
        }
        if (ref.kind === 'image') {
          return (
            <AttachmentThumb
              key={ref.path ?? `img-${index}`}
              sessionId={effectiveSession}
              attRef={ref}
              ticket={ticket}
              minting={minting}
              wrapperClassName='w-fit max-w-full self-end'
              chromeClassName='rounded-[18px] border border-black/[0.06] bg-black/[0.04]'
              skeletonClassName='h-60 w-48 animate-pulse self-end rounded-[18px] border border-black/[0.06] bg-black/[0.04]'
              imgClassName='block max-h-60 w-auto max-w-[min(100%,260px)] object-cover'
            />
          )
        }
        return <DocumentCard key={ref.path ?? `doc-${index}`} attRef={ref} />
      })}
    </View>
  )
}
