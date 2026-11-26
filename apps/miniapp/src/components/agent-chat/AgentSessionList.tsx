// 历史会话列表：载入中 / 失败 / 空态三态 + 相对时间 + 状态点。
//
// 真源逐分支照搬 src/components/agent-chat/AgentSessionList.tsx（197 行）：
//   - 三态：sessions === null 且 loadError → 失败；null → 载入中；[] → 空态 CTA；
//     有数据但搜寻无命中 → 「没有匹配的对话」；
//   - 相对时间：今天 HH:mm / 昨天 / 7 天内星期几 / 今年 M月D日 / 跨年 YYYY/M/D；
//   - 状态点：网关 sessions.status（running / waiting / idle），缺省 idle；
//   - 当前会话浅灰圆角高亮，切换中的行半透明并转圈。
//
// 元件保持受控（query 由外层持有），供抽屉直接使用；重命名 / 删除通过
// 可选回调交给外层（外层用 Taro.showModal / showActionSheet 落地）。

import { Text, View } from '@tarojs/components'
import type { AgentSessionSummary } from '../../lib/agent'
import { Icon } from './icons'

/** 取本地时区当天 00:00：「今天」是自然日，不是「距今 24 小时」。 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/**
 * Grok 侧栏式相对日期（逐档手写，任何环境输出一致）：
 *   今天 → HH:mm（24h）；昨天 → 「昨天」；7 天内 → 星期几；
 *   更早（同年）→ M月D日；跨年 → YYYY/M/D。
 * now 可注入，便于测试。
 */
