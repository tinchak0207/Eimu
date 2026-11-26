import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Icon } from './icons'

/**
 * 本机文件模式（桌面专属）。网页版 AgentComposer.local-file-mode.tsx 依赖
 * `window.eimuLocal`（Electron 预加载桥）＋设备授权票，小程序没有这组能力。
 *
 * 纯浏览器分支（网页版 :288-296）就是一颗只读灰字提示：硬盘图示 + `此功能需要桌面版`
 * （text-ios-footnote / text-foreground/40），本端逐项照抄，点击只弹同字提示，
 * 不假装可开关、不伪造模式清单。
 */

export const LOCAL_FILE_MODE_HINT = '此功能需要桌面版'

export function LocalFileModeHint() {
  return (
    <View
      className='ml-1 flex shrink-0 items-center gap-1 text-foreground/40'
      onClick={() => {
        void Taro.showToast({ title: `本机文件：${LOCAL_FILE_MODE_HINT}`, icon: 'none' })
      }}
    >
      <Icon name='hard-drive-a40' className='h-4 w-4 shrink-0' />
      <Text className='whitespace-nowrap text-ios-footnote'>{LOCAL_FILE_MODE_HINT}</Text>
    </View>
  )
}
