import Taro from '@tarojs/taro'

export const TOKEN_KEY = 'eimu_token'
export const USER_ID_KEY = 'eimu_user_id'
export const USER_KEY = 'eimu_user'

export interface MiniUser {
  id: number
  username: string
  display_name?: string
  email?: string
  quota?: number
  used_quota?: number
  avatar_url?: string
  [key: string]: unknown
}

export function getToken(): string | null {
  const value = Taro.getStorageSync(TOKEN_KEY)
  return typeof value === 'string' && value ? value : null
}

export function getUserId(): number | null {
  const value = Number(Taro.getStorageSync(USER_ID_KEY))
  return Number.isFinite(value) && value > 0 ? value : null
}

export function getStoredUser(): MiniUser | null {
  const value = Taro.getStorageSync(USER_KEY)
  if (!value || typeof value !== 'object') return null
  const user = value as MiniUser
  return typeof user.id === 'number' ? user : null
}

export function saveSession(token: string, user: MiniUser): void {
  Taro.setStorageSync(TOKEN_KEY, token)
  Taro.setStorageSync(USER_ID_KEY, String(user.id))
  Taro.setStorageSync(USER_KEY, user)
}

export function saveUser(user: MiniUser): void {
  Taro.setStorageSync(USER_ID_KEY, String(user.id))
  Taro.setStorageSync(USER_KEY, user)
}

export function clearSession(): void {
  Taro.removeStorageSync(TOKEN_KEY)
  Taro.removeStorageSync(USER_ID_KEY)
  Taro.removeStorageSync(USER_KEY)
}