export function formatSessionRelativeTime(timestamp: number, now: number = Date.now()): string {
  const todayStart = startOfLocalDay(now)
  if (timestamp >= todayStart) {
    const d = new Date(timestamp)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
  if (timestamp >= yesterdayStart) return '昨天'
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000
  const d = new Date(timestamp)
  if (timestamp >= weekStart) return WEEKDAYS_ZH[d.getDay()]
  const nowDate = new Date(now)
  if (d.getFullYear() === nowDate.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 时间戳栏位读取：数字或可解析字符串；缺失回 0。 */
export function readSessionTimestamp(
  it: AgentSessionSummary,
  key: 'created_at' | 'last_activity_at' | 'updated_at',
): number {
  const raw = (it as unknown as Record<string, unknown>)[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 会话标题（双轨：服务端/本地标题优先，无标题降级时间标签）。 */
export function formatSessionLabel(it: AgentSessionSummary): string {
  const title = typeof it.title === 'string' ? it.title.trim() : ''
  if (title) return title
  const created = readSessionTimestamp(it, 'created_at') || readSessionTimestamp(it, 'updated_at')
  if (!created) return '未命名对话'
  const d = new Date(created)
  const date = `${d.getMonth() + 1}/${d.getDate()}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} ${time} 的对话`
}

/** 搜寻过滤：对显示出来的标题做大小写不敏感包含匹配。 */
export function filterAgentSessions(
  list: AgentSessionSummary[],
  query: string,
  formatLabel: (it: AgentSessionSummary) => string = formatSessionLabel,
): AgentSessionSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((it) => formatLabel(it).toLowerCase().includes(q))
}

/** 状态点三态（网关 sessions.status；缺字段按 idle）。 */
const SESSION_STATUS_META: Record<
  NonNullable<AgentSessionSummary['status']>,
  { dotClass: string; label: string }
> = {
  running: { dotClass: 'bg-ios-blue animate-pulse', label: '运转中' },
  waiting: { dotClass: 'bg-ios-orange', label: '等待回答' },
  idle: { dotClass: 'bg-foreground/15', label: '已静置' },
}

/** 脏状态字串按 idle 处理（契约外的值不得让列表整块崩掉）。 */
function sessionStatusMeta(status: unknown): { dotClass: string; label: string } {
  if (status === 'running' || status === 'waiting' || status === 'idle') return SESSION_STATUS_META[status]
  return SESSION_STATUS_META.idle
}

/** 两行截断（网版 line-clamp-2；小程序未装 line-clamp 插件，同语义内联）。 */
const CLAMP_2 = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
  maxWidth: '100%',
}

export interface AgentSessionListProps {
  /** null = 未加载；[] = 已加载但为空。 */
  sessions: AgentSessionSummary[] | null
  loadError?: string | null
  /** null = 本轮还没送出过、会话尚未建立（lazy 建号）。 */
  currentSessionId: string | null
  switchingTo?: string | null
  startingNew?: boolean
  /** 搜寻词（受控，外层持有输入框）；缺席＝不过滤。 */
  query?: string
  /** 标题格式化（默认 formatSessionLabel；外层可注入）。 */
  formatLabel?: (it: AgentSessionSummary) => string
  onPick: (sessionId: string) => void
  onStartNew: () => void
  /** 长按行触发（外层弹重命名 / 删除菜单）。缺席＝不可操作。 */
  onRowAction?: (session: AgentSessionSummary) => void
}

export function AgentSessionList({
  sessions,
  loadError,
  currentSessionId,
  switchingTo = null,
  startingNew = false,
  query,
  formatLabel = formatSessionLabel,
  onPick,
  onStartNew,
  onRowAction,
}: AgentSessionListProps) {
  if (sessions === null) {
    return (
      <Text className='block px-2.5 py-3 text-center text-ios-caption1 text-foreground/65'>
        {loadError || '正在加载历史会话…'}
      </Text>
    )
  }

  const visible = query !== undefined ? filterAgentSessions(sessions, query, formatLabel) : sessions

  if (visible.length === 0) {
    if (sessions.length > 0) {
      return (
        <Text className='block px-2.5 py-3 text-center text-ios-caption1 text-foreground/45'>
          没有匹配的对话
        </Text>
      )
    }
    return (
      <View className='flex flex-col items-start gap-1.5 px-2.5 py-3'>
        <Icon name='plus-a50' className='h-4 w-4' />
        <Text className='text-left text-ios-caption1 leading-relaxed text-foreground/45'>
          还没有历史对话
        </Text>
        <Text
          className='text-left text-ios-caption1 font-medium text-ios-blue'
          onClick={() => {
            if (!startingNew) onStartNew()
          }}
        >
          {startingNew ? '正在开启…' : '开始新对话 →'}
        </Text>
      </View>
    )
  }

  return (
    <View className='flex flex-col gap-0.5'>
      {visible.map((it) => {
        const active = it.session_id === currentSessionId
        const switching = switchingTo === it.session_id
        const statusMeta = sessionStatusMeta(it.status)
        const activity =
          readSessionTimestamp(it, 'last_activity_at') ||
          readSessionTimestamp(it, 'updated_at') ||
          readSessionTimestamp(it, 'created_at')
        return (
          <View
            key={it.session_id}
            className={
              'flex min-h-[52px] flex-col justify-center gap-0.5 rounded-[14px] px-3 py-2 ' +
              (active ? 'bg-black/[0.05] ' : '') +
              (switching ? 'opacity-50' : '')
            }
            onClick={() => {
              if (switchingTo === null) onPick(it.session_id)
            }}
            onLongPress={() => {
              if (onRowAction) onRowAction(it)
            }}
          >
            <Text className='text-ios-subhead font-medium leading-snug text-foreground/85' style={CLAMP_2}>
              {formatLabel(it)}
            </Text>
            <View className='flex items-center gap-1.5'>
              <View
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusMeta.dotClass}`}
                aria-label={statusMeta.label}
              />
              <Text className='text-ios-footnote text-foreground/45'>
                {activity ? formatSessionRelativeTime(activity) : ''}
              </Text>
              {switching ? <Icon name='loader-2-a45' className='ic-spin h-3 w-3 shrink-0' /> : null}
            </View>
          </View>
        )
      })}
    </View>
  )
}
