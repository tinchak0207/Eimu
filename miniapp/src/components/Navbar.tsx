import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { cn } from '../lib/cn'
import { Icon } from './agent-chat/icons'
import type { MiniUser } from '../lib/session'
import { quotaToCoins } from '../lib/quota'

// 与 Navbar.tsx:392 同一个站点 icon；复制到小程序静态资源（Taro 需要可打包路径）。
const LOGO = require('../assets/icon.png')

/** 微信胶囊属于原生层，整行站点操作置于其下，不能只避开状态栏。 */
export function getNavbarTopInset(statusBarHeight: number): number {
  const status = Number.isFinite(statusBarHeight) && statusBarHeight >= 0 ? statusBarHeight : 20
  try {
    const capsule = Taro.getMenuButtonBoundingClientRect()
    if (Number.isFinite(capsule.bottom) && capsule.bottom > status && capsule.height > 0) {
      return capsule.bottom + 8
    }
  } catch {
    // 平台尚未返回胶囊坐标时，保留微信标准导航区，不能退回与胶囊重叠。
  }
  return status + 44
}

export function getNavbarHeight(statusBarHeight: number): number {
  return getNavbarTopInset(statusBarHeight) + 60
}

/**
 * 自绘顶栏。结构 / 类名逐行复制自 src/components/Navbar.tsx:349-548（手机登录态）：
 *   左组 369-397：汉堡 MobileNavHamburger（mobile-nav/MobileSidebar.tsx:589-600）＋ logo
 *   右组 423-527：WalletBadge（WalletBadge.tsx:163-205）＋ 钥匙 465-477 ＋ 登出 509-527
 */

export interface NavbarProps {
  user: MiniUser | null
  loginPending?: boolean
  statusBarHeight: number
  onOpenDrawer: () => void
  onTopUp: () => void
  onKey: () => void
  onLogout: () => void
  /** 抽屉是否展开（MobileSidebar.tsx:580-601 汉堡钮的 aria-expanded）。选填，向后兼容。 */
  drawerOpen?: boolean
}

export function Navbar({ user, loginPending = false, statusBarHeight, onOpenDrawer, onTopUp, onKey, onLogout, drawerOpen }: NavbarProps) {
  const coins = user && Number.isFinite(user.quota) ? quotaToCoins(user.quota) : null

  return (
    <View className='agent-page-nav' style={{ paddingTop: `${getNavbarTopInset(statusBarHeight)}px` }}>
      <View className='flex h-[60px] items-center justify-between gap-2 px-3 py-2'>
        {/* 左组（Navbar.tsx:369-397） */}
        <View className='flex min-w-0 shrink-0 items-center gap-2'>
          <View
            className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.62)]'
            aria-label='打开导航'
            aria-haspopup='dialog'
            aria-expanded={drawerOpen === undefined ? undefined : drawerOpen}
            onClick={onOpenDrawer}
          >
            <Icon name='menu-a62' className='h-5 w-5' />
          </View>
          <View className='flex min-w-0 shrink items-center gap-2'>
            <View className='flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[20px]'>
              <Image src={LOGO} className='h-full w-full object-cover' mode='aspectFill' />
            </View>
          </View>
        </View>

        {/* 右组（Navbar.tsx:423-527）：余额胶囊 flex-1、钥匙、登出 */}
        <View className={cn('flex min-w-0 flex-1 items-center justify-end gap-1', !user && 'flex-none gap-2')}>
          {user ? (
            <>
              <View className='relative flex min-w-0 flex-1 items-center gap-1.5'>
                <View className='inline-flex max-w-full shrink items-stretch overflow-hidden rounded-full bg-[rgba(0,0,0,0.05)] max-sm:bg-transparent select-none'>
                  <View className='flex min-w-0 items-center gap-1 whitespace-nowrap px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(120,90,20,0.85)]'>
                    <Icon name='coins-gold' className='h-3.5 w-3.5' />
                    <Text className='min-w-0 truncate tabular-nums'>
                      {coins === null ? '暂不可用' : `${coins} 币`}
                    </Text>
                  </View>
                  <View
                    className='flex w-6 shrink-0 items-center justify-center text-[rgba(120,90,20,0.85)]'
                    onClick={onTopUp}
                  >
                    <Icon name='plus-gold2' className='h-3.5 w-3.5' />
                  </View>
                </View>
              </View>

              <View
                className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)]'
                onClick={onKey}
              >
                <Icon name='key-round-a52' className='h-3.5 w-3.5' />
              </View>

              <View className='flex shrink-0 items-center gap-1 rounded-full py-1 pl-1.5 pr-0.5'>
                <View
                  className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.44)]'
                  onClick={onLogout}
                >
                  <Icon name='log-out-a44' className='h-3.5 w-3.5' />
                </View>
              </View>
            </>
          ) : (
            <View className='rounded-full bg-[rgba(255,255,255,0.38)] px-3 py-1.5 text-ios-footnote font-medium text-[rgba(0,0,0,0.52)]'>
              <Text>{loginPending ? '登录中…' : '未登录'}</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}
