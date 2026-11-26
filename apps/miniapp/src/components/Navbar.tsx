import { readWindow } from '../lib/system'
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Icon } from './agent-chat/icons'
import type { MiniUser } from '../lib/session'
import { quotaToCoins } from '../lib/quota'

// 与 Navbar.tsx:392 同一个站点 icon；复制到小程序静态资源（Taro 需要可打包路径）。
const LOGO = require('../assets/icon.png')

/** 顶栏内容行高度；整行与微信胶囊垂直居中对齐，不再另占一行。 */
export const NAV_ROW_HEIGHT = 44

/** 行顶部位置：以胶囊中线为准，让汉堡／余额与右上角胶囊同一水平线。 */
export function getNavbarTopInset(statusBarHeight: number): number {
  const status = Number.isFinite(statusBarHeight) && statusBarHeight >= 0 ? statusBarHeight : 20
  try {
    const capsule = Taro.getMenuButtonBoundingClientRect()
    if (Number.isFinite(capsule.top) && Number.isFinite(capsule.height) && capsule.height > 0) {
      return Math.max(status, Math.round(capsule.top + capsule.height / 2 - NAV_ROW_HEIGHT / 2))
    }
  } catch {
    // 平台尚未返回胶囊坐标时，退回状态栏下沿。
  }
  return status + 4
}

export function getNavbarHeight(statusBarHeight: number): number {
  return getNavbarTopInset(statusBarHeight) + NAV_ROW_HEIGHT
}

/** 右侧给原生胶囊让出的宽度（胶囊左缘到屏幕右缘＋间隙），取不到时取常见 96px。 */
export function getCapsuleReserve(): number {
  try {
    const capsule = Taro.getMenuButtonBoundingClientRect()
    const width = readWindow().windowWidth
    if (Number.isFinite(capsule.left) && capsule.left > 0 && Number.isFinite(width) && width > capsule.left) {
      return Math.round(width - capsule.left + 8)
    }
  } catch {
    // 同上
  }
  return 96
}

/**
 * 自绘顶栏：单行，与微信胶囊同一水平线。
 *   左：汉堡 ＋ logo ＋ 余额胶囊（点按去充值）
 *   右：整块留给原生胶囊。钥匙（小程序里只是个“请去网页版”的死链）已去掉；
 *   登出收进侧栏底部，顶栏不再挤五个小图标。
 */

export interface NavbarProps {
  user: MiniUser | null
  loginPending?: boolean
  statusBarHeight: number
  onOpenDrawer: () => void
  onTopUp: () => void
  /** 已不在顶栏展示（保留签名，页面无需改动）。 */
  onKey?: () => void
  onLogout?: () => void
  /** 抽屉是否展开（MobileSidebar.tsx:580-601 汉堡钮的 aria-expanded）。选填，向后兼容。 */
  drawerOpen?: boolean
}

export function Navbar({ user, loginPending = false, statusBarHeight, onOpenDrawer, onTopUp, drawerOpen }: NavbarProps) {
  const coins = user && Number.isFinite(user.quota) ? quotaToCoins(user.quota) : null

  return (
    <View className='agent-page-nav' style={{ paddingTop: `${getNavbarTopInset(statusBarHeight)}px` }}>
      <View
        className='flex items-center gap-2 pl-2'
        style={{ height: `${NAV_ROW_HEIGHT}px`, paddingRight: `${getCapsuleReserve()}px` }}
      >
        <View
          className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.7)]'
          aria-label='打开导航'
          aria-haspopup='dialog'
          aria-expanded={drawerOpen === undefined ? undefined : drawerOpen}
          onClick={onOpenDrawer}
        >
          <Icon name='menu-a62' className='h-[22px] w-[22px]' />
        </View>
        <View className='flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px]'>
          <Image src={LOGO} className='h-full w-full object-cover' mode='aspectFill' />
        </View>

        <View className='min-w-0 flex-1' />

        {user ? (
          <View
            className='flex h-8 shrink-0 items-center gap-1 rounded-full bg-[rgba(214,164,44,0.16)] pl-2.5 pr-2'
            onClick={onTopUp}
          >
            <Icon name='coins-gold' className='h-4 w-4' />
            <Text className='tabular-nums text-[14px] font-semibold leading-none text-[rgba(120,86,10,0.95)]'>
              {coins === null ? '暂不可用' : `${coins} 币`}
            </Text>
            <Icon name='plus-gold2' className='h-3.5 w-3.5' />
          </View>
        ) : (
          <View className='flex h-8 shrink-0 items-center rounded-full bg-[rgba(0,0,0,0.05)] px-3'>
            <Text className='text-[13px] font-medium leading-none text-[rgba(0,0,0,0.5)]'>
              {loginPending ? '登录中…' : '未登录'}
            </Text>
          </View>
        )}
      </View>
    </View>
  )
}
