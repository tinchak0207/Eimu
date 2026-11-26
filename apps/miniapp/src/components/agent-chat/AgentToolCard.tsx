import { useState } from 'react'
import { ScrollView, Text, View } from '@tarojs/components'
import { cn } from '../../lib/cn'
import { classifiedErrorStatus, sanitizeDisplayError } from '../../lib/agent-error-status'
import { AgentParamDisclosure } from './AgentParamDisclosure'
import { Icon, type IconName } from './icons'
import { toolDisplayName } from './tool-names'
import type { AgentItem, AgentToolAuthScope } from './types'

/**
 * 工具卡（真源：src/components/agent-chat/AgentToolCard.tsx，534 行）。
 *
 * 折叠行：类型图标 + 人话标题 + 花费 + 状态图标/状态词；
 * 展开区（AgentParamDisclosure 底部抽屉）：参数先解析成 key：value，
 *   **raw JSON 绝不铺在默认渲染里**（F2）；错误若本身是 JSON，也只给可折叠原文，
 *   不把半截/完整 JSON 当正文糊在气泡里。
 * 类型化输出：进度条（tool.progress）、失败原因（分类状态位 / 人话原文）、
 * 二进制警示（binary）、需要授权（needs_auth 三选一，小程序置灰）。
 */

const TOOL_ROW_EXACT: Record<string, IconName> = {
  bash: 'wrench-a40',
  read: 'search-a40',
  write: 'layout-grid-a40',
  edit: 'layout-grid-a40',
  glob: 'search-a40',
  grep: 'search-a40',
  ls: 'search-a40',
  webfetch: 'search-a40',
  fetch: 'search-a40',
  patch: 'layout-grid-a40',
  todowrite: 'layout-grid-a40',
  todoread: 'layout-grid-a40',
  task: 'bot-a40',
}

const TOOL_ROW_RULES: Array<{ match: RegExp; icon: IconName }> = [
  { match: /subagent/, icon: 'bot-a40' },
  { match: /quote|price|coin|cost|billing/, icon: 'coins-a40' },
  { match: /video|film|trailer|keyframe|last_frame|timeline|editing|movie|clip/, icon: 'clapperboard-a40' },
  { match: /music|audio|tts|speak|voice|sound|blender|gltf/, icon: 'wrench-a40' },
  {
    match:
      /search|grep|glob|read|fetch|web|doc|vision|bible|script|story|asset|provenance|evidence|audit|qc|consistency|analyze|inspect|lint|find/,
    icon: 'search-a40',
  },
  { match: /canvas|workflow|director/, icon: 'layout-grid-a40' },
  {
    match:
      /image|img|photo|picture|generat|render|repair|upscale|remove|tryon|garment|product|aspect|reflow|moodboard|emotion|sketch|style|character|cast|canonical|scene|shot|cover/,
    icon: 'image-a40',
  },
  { match: /node|layout|draw|write|edit|patch|apply|connect|rerun/, icon: 'layout-grid-a40' },
]

/** 工具 id → 行首类型图标；认不出来一律扳手（不假造类型）。 */
export function toolRowIcon(tool: string): IconName {
  const id = tool.trim().toLowerCase()
  const exact = TOOL_ROW_EXACT[id]
  if (exact !== undefined) return exact
  for (const rule of TOOL_ROW_RULES) {
    if (rule.match.test(id)) return rule.icon
  }
  return 'wrench-a40'
}

interface ToolRowStatusMeta {
  word: string
  wordTone: string
  icon?: IconName
  spin?: boolean
  /** 网页版状态图标的色调（running/needs_auth = text-ios-blue/70；PNG 已烘实色，用透明度还原）。 */
  iconTone?: string
}

/** 未知/枚举外状态（历史里出现过 stopped/cancelled）的中性兜底：不抛错、不装图标。 */
const UNKNOWN_STATUS_META: ToolRowStatusMeta = { word: '未知', wordTone: 'text-foreground/45' }

const STATUS_META: Record<string, ToolRowStatusMeta> = {
  running: { word: '运行中…', wordTone: 'text-ios-blue', icon: 'loader-2-blue', spin: true, iconTone: 'opacity-70' },
  pending: { word: '运行中…', wordTone: 'text-ios-blue', icon: 'loader-2-blue', spin: true, iconTone: 'opacity-70' },
  ok: { word: '完成', wordTone: 'text-foreground/45', icon: 'check-green' },
  failed: { word: '失败', wordTone: 'text-ios-red' },
  needs_auth: { word: '需要授权', wordTone: 'text-ios-blue', icon: 'lock-blue', iconTone: 'opacity-70' },
}

/** 展示用的金币数：整数原样，浮点去掉多余尾巴。 */
function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * 参数摘要的人话预览（F2）：只挑人能读懂的白名单栏位，挑不到就回 undefined
 * ——默认渲染绝不把 raw JSON 端到用户面前。完整参数收进抽屉。
 */
