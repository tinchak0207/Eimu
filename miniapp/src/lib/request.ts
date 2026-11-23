import Taro from '@tarojs/taro'
import { getToken, getUserId } from './storage'

// 从 .env 注入（TARO_APP_API_BASE_URL），默认生产域名
export const BASE_URL = process.env.TARO_APP_API_BASE_URL || 'https://image.tinchak0207.xyz'
export const REQUEST_TIMEOUT_MS = 30_000

export class ApiError extends Error {
  status: number
  code: string
  /** 上游微信 errcode（如 40163 code 已使用），拿不到就不填。 */
  errcode?: number

  constructor(message: string, status = 0, code = 'request_failed', errcode?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.errcode = errcode
  }
}

/** PATCH 只为历史收藏开关（/api/history/{id}）而加，其余行为不变。 */
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RequestOptions {
  path: string
  method?: HttpMethod
  data?: unknown
  /** 默认 true：自动带 Authorization 与 x-user-id。 */
  auth?: boolean
  header?: Record<string, string>
  timeout?: number
}

function extractMessage(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim()) {
    const text = body.trim()
    if (text.startsWith('<')) return `服务返回了非 JSON 响应（${status}）`
    return text.slice(0, 300)
  }
  if (body && typeof body === 'object') {
    const payload = body as Record<string, unknown>
    if (typeof payload.error === 'string' && payload.error) return payload.error
    if (payload.error && typeof payload.error === 'object') {
      const nested = (payload.error as { message?: unknown }).message
      if (typeof nested === 'string' && nested) return nested
    }
    if (typeof payload.message === 'string' && payload.message) return payload.message
  }
  if (status === 401) return '登录已失效，请重新登录'
  if (status === 402) return '额度不足，请充值后再试'
  if (status === 404) return '接口不存在或尚未部署'
  if (status >= 500) return `服务暂时不可用（${status}）`
  return `请求失败（${status}）`
}

export async function request<T>(options: RequestOptions): Promise<T> {
  const {
    path,
    method = 'GET',
    data,
    auth = true,
    header = {},
    timeout = REQUEST_TIMEOUT_MS,
  } = options

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...header,
  }

  if (auth) {
    const token = getToken()
    const userId = getUserId()
    if (!token || !userId) {
      throw new ApiError('尚未登录，请先登录', 401, 'not_authenticated')
    }
    headers.Authorization = `Bearer ${token}`
    headers['x-user-id'] = String(userId)
  }

  let response: Taro.request.SuccessCallbackResult<unknown>
  try {
    response = await Taro.request({
      url: `${BASE_URL}${path}`,
      method,
      data: data as Taro.request.Option['data'],
      header: headers,
      timeout,
    })
  } catch (error) {
    const errMsg = (error as { errMsg?: string } | null)?.errMsg || '网络异常'
    throw new ApiError(`网络请求失败：${errMsg}`, 0, 'network_error')
  }

  const body = response.data
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return body as T
  }

  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const code = typeof payload.code === 'string' ? payload.code : `http_${response.statusCode}`
  const errcode = typeof payload.errcode === 'number' ? payload.errcode : undefined
  throw new ApiError(extractMessage(body, response.statusCode), response.statusCode, code, errcode)
}
