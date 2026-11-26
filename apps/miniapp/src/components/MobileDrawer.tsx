import { readWindow } from '../lib/system'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './agent-chat/icons'
import { listAgentSessions, type AgentSessionSummary } from '../lib/agent'

/**
 * 汉堡抽屉。结构／层级／Tailwind class 逐行复制自网页版手机端抽屉
 * src/components/mobile-nav/MobileSidebar.tsx：
 *   容器      :224-410（纯呈现层 MobileSidebarPanel）
 *   身份头    :236-256
 *   主导览列  :269-309（行高 52px / gap-3.5 / rounded-[14px] / text-ios-body）
 *   对话分节  :312-343（标题＋搜寻框＋会话清单）
 *   底部 dock :383-407（玻璃条＋齿轮＋黑色新对话 FAB）
 *
 * 按用户裁剪：主导览只留「直接生成 / 生成历史 / 我的资产」三项（「定价」不要）；
 * 页尾细字带（技能／工作流／状态／帮助，:360-377）整段去掉（小程序无对应页面，
 * 不留死链）；QQ 群入口（:348-357）同样去掉。
 *
 * 平台差异白名单：
 *   lucide → ./agent-chat/icons 的 PNG 替身（网版 Settings 齿轮无对应 PNG，用
 *            fallback 目的地「帐号」的 circle-user 代替；SquarePen FAB 用 plus 反白）
 *   next/link · useRouter → Taro.navigateTo / useRouter
 *   input → @tarojs/components Input；滚动区沿用既有 .mobile-sidebar-scroll
 */

/** 主导览列（MobileSidebar.tsx:144-149，去掉定价）。 */
const DRAWER_NAV: readonly { label: string; icon: IconName; url?: string; neverActive?: boolean }[] = [
  // 直接生成 / → 小程序 pages/index/index；网版 neverActive（href 就是首页）。
  { label: '直接生成', icon: 'layout-grid-a72', url: '/pages/index/index', neverActive: true },
  // 生成历史 /history → pages/works/index。
  { label: '生成历史', icon: 'folder-kanban-a45', url: '/pages/works/index' },
  // 我的作品：按镜头审阅、换版本、存走成片（对应 /api/canvas/projects/review）。
  { label: '我的作品', icon: 'folder-kanban-a45', url: '/pages/project/index' },
  // 我的资产：网版走动作桥（AgentChatSurface 的资产面板），小程序未实现 → 占位。
  { label: '我的资产', icon: 'images-a72' },
]

/** 会话状态点（照 AgentSessionList.tsx:82-88 的三态）。 */
const SESSION_STATUS_DOT: Record<'running' | 'waiting' | 'idle', string> = {
  running: 'bg-ios-blue animate-pulse',
  waiting: 'bg-ios-orange',
  idle: 'bg-foreground/15',
}

