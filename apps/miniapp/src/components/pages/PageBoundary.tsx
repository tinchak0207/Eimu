/**
 * 页面级错误兜底。
 *
 * 起因（2026-10-21 运行时事故）：`/pages/index/index` 白屏且 automator 抓到一条
 * `console.error`，但 Error 对象在自动化协议里被序列化成 `{}`，拿不到 message，
 * 只能靠猜。这里把渲染期异常转成屏幕上的可见文案（名称 + message + 栈顶），
 * 下一次同类事故可以直接截图取证，不再白屏。
 *
 * 只兜渲染期异常；模块加载/包体不一致导致的 chunk 失败不在此列（那种情况
 * wxss/js 根本没执行，任何 React 兜底都接不到），需靠「整包重建 + 重载项目」。
 */
import { Component, type ReactNode } from 'react'
import { Text, View } from '@tarojs/components'
import './page-shared.scss'

interface PageBoundaryState {
  detail: string | null
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stack = (error.stack ?? '').split('\n').slice(0, 6).join('\n')
    return `${error.name}: ${error.message}${stack ? `\n${stack}` : ''}`
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export class PageBoundary extends Component<{ children: ReactNode }, PageBoundaryState> {
  state: PageBoundaryState = { detail: null }

  static getDerivedStateFromError(error: unknown): PageBoundaryState {
    return { detail: describe(error) }
  }

  componentDidCatch(error: unknown): void {
    // 同时写进控制台，方便开发者工具侧看到完整栈。
    console.error('[page-boundary]', error)
  }

  render(): ReactNode {
    if (this.state.detail) {
      return (
        <View className='min-h-screen px-4 py-16'>
          <View className='lg-card rounded-ios-2xl p-4'>
            <Text className='block text-ios-body font-semibold text-[#FF3B30]'>页面渲染失败</Text>
            <Text className='mt-2 block text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.62)]'>
              {this.state.detail}
            </Text>
          </View>
        </View>
      )
    }
    return this.props.children
  }
}