export function toolArgPreview(args: string): string | undefined {
  const t = args.trim()
  if (t.length === 0) return undefined
  const humanize = (v: string): string | undefined => {
    const s = v.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim()
    return s.length > 0 ? s : undefined
  }
  let obj: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(t)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>
    }
  } catch {
    // 被网关截断的半截 JSON：下面用白名单栏位做宽松提取。
  }
  if (obj) {
    for (const key of ['label', 'command', 'filePath', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description']) {
      const v = obj[key]
      if (typeof v === 'string') {
        const s = humanize(v)
        if (s !== undefined) return s
      }
    }
    return undefined
  }
  if (t.startsWith('{')) {
    const m = /"(label|command|filePath|file_path|pattern|query|url|prompt|description)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t)
    if (m) return humanize(m[2])
    return undefined
  }
  return humanize(t.split('\n')[0])
}

const AUTH_SCOPE_LABELS: Record<AgentToolAuthScope, string> = {
  once: '允许一次',
  session: '本会话允许此目录',
  permanent: '永久允许（加入本机授权清单）',
}

/** 工具错误若本身是 JSON（对象/数组），绝不裸铺：给一句人话 + 可折叠原文。 */
function looksLikeJson(text: string): boolean {
  const t = text.trim()
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
}

function RawPayload({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <View className='flex flex-col gap-1'>
      <Text className='text-ios-caption1 leading-relaxed text-destructive'>
        工具返回了结构化数据，点此查看原文
      </Text>
      <Text className='break-all text-ios-caption1 text-destructive/70' onClick={() => setOpen((v) => !v)}>
        {open ? '收起原文' : '展开原文'}
      </Text>
      {open ? (
        <ScrollView scrollX className='max-h-40 rounded-lg bg-destructive/[0.06] px-2 py-1.5'>
          <Text className='whitespace-pre font-mono text-ios-caption1 leading-[1.5] text-destructive/80'>
            {text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  )
}

export interface AgentToolCardProps {
  item: Extract<AgentItem, { kind: 'tool' }>
  /** 本机档案授权回传（小程序无本机文件通道，保留签名、按钮置灰）。 */
  onAuthorize?: (scope: AgentToolAuthScope, root?: string) => void | Promise<void>
}

export function AgentToolCard({ item, onAuthorize }: AgentToolCardProps) {
  const status = STATUS_META[item.status] ?? UNKNOWN_STATUS_META
  const running = item.status === 'running'
  const spinning = item.status === 'running' || item.status === 'pending'
  const progress = running ? item.progress : undefined
  const pct = progress ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  const displayName = toolDisplayName(item.tool)
  const toolIcon = toolRowIcon(item.tool)
  const [authBusy, setAuthBusy] = useState<AgentToolAuthScope | null>(null)
  const options = item.authorization?.options ?? []
  const panelMounted = item.argsSummary !== undefined
  const nakedCost = !panelMounted && item.costCoins !== undefined ? item.costCoins : undefined
  const errorStatus = classifiedErrorStatus(item.errorCode)

  const renderRow = (api: { open: boolean; toggle?: () => void }) => {
    const content = (
      <>
        {/* 类型图标＝网页版 text-foreground/40；PNG（*-a40）已烘 40%，不再叠 opacity（会变 24% 偏淡）。 */}
        <Icon name={toolIcon} className='h-3.5 w-3.5 shrink-0' />
        <Text className='min-w-0 flex-1 truncate text-ios-footnote text-foreground/60'>{displayName}</Text>
        {nakedCost !== undefined ? (
          <View className='flex shrink-0 items-center gap-1 text-ios-footnote text-muted-foreground'>
            <Icon name='coins-a40' className='h-3 w-3' />
            <Text className='tabular-nums'>{formatCoins(nakedCost)} 币</Text>
          </View>
        ) : null}
        {status.icon !== undefined ? (
          <Icon
            name={status.icon}
            className={cn('h-3.5 w-3.5 shrink-0', spinning && 'ic-spin', status.iconTone)}
          />
        ) : null}
        <Text className={cn('shrink-0 whitespace-nowrap text-ios-footnote tabular-nums', status.wordTone)}>
          {status.word}
        </Text>
      </>
    )
    if (api.toggle === undefined) {
      return <View className='-mx-2 flex min-h-11 w-full items-center gap-2 rounded-[12px] px-2'>{content}</View>
    }
    return (
      <View
        className='-mx-2 flex min-h-11 w-full items-center gap-2 rounded-[12px] px-2'
        onClick={api.toggle}
      >
        {content}
      </View>
    )
  }

  return (
    <View className='agent-rise flex flex-col gap-1'>
      {item.argsSummary !== undefined ? (
        <AgentParamDisclosure
          argsSummary={item.argsSummary}
          idPrefix={`agent-args-${item.id}`}
          toolName={item.tool}
          costCoins={item.costCoins}
          trigger={(api) => renderRow(api)}
        />
      ) : (
        renderRow({ open: false })
      )}

      {/* 逐镜/逐项进度：真实分母才画条。 */}
      {progress ? (
        <View className='ml-[22px] flex flex-col gap-1'>
          <Text className='break-words text-ios-caption1 leading-[1.4] text-muted-foreground'>
            {progress.label ?? '处理中'} · 已完成 {progress.done}/{progress.total}
          </Text>
          <View className='h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]'>
            <View className='lg-transition h-full rounded-full bg-ios-blue' style={{ width: `${pct}%` }} />
          </View>
        </View>
      ) : null}

      {/* 失败原因两态：分类状态位优先；未分类照旧展示人话原文。JSON 原文折叠。 */}
      {item.status === 'failed'
        ? errorStatus
          ? (
              <View className='ml-[22px] flex flex-col gap-0.5 rounded-xl bg-destructive/10 px-2.5 py-1.5'>
                <Text className='text-ios-caption1 font-medium leading-relaxed text-destructive'>
                  {errorStatus.label}
                  <Text className='font-normal text-destructive/80'>
                    {' · '}
                    {errorStatus.retryable ? '可重试' : '需人工处理'}
                  </Text>
                </Text>
                <Text className='break-words text-ios-caption1 leading-relaxed text-destructive/80'>
                  {errorStatus.hint}
                </Text>
              </View>
            )
          : item.error
            ? (
                <View className='ml-[22px] rounded-xl bg-destructive/10 px-2.5 py-1.5'>
                  {looksLikeJson(item.error) ? (
                    <RawPayload text={sanitizeDisplayError(item.error)} />
                  ) : (
                    <Text className='break-words text-ios-caption1 leading-relaxed text-destructive'>
                      {sanitizeDisplayError(item.error)}
                    </Text>
                  )}
                </View>
              )
            : null
        : null}

      {/* 需要授权（缺陷 C）：语义说「需要授权」而非「完成」，小程序端按钮置灰。 */}
      {item.status === 'needs_auth' ? (
        <View className='ml-[22px] flex flex-col gap-2 rounded-[12px] bg-ios-blue/[0.06] p-2.5'>
          <View className='flex items-start gap-2'>
            <Icon name='lock-blue' className='mt-0.5 h-3.5 w-3.5 shrink-0' />
            <View className='min-w-0 flex-1'>
              <Text className='text-ios-footnote font-medium text-foreground/75'>需要授权才能读取本机文件</Text>
              {item.authorization?.root ? (
                <Text className='mt-0.5 break-words text-ios-caption1 text-foreground/55'>
                  路径：{item.authorization.root}
                </Text>
              ) : null}
              {item.authorization?.reason ? (
                <Text className='mt-0.5 break-words text-ios-caption1 text-foreground/55'>
                  {item.authorization.reason}
                </Text>
              ) : null}
              <Text className='mt-0.5 text-ios-caption1 text-foreground/45'>
                尚未读取任何文件；选择授权范围后才会读取。
              </Text>
            </View>
          </View>
          <View className='flex flex-col gap-1.5'>
            {(options.length > 0 ? options : (['once', 'session', 'permanent'] as AgentToolAuthScope[])).map((scope) => (
              <View
                key={scope}
                className={cn(
                  'flex min-h-9 w-full items-center justify-center gap-1.5 rounded-full border border-ios-blue/30 bg-white/60 px-3 text-ios-footnote font-medium text-ios-blue',
                  onAuthorize === undefined && 'opacity-50',
                )}
                onClick={() => {
                  if (onAuthorize === undefined || authBusy !== null) return
                  setAuthBusy(scope)
                  Promise.resolve(onAuthorize(scope, item.authorization?.root)).catch(() => setAuthBusy(null))
                }}
              >
                {authBusy === scope ? <Icon name='loader-2-blue' className='ic-spin h-3.5 w-3.5' /> : null}
                <Text>{AUTH_SCOPE_LABELS[scope]}</Text>
              </View>
            ))}
          </View>
          <Text className='break-words text-ios-caption1 text-foreground/55'>小程序端不提供本机文件读取。</Text>
        </View>
      ) : null}

      {/* 二进位读取：绝不把乱码当成功内容呈现。 */}
      {item.binary ? (
        <View className='ml-[22px] flex flex-col gap-1 rounded-[12px] bg-amber-500/[0.10] p-2.5'>
          <View className='flex items-start gap-2'>
            <Icon name='file-warning-amber' className='mt-0.5 h-3.5 w-3.5 shrink-0' />
            <View className='min-w-0 flex-1'>
              <Text className='text-ios-footnote font-medium text-foreground/80'>这是二进制文件，无法当文字读取</Text>
              <Text className='mt-0.5 break-words text-ios-caption1 text-foreground/55'>
                请改用附件下载查看原始内容；直接按文字读只会得到乱码。
              </Text>
              {item.readBytes !== undefined || item.totalBytes !== undefined ? (
                <Text className='mt-0.5 text-ios-caption1 tabular-nums text-foreground/45'>
                  已读 {item.readBytes ?? '?'} / 文件 {item.totalBytes ?? '?'} 字节
                  {item.truncated === true ? '（已截断）' : ''}
                </Text>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  )
}
