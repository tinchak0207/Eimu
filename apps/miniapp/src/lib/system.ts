import Taro from '@tarojs/taro'

/**
 * 窗口信息的统一读取。不同微信版本/平台（旧基础库、PC/Mac 微信、游客模式）上
 * getWindowInfo 可能不存在、返回空对象或字段为 0，逐处裸读会让首页白屏；这里一处兜底。
 */
export interface WindowMetrics {
  statusBarHeight: number
  windowWidth: number
  windowHeight: number
  /** 底部安全区高度（刘海屏手势条），取不到为 0。 */
  safeAreaBottom: number
}

const FALLBACK: WindowMetrics = { statusBarHeight: 20, windowWidth: 375, windowHeight: 667, safeAreaBottom: 0 }

function positive(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function readWindow(): WindowMetrics {
  let info: Record<string, any> | undefined
  try {
    info = typeof Taro.getWindowInfo === 'function' ? (Taro.getWindowInfo() as Record<string, any>) : undefined
  } catch {
    info = undefined
  }
  if (!info || typeof info !== 'object' || !Number(info.windowWidth)) {
    try {
      info = Taro.getSystemInfoSync() as unknown as Record<string, any>
    } catch {
      info = undefined
    }
  }
  if (!info || typeof info !== 'object') return { ...FALLBACK }
  const height = positive(info.windowHeight, FALLBACK.windowHeight)
  const safeBottom = Number(info.safeArea?.bottom)
  return {
    statusBarHeight: Number.isFinite(Number(info.statusBarHeight)) && Number(info.statusBarHeight) >= 0 ? Number(info.statusBarHeight) : FALLBACK.statusBarHeight,
    windowWidth: positive(info.windowWidth, FALLBACK.windowWidth),
    windowHeight: height,
    safeAreaBottom: Number.isFinite(safeBottom) && safeBottom > 0 && safeBottom <= height ? Math.round(height - safeBottom) : 0,
  }
}
