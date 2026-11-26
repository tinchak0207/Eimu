import Taro from '@tarojs/taro'
import { ApiError, request } from './request'
import {
  clearSession,
  getStoredUser,
  getToken,
  getUserId,
  saveSession,
  saveUser,
  type MiniUser,
} from './storage'

export {
  clearSession,
  getStoredUser,
  getToken,
  getUserId,
  saveSession,
  saveUser,
  type MiniUser,
}

interface WechatLoginResponse {
  success?: boolean
  isNewUser?: boolean
  token?: string
  user?: MiniUser
  message?: string
  code?: string
  errcode?: number
}

interface MeResponse {
  success?: boolean
  data?: MiniUser & { welcomeGift?: unknown }
  message?: string
}

function normalizeUser(user: MiniUser): MiniUser {
  return {
    ...user,
    id: Number(user.id),
    username: String(user.username ?? ''),
  }
}

/**
 * 登录：Taro.login() 取 code → POST /api/auth/wechat-mini/login → 存 token →
 * 立刻 GET /api/auth/me（新用户的新人礼在这里发放）→ 返回用户。
 *
 * 同一时刻只允许一条登录链：首屏 ensureLogin 与提交按钮可能并发触发，
 * 不做去重会拿两个 code 各发一次登录请求。
 */
let loginPromise: Promise<MiniUser> | null = null

/** 登录尝试的最小间隔：页面多处并发登录时避免拿同一个已消费 code 连发。 */
const LOGIN_ATTEMPT_GAP_MS = 1200
const MAX_LOGIN_ATTEMPTS = 3
/** 微信侧可重试的 errcode：code 无效 / 已被使用 / code 过期。 */
const RETRYABLE_ERRCODES = new Set([40029, 40163, 40125])

let lastLoginAttemptAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForLoginSlot(): Promise<void> {
  const elapsed = Date.now() - lastLoginAttemptAt
  if (elapsed < LOGIN_ATTEMPT_GAP_MS) {
    await sleep(LOGIN_ATTEMPT_GAP_MS - elapsed)
  }
  lastLoginAttemptAt = Date.now()
}

function isRetryableLoginError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  if (typeof error.errcode === 'number') return RETRYABLE_ERRCODES.has(error.errcode)
  // 没有 errcode 时保守允许重试，由调用方限制只重试一次。
  return true
}

function describeLoginError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    const suffix =
      typeof error.errcode === 'number'
        ? `（code ${error.errcode}），请稍后重试`
        : '，请稍后重试'
    return new ApiError(
      `微信登录失败${suffix}`,
      error.status,
      error.code,
      error.errcode,
    )
  }
  const message = error instanceof Error && error.message ? error.message : '微信登录失败'
  return new ApiError(`${message}，请稍后重试`, 0, 'wechat_login_failed')
}


// ───────────────────────── 游客登录（兼容“别人的机器/别的 AppID”）

const GUEST_DEVICE_KEY = 'eimu_guest_device_id'

/** 当前是否游客 AppID（开发者工具“游客模式”导入）。取不到信息时按非游客处理。 */
function isTouristApp(): boolean {
  try {
    const info = Taro.getAccountInfoSync?.()
    return info?.miniProgram?.appId === 'touristappid'
  } catch {
    return false
  }
}

/** 微信这条路在本环境走不通（区别于网络抖动/服务端 5xx，那些不该悄悄换成游客身份）。 */
function isWechatIdentityUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.code === 'wechat_login_failed' && error.status === 0) return true // Taro.login 抛错 / 无 code
  return error.status === 401 && typeof error.errcode === 'number'
}

function randomHex(length: number): string {
  let out = ''
  while (out.length < length) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return out.slice(0, length)
}

/** 每台设备一个稳定随机 id（清缓存后会变成新游客账号，可接受）。 */
function guestDeviceId(): string {
  try {
    const saved = String(Taro.getStorageSync(GUEST_DEVICE_KEY) || '')
    if (/^[a-f0-9]{32}$/.test(saved)) return saved
  } catch {
    // 存储不可用时退化为内存内临时 id。
  }
  const created = randomHex(32)
  try {
    Taro.setStorageSync(GUEST_DEVICE_KEY, created)
  } catch {
    // 忽略
  }
  return created
}