/** 取本地时区当天 00:00（AgentSessionList.tsx:20-25）。 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const

/** 相对日期（逐行复制 AgentSessionList.tsx:34-55）。 */
function formatSessionRelativeTime(timestamp: number, now: number = Date.now()): string {
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

/** 时间戳栏位读取：小程序 AgentSessionSummary 只声明 updated_at，契约同源响应还带
 *  created_at / last_activity_at（src/lib/agent-chat-client/types.ts:84-99）。 */
function readTimestamp(it: AgentSessionSummary, key: 'created_at' | 'last_activity_at' | 'updated_at'): number {
  const raw = (it as unknown as Record<string, unknown>)[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 会话标题（AgentChatSurface.helpers.ts:36-43 的同款双轨：标题优先，否则时间标签）。 */
function formatSessionLabel(it: AgentSessionSummary): string {
  const t = typeof it.title === 'string' ? it.title.trim() : ''
  if (t) return t
  const created = readTimestamp(it, 'created_at') || readTimestamp(it, 'updated_at')
  if (!created) return '未命名对话'
  const d = new Date(created)
  const date = `${d.getMonth() + 1}/${d.getDate()}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} ${time} 的对话`
}

/** 搜寻过滤（AgentSessionList.tsx:70-77 同语义）。 */
function filterSessions(list: AgentSessionSummary[], query: string): AgentSessionSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter((it) => formatSessionLabel(it).toLowerCase().includes(q))
}

/** 两行截断（网版 line-clamp-2；小程序未装 line-clamp 插件，同语义内联）。 */
const CLAMP_2 = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical' as const,
  overflow: 'hidden',
  maxWidth: '100%',
}

/** 侧栏是 78% 宽的侧边面板，不会盖到右上角胶囊，只需避开状态栏。 */
function sheetTopInset(statusBarHeight: number): number {
  const status = Number.isFinite(statusBarHeight) && statusBarHeight >= 0 ? statusBarHeight : 20
  return status + 10
}

export interface MobileDrawerProps {
  open: boolean
  userName: string
  userSubtitle: string
  onClose: () => void
  /** 旧调用位（定价入口已按用户裁剪移除）：保留可选，避免调用端改签章。 */
  onOpenPricing?: () => void
  /** 当前会话（行高亮）。缺省＝没有一列算当前。 */
  currentSessionId?: string | null
  /** 点某条会话。缺省＝占位提示（页面尚未接入会话切换）。 */
  onPickSession?: (sessionId: string) => void
  /** 新对话 FAB。缺省＝占位提示（页面尚未接入建号/重置）。 */
  onStartNew?: () => void
  /** 我的资产。缺省＝占位提示（小程序尚未实现资产面板）。 */
  onOpenAssets?: () => void
  /** dock 齿轮。缺省＝打开既有的「我的」帐号页（网版 fallback 语义，见
   *  MobileSidebar.tsx:347「帐号设置仍可经 dock 齿轮的 fallback 到达」）。 */
  onOpenSettings?: () => void
  /** 退出登录（顶栏已不放，收在侧栏底部）。 */
  onLogout?: () => void
  /** 状态栏高度：网版面板靠 env(safe-area-inset-top)（mobile-sidebar.css），
   *  小程序 env 取不到，改由页面传入；缺省时自行读 getWindowInfo。 */
  statusBarHeight?: number
}

export function MobileDrawer(props: MobileDrawerProps) {
  const { open, userName, userSubtitle, onClose, currentSessionId, onPickSession, onStartNew, onOpenAssets } = props
  const router = useRouter()
  const pathname = `/${(router.path || '').replace(/^\//, '')}`

  const [sessions, setSessions] = useState<AgentSessionSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [insetTop, setInsetTop] = useState(() => sheetTopInset(props.statusBarHeight ?? 20))

  // 与站点导航共用微信原生胶囊避让，首行账户和关闭按钮保持完整可点。
  useEffect(() => {
    if (!open) return
    const given = props.statusBarHeight
    if (typeof given === 'number' && Number.isFinite(given)) {
      setInsetTop(sheetTopInset(given))
      return
    }
    try {
      setInsetTop(sheetTopInset(readWindow().statusBarHeight))
    } catch {
      setInsetTop(sheetTopInset(20))
    }
  }, [open, props.statusBarHeight])

  // onClose 每次 render 都是新函式：用 ref 取值，effect 才不会被它反覆触发
  // （MobileSidebar.tsx:445-447）。
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 路由一变就收起（MobileSidebar.tsx:450-454）。
  useEffect(() => {
    if (open) onCloseRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // 每次开启从服务端刷新；失败保留错误提示，重新开启可重试
  // （MobileSidebar.tsx:457-472；数据源契约同 src/lib/agent-chat-client/session.ts:19）。
  useEffect(() => {
    if (!open) {
      // 收起时清掉搜寻词（MobileSidebar.tsx:521-523）。
      setQuery('')
      return
    }
    let cancelled = false
    setLoadError(null)
    setSessions(null)
    void listAgentSessions()
      .then((list) => {
        if (!cancelled) setSessions(list)
      })
      .catch(() => {
        if (!cancelled) setLoadError('历史加载失败，请重新打开重试。')
      })
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open) return null

  const go = (url: string): void => {
    onClose()
    void Taro.navigateTo({ url })
  }

  const handleAssets = (): void => {
    onClose()
    if (onOpenAssets) {
      onOpenAssets()
      return
    }
    // 占位：小程序端资产面板未实现（网版动作桥 "assets" → AgentChatSurface）。
    void Taro.showToast({ title: '资产面板即将上线', icon: 'none' })
  }

  const handleStartNew = (): void => {
    onClose()
    if (onStartNew) {
      onStartNew()
      return
    }
    void Taro.showToast({ title: '新对话待接入', icon: 'none' })
  }

  const handlePickSession = (sessionId: string): void => {
    onClose()
    if (onPickSession) {
      onPickSession(sessionId)
      return
    }
    void Taro.showToast({ title: '会话切换待接入', icon: 'none' })
  }

  const handleSettings = (): void => {
    onClose()
    if (props.onOpenSettings) {
      props.onOpenSettings()
      return
    }
    void Taro.navigateTo({ url: '/pages/mine/index' })
  }

  const visible = sessions === null ? null : filterSessions(sessions, query)

  return (
    <View className='mobile-sidebar-scrim' onClick={onClose}>
      <View
        role='dialog'
        aria-modal='true'
        aria-label='主导航'
        className='mobile-sidebar-panel'
        style={insetTop > 0 ? { paddingTop: `${insetTop}px` } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {/* 内层材质（MobileSidebar.tsx:234） */}
        <View className='mobile-sidebar-bg' />

        {/* 顶部身份：整块可点，进「我的」；关闭靠点右侧遮罩 */}
        <View className='relative z-[1] flex shrink-0 items-center gap-3 px-4 pb-2 pt-1' onClick={handleSettings}>
          <View className='flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[rgba(0,0,0,0.04)]'>
            <Image src={LOGO} className='h-full w-full object-cover' mode='aspectFill' />
          </View>
          <View className='min-w-0 flex-1'>
            <Text className='block truncate text-[17px] font-semibold leading-tight text-[rgba(0,0,0,0.88)]'>
              {userName}
            </Text>
            <Text className='block truncate text-[13px] text-[rgba(0,0,0,0.45)]'>{userSubtitle}</Text>
          </View>
        </View>

        {/* 主操作：新对话 */}
        <View className='relative z-[1] shrink-0 px-4 pb-1 pt-2'>
          <View
            className='flex h-11 items-center justify-center gap-2 rounded-full bg-black text-white'
            aria-label='新对话'
            onClick={handleStartNew}
          >
            <Text className='text-[22px] font-light leading-none'>+</Text>
            <Text className='text-[15px] font-semibold'>新对话</Text>
          </View>
        </View>

        {/* 单一卷动容器（MobileSidebar.tsx:261） */}
        <View className='mobile-sidebar-scroll relative z-[1] min-h-0 flex-1 overflow-y-auto overscroll-contain px-2'>
          {/* 导览列（MobileSidebar.tsx:269-309） */}
          <View className='pt-1'>
            <View className='flex flex-col'>
              {DRAWER_NAV.map((item) => {
                const active =
                  !item.neverActive && item.url !== undefined && !item.url.includes('?') && pathname === item.url
                return (
                  <View
                    key={item.label}
                    className={
                      'flex min-h-[48px] items-center gap-3.5 rounded-[12px] px-3 font-medium ' +
                      (active
                        ? 'bg-black/[0.05] text-[rgba(0,0,0,0.85)]'
                        : 'text-[rgba(0,0,0,0.72)]')
                    }
                    onClick={() => (item.url ? go(item.url) : handleAssets())}
                  >
                    <Icon name={item.icon} className='h-[22px] w-[22px] shrink-0' />
                    <Text className='truncate text-[16px]'>{item.label}</Text>
                  </View>
                )
              })}
            </View>
          </View>

          {/* 对话分节（MobileSidebar.tsx:312-343） */}
          <View className='flex flex-col pt-3'>
            <Text className='block px-3 pb-1.5 text-ios-subhead font-semibold text-[rgba(0,0,0,0.45)]'>
              对话
            </Text>
            <View className='px-1 pb-2'>
              <View className='lg-float flex h-11 items-center gap-2 rounded-[14px] px-3'>
                <Icon name='search-a40' className='h-4 w-4 shrink-0' />
                <Input
                  value={query}
                  onInput={(event) => setQuery(event.detail.value)}
                  placeholder='搜索对话'
                  placeholderStyle='color: rgba(0,0,0,0.40)'
                  className='min-w-0 flex-1 bg-transparent text-base'
                />
              </View>
            </View>
            <View className='flex flex-col gap-0.5 px-1 pb-2'>
              {visible === null ? (
                loadError ? (
                  <Text className='block px-2.5 py-3 text-center text-ios-caption1 text-foreground/65'>
                    {loadError}
                  </Text>
                ) : (
                  <Text className='block px-2.5 py-3 text-center text-ios-caption1 text-foreground/45'>
                    正在加载历史会话…
                  </Text>
                )
              ) : visible.length === 0 ? (
                sessions !== null && sessions.length > 0 ? (
                  <Text className='block px-2.5 py-3 text-center text-ios-caption1 text-foreground/45'>
                    没有匹配的对话
                  </Text>
                ) : (
                  <View className='flex flex-col items-start gap-1.5 px-2.5 py-3'>
                    <Icon name='plus-a50' className='h-4 w-4' />
                    <Text className='text-left text-ios-caption1 leading-relaxed text-foreground/45'>
                      还没有历史对话
                    </Text>
                    <Text
                      className='text-left text-ios-caption1 font-medium text-ios-blue'
                      onClick={handleStartNew}
                    >
                      开始新对话 →
                    </Text>
                  </View>
                )
              ) : (
                visible.map((it) => {
                  const active = it.session_id === currentSessionId
                  const status = ((it as { status?: 'running' | 'waiting' | 'idle' }).status ??
                    'idle') as 'running' | 'waiting' | 'idle'
                  const activity = readTimestamp(it, 'last_activity_at') || readTimestamp(it, 'updated_at')
                  return (
                    <View
                      key={it.session_id}
                      className={
                        'flex min-h-[52px] flex-col justify-center gap-0.5 rounded-[14px] px-3 py-2 ' +
                        (active ? 'bg-black/[0.05]' : '')
                      }
                      onClick={() => handlePickSession(it.session_id)}
                    >
                      <Text
                        className='text-ios-subhead font-medium leading-snug text-foreground/85'
                        style={CLAMP_2}
                      >
                        {formatSessionLabel(it)}
                      </Text>
                      <View className='flex items-center gap-1.5'>
                        <View
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${SESSION_STATUS_DOT[status]}`}
                        />
                        <Text className='text-ios-footnote text-foreground/45'>
                          {activity ? formatSessionRelativeTime(activity) : ''}
                        </Text>
                      </View>
                    </View>
                  )
                })
              )}
            </View>
          </View>
        </View>

        {/* 底部：我的 / 退出登录（原顶栏钥匙与登出移到这里） */}
        <View className='mobile-sidebar-dock'>
          <View className='flex flex-col overflow-hidden rounded-[16px] bg-[#f4f4f5]'>
            <View className='flex h-12 items-center gap-3 px-4' onClick={handleSettings}>
              <Icon name='circle-user-a72' className='h-5 w-5 shrink-0' />
              <Text className='text-[15px] font-medium text-[rgba(0,0,0,0.78)]'>我的账号</Text>
            </View>
            {props.onLogout ? (
              <View
                className='flex h-12 items-center gap-3 border-t border-[rgba(0,0,0,0.06)] px-4'
                onClick={() => {
                  onClose()
                  props.onLogout?.()
                }}
              >
                <Icon name='log-out-a44' className='h-5 w-5 shrink-0' />
                <Text className='text-[15px] font-medium text-[rgba(0,0,0,0.55)]'>退出登录</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  )
}

const LOGO = require('../assets/icon.png')
