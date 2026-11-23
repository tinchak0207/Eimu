/**
 * 两页共用的页面外壳：网页版手机端的全局 Navbar + 汉堡抽屉。
 *
 * 逐行对应：src/components/Navbar.tsx:349-548（手机登录态）与
 * src/components/mobile-nav/MobileSidebar.tsx（抽屉本体在 miniapp 的 MobileDrawer）。
 * 本档只做「页面级接线」：状态栏高度、登录态、抽屉开合、四个顶栏动作；
 * 视觉与结构一律由既有的 Navbar / MobileDrawer 决定（本任务不改那两个档）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Navbar } from '../Navbar'
import { MobileDrawer } from '../MobileDrawer'
import { ensureLogin, type MiniUser } from '../../lib/session'
import './page-shared.scss'

export interface PageShellProps {
  children: ReactNode
}

export function PageShell({ children }: PageShellProps) {
  const [statusBarHeight, setStatusBarHeight] = useState(20)
  const [user, setUser] = useState<MiniUser | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    try {
      const info = Taro.getWindowInfo ? Taro.getWindowInfo() : Taro.getSystemInfoSync()
      setStatusBarHeight(Number(info.statusBarHeight ?? 20))
    } catch {
      // 取不到就沿用 20px 兜底，不挡页面渲染。
    }
    void ensureLogin()
      .then((next) => {
        if (!disposed) setUser(next)
      })
      .catch(() => {
        // 登录失败由页面自身在提交/拉列表时给出可见错误。
      })
    return () => {
      disposed = true
    }
  }, [])

  // 顶栏动作与网页版 Navbar 同义：充值→定价页、钥匙→提示、登出→重新登录。
  const handleTopUp = useCallback(() => {
    void Taro.navigateTo({ url: '/pages/pricing/index' })
  }, [])

  const handleKey = useCallback(() => {
    void Taro.showToast({ title: '请在网页版管理 API 密钥', icon: 'none' })
  }, [])

  const handleLogout = useCallback(() => {
    void Taro.showModal({
      title: '退出登录',
      content: '小程序使用微信登录，退出后将重新建立匿名会话。',
      success: (result) => {
        if (!result.confirm) return
        void ensureLogin().then((next) => {
          setUser(next)
          void Taro.showToast({ title: '已刷新登录态', icon: 'none' })
        })
      },
    })
  }, [])

  const userName = user?.display_name || user?.username || 'Eimu 用户'
  const userSubtitle = user?.email || (user ? `ID ${user.id}` : '未登录')

  return (
    <View className='min-h-screen' style={{ background: '#f5fbff' }}>
      <Navbar
        user={user}
        statusBarHeight={statusBarHeight}
        drawerOpen={drawerOpen}
        onOpenDrawer={() => setDrawerOpen(true)}
        onTopUp={handleTopUp}
        onKey={handleKey}
        onLogout={handleLogout}
      />
      {children}
      <MobileDrawer
        open={drawerOpen}
        userName={userName}
        userSubtitle={userSubtitle}
        statusBarHeight={statusBarHeight}
        onClose={() => setDrawerOpen(false)}
        onOpenSettings={() => {
          void Taro.navigateTo({ url: '/pages/mine/index' })
        }}
      />
    </View>
  )
}