async function loginGuest(): Promise<MiniUser> {
  const payload = await request<WechatLoginResponse>({
    path: '/api/auth/wechat-mini/guest',
    method: 'POST',
    data: { deviceId: guestDeviceId() },
    auth: false,
  })
  if (!payload?.success || !payload.token || !payload.user?.id) {
    throw new ApiError(payload?.message || '游客登录失败', 401, payload?.code || 'guest_login_failed')
  }
  const loginUser = normalizeUser(payload.user)
  saveSession(payload.token, loginUser)
  try {
    return await fetchMe()
  } catch {
    return loginUser
  }
}

export function login(): Promise<MiniUser> {
  if (!loginPromise) {
    loginPromise = doLogin().finally(() => {
      loginPromise = null
    })
  }
  return loginPromise
}

/**
 * 每次尝试都重新 Taro.login() 取新 code——开发者工具里可能重复返回同一个
 * 已被消费的 code，复用旧 code 只会连发 401。
 */
async function doLogin(): Promise<MiniUser> {
  // 游客模式（touristappid）/ 无 AppID 权限导入：wx.login 换不到可用 code，直接走游客登录。
  if (isTouristApp()) return loginGuest()

  let noErrcodeRetried = false

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await sleep(700 * (attempt - 1))
    try {
      return await loginOnce()
    } catch (error) {
      if (!isRetryableLoginError(error) || attempt >= MAX_LOGIN_ATTEMPTS) {
        // 微信侧明确拒绝（code 无效等）或本机根本取不到 code：这台环境换不到微信身份，改走游客登录。
        if (isWechatIdentityUnavailable(error)) {
          try {
            return await loginGuest()
          } catch {
            // 游客也失败时，报原始的微信登录错误。
          }
        }
        throw describeLoginError(error)
      }
      if (error instanceof ApiError && typeof error.errcode !== 'number') {
        if (noErrcodeRetried) throw describeLoginError(error)
        noErrcodeRetried = true
      }
    }
  }
  throw new ApiError('微信登录失败，请稍后重试', 0, 'wechat_login_failed')
}

async function loginOnce(): Promise<MiniUser> {
  await waitForLoginSlot()

  let code = ''
  try {
    const result = await Taro.login()
    code = result.code ?? ''
  } catch (error) {
    const errMsg = (error as { errMsg?: string } | null)?.errMsg || '微信登录失败'
    throw new ApiError(errMsg, 0, 'wechat_login_failed')
  }
  if (!code) throw new ApiError('微信登录未返回 code', 0, 'wechat_login_failed')

  const payload = await request<WechatLoginResponse>({
    path: '/api/auth/wechat-mini/login',
    method: 'POST',
    data: { code },
    auth: false,
  })

  if (!payload?.success || !payload.token || !payload.user?.id) {
    throw new ApiError(
      payload?.message || '微信登录失败',
      401,
      payload?.code || 'login_failed',
      typeof payload?.errcode === 'number' ? payload.errcode : undefined,
    )
  }

  const loginUser = normalizeUser(payload.user)
  saveSession(payload.token, loginUser)

  try {
    return await fetchMe()
  } catch {
    // /api/auth/me 抖动时不把已拿到的 token 丢掉；页面可稍后刷新额度。
    return loginUser
  }
}

/** 拉取当前用户（额度 / 昵称）；自动发新人礼。 */
export async function fetchMe(): Promise<MiniUser> {
  const payload = await request<MeResponse>({ path: '/api/auth/me' })
  if (!payload?.success || !payload.data?.id) {
    throw new ApiError(payload?.message || '获取用户信息失败', 502, 'me_failed')
  }
  const { welcomeGift: _welcomeGift, ...user } = payload.data
  const normalized = normalizeUser(user as MiniUser)
  saveUser(normalized)
  return normalized
}

/** 有 session 就复用，没有就走完整微信登录。 */
export async function ensureLogin(): Promise<MiniUser> {
  const token = getToken()
  const userId = getUserId()
  if (token && userId) {
    return getStoredUser() ?? (await fetchMe())
  }
  return login()
}

/** 重新登录：清掉本地身份后重走微信登录。 */
export async function relogin(): Promise<MiniUser> {
  clearSession()
  if (loginPromise) {
    // 等旧的登录链落地后再清一次，避免旧 token 在清空之后又写回来。
    await loginPromise.catch(() => undefined)
    clearSession()
  }
  return login()
}
