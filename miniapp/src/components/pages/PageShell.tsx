/**
 * 两页共用的页面外壳：网页版手机端的全局 Navbar + 汉堡抽屉。
 *
 * 逐行对应：src/components/Navbar.tsx:349-548（手机登录态）与
 * src/components/mobile-nav/MobileSidebar.tsx（抽屉本体在 miniapp 的 MobileDrawer）。
 * 本档只做「页面级接线」：状态栏高度、登录态、抽屉开合、四个顶栏动作；
 * 视觉与结构一律由既有的 Navbar / MobileDrawer 决定（本任务不改那两个档）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Navbar } from '../Navbar'
import { MobileDrawer } from '../MobileDrawer'
import { clearSession, ensureLogin, type MiniUser } from '../../lib/session'
import './page-shared.scss'

export interface PageShellProps {
  children: ReactNode
}

export function PageShell({ children }: PageShellProps) {
  const [statusBarHeight, setStatusBarHeight] = useState(20)
  const [user, setUser] = useState<MiniUser | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [loginPending, setLoginPending] = useState(true)
  const [loginError, setLoginError] = useState('')
  const loginPendingRef = useRef(false)
  const authGenerationRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    let disposed = false
    const generation = authGenerationRef.current
    mountedRef.current = true
    loginPendingRef.current = true
    try {
      const info = Taro.getWindowInfo ? Taro.getWindowInfo() : Taro.getSystemInfoSync()
      setStatusBarHeight(Number(info.statusBarHeight ?? 20))
    } catch {
      // 取不到就沿用 20px 兜底，不挡页面渲染。
    }
    void ensureLogin()
      .then((next) => {
        if (!disposed && generation === authGenerationRef.current) setUser(next)
      })
      .catch((error) => {
        if (!disposed && generation === authGenerationRef.current) {
          setLoginError(error instanceof Error ? error.message : '微信登录失败，请重试')
        }
      })
      .finally(() => {
        if (!disposed && generation === authGenerationRef.current) {
          loginPendingRef.current = false
          setLoginPending(false)
        }
      })
    return () => {
      disposed = true
      mountedRef.current = false
    }
  }, [])

  // 顶栏动作：充值→定价页、钥匙→提示、登出仅清除本设备身份。
  const handleTopUp = useCallback(() => {
    void Taro.navigateTo({ url: '/pages/pricing/index' })
  }, [])

  const handleKey = useCallback(() => {
    void Taro.showToast({ title: '请在网页版管理 API 密钥', icon: 'none' })
  }, [])

  const handleLogin = useCallback(() => {
    if (loginPendingRef.current) return
    const generation = ++authGenerationRef.current
    loginPendingRef.current = true
    setLoginPending(true)
    setLoginError('')
    void ensureLogin()
      .then((next) => {
        if (mountedRef.current && generation === authGenerationRef.current) setUser(next)
      })
      .catch((error) => {
        if (mountedRef.current && generation === authGenerationRef.current) {
          const message = error instanceof Error ? error.message : '微信登录失败，请重试'
          setLoginError(message)
          void Taro.showToast({ title: message, icon: 'none' })
        }
      })
      .finally(() => {
        if (mountedRef.current && generation === authGenerationRef.current) {
          loginPendingRef.current = false
          setLoginPending(false)
        }
      })
  }, [])

  const handleLogout = useCallback(() => {
    void Taro.showModal({
      title: '退出登录',
      content: '退出当前设备的登录状态，对话和正在进行的任务会保留。',
      success: (result) => {
        if (!result.confirm) return
        authGenerationRef.current += 1
        clearSession()
        loginPendingRef.current = false
        setLoginPending(false)
        setLoginError('')
        setUser(null)
        setDrawerOpen(false)
      },
    })
  }, [])

  const userName = user?.display_name || user?.username || 'Eimu 用户'
  const userSubtitle = user?.email || (user ? `ID ${user.id}` : '未登录')

  return (
    <View className='min-h-screen' style={{ background: '#f5fbff' }}>
      <Navbar
        user={user}
        loginPending={loginPending}
        statusBarHeight={statusBarHeight}
        drawerOpen={drawerOpen}
        onOpenDrawer={() => setDrawerOpen(true)}
        onTopUp={handleTopUp}
        onKey={handleKey}
        onLogout={handleLogout}
      />
      {!user ? (
        <View className='flex min-h-screen flex-col items-center justify-center gap-4 px-6'>
          <Text className='text-ios-title3 font-semibold text-foreground'>{loginPending ? '微信登录中…' : '微信登录后继续'}</Text>
          {loginError ? <Text className='text-ios-footnote text-destructive'>{loginError}</Text> : null}
          {!loginPending ? <View className='flex min-h-11 items-center justify-center rounded-full bg-ios-blue px-5 text-white' onClick={handleLogin}>
            <Text>重新微信登录</Text>
          </View> : null}
        </View>
      ) : children}
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
