import { useState } from 'react'
import { Button, Image, Text, View } from '@tarojs/components'
import { useDidShow } from '@tarojs/taro'
import { fetchMe, ensureLogin, relogin, type MiniUser } from '../../lib/session'
import { quotaToCoins } from '../../lib/quota'
import './index.scss'

export default function MinePage() {
  const [user, setUser] = useState<MiniUser | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      await ensureLogin()
      setUser(await fetchMe())
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取用户信息失败')
    } finally {
      setLoading(false)
    }
  }

  useDidShow(() => {
    void load()
  })

  async function handleRelogin() {
    setLoading(true)
    setError('')
    try {
      setUser(await relogin())
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新登录失败')
    } finally {
      setLoading(false)
    }
  }

  const nickname = user?.display_name || user?.username || (user ? `用户 ${user.id}` : '未登录')
  const initial = nickname.trim().slice(0, 1) || 'E'
  const coins = quotaToCoins(user?.quota)

  return (
    <View className='page mine'>
      <View className='card profile'>
        <View className='avatar'>
          {user?.avatar_url ? (
            <Image className='avatar__image' src={user.avatar_url} mode='aspectFill' />
          ) : (
            <Text className='avatar__initial'>{initial}</Text>
          )}
        </View>
        <View className='profile__info'>
          <Text className='profile__name'>{nickname}</Text>
          <Text className='muted'>{user ? `ID ${user.id}` : loading ? '正在登录…' : '登录后可用'}</Text>
        </View>
      </View>

      <View className='card quota'>
        <Text className='section-title'>剩余额度</Text>
        <View className='quota__row'>
          <Text className='quota__value'>{user ? coins : '—'}</Text>
          <Text className='quota__unit'>金币</Text>
        </View>
        <Text className='muted quota__note'>新账号首次登录会自动领取新人礼额度。</Text>
      </View>

      {error ? (
        <View className='card mine__error'>
          <Text className='error-text'>{error}</Text>
        </View>
      ) : null}

      <Button className='btn btn--ghost mine__action' loading={loading} onClick={load}>
        刷新额度
      </Button>
      <Button className='btn btn--primary mine__action' onClick={handleRelogin}>
        重新登录
      </Button>

      <Text className='muted mine__foot'>Eimu · 微信小程序</Text>
    </View>
  )
}
