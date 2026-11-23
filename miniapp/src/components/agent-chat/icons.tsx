import { Image } from '@tarojs/components'

/**
 * lucide-react 图标的本地 PNG 替身（平台差异白名单第 1 条）。
 * 生成方式：读 lucide-react 的 __iconNode → SVG → rsvg-convert 72×72（3x）。
 * 每个 tone 后缀即网页版 class 的语义色：
 *   a35..a72 = rgba(0,0,0,.35…,.72)；gold/gold2 = 币色；lav = #8a86f0（发送键）；
 *   red/blue/green/purple/amber/white = 对应 iOS 系统色。
 */
const ICON_MAP = {
  'alert-triangle-amber': require('../../assets/icons/alert-triangle-amber.png'),
  'alert-triangle-issue': require('../../assets/icons/alert-triangle-issue.png'),
  'alert-triangle-red': require('../../assets/icons/alert-triangle-red.png'),
  'anchor-a52': require('../../assets/icons/anchor.png'),
  'arrow-down-a60': require('../../assets/icons/arrow-down-a60.png'),
  'arrow-up-lav': require('../../assets/icons/arrow-up-lav.png'),
  'badge-dollar-sign-a72': require('../../assets/icons/badge-dollar-sign-a72.png'),
  'box-a45': require('../../assets/icons/box.png'),
  'bot-a40': require('../../assets/icons/bot-a40.png'),
  'brain-a40': require('../../assets/icons/brain-a40.png'),
  'brain-a60': require('../../assets/icons/brain-a60.png'),
  'check-green': require('../../assets/icons/check-green.png'),
  'check-a56': require('../../assets/icons/check-a56.png'),
  'chevron-down-a35': require('../../assets/icons/chevron-down-a35.png'),
  'chevron-down-a60': require('../../assets/icons/chevron-down-a60.png'),
  'circle-check-green': require('../../assets/icons/circle-check-green.png'),
  'circle-user-a72': require('../../assets/icons/circle-user-a72.png'),
  'clapperboard-a40': require('../../assets/icons/clapperboard-a40.png'),
  'coins-a40': require('../../assets/icons/coins-a40.png'),
  'coins-gold': require('../../assets/icons/coins-gold.png'),
  'download-a45': require('../../assets/icons/download-a45.png'),
  'download-white': require('../../assets/icons/download-white.png'),
  'copy-a40': require('../../assets/icons/copy-a40.png'),
  'copy-plus-a45': require('../../assets/icons/copy-plus-a45.png'),
  'file-warning-amber': require('../../assets/icons/file-warning-amber.png'),
  'folder-kanban-a45': require('../../assets/icons/folder-kanban-a45.png'),
  'help-circle-blue': require('../../assets/icons/help-circle-blue.png'),
  'hard-drive-a40': require('../../assets/icons/hard-drive-a40.png'),
  'image-a40': require('../../assets/icons/image-a40.png'),
  'images-a72': require('../../assets/icons/images-a72.png'),
  'info-a45': require('../../assets/icons/info-a45.png'),
  'key-round-a52': require('../../assets/icons/key-round-a52.png'),
  'layout-grid-a40': require('../../assets/icons/layout-grid-a40.png'),
  'layout-grid-a72': require('../../assets/icons/layout-grid-a72.png'),
  'loader-2-a45': require('../../assets/icons/loader-2-a45.png'),
  'loader-2-a60': require('../../assets/icons/loader-2-a60.png'),
  'loader-2-blue': require('../../assets/icons/loader-2-blue.png'),
  'loader-2-lav': require('../../assets/icons/loader-2-lav.png'),
  'loader-2-red': require('../../assets/icons/loader-2-red.png'),
  'loader-2-white': require('../../assets/icons/loader-2-white.png'),
  'lock-blue': require('../../assets/icons/lock-blue.png'),
  'log-in-a60': require('../../assets/icons/log-in-a60.png'),
  'library-a45': require('../../assets/icons/library.png'),
  'log-out-a44': require('../../assets/icons/log-out-a44.png'),
  'mic-2-white': require('../../assets/icons/mic-2-white.png'),
  'monitor-play-a45': require('../../assets/icons/monitor-play.png'),
  'menu-a62': require('../../assets/icons/menu-a62.png'),
  'refresh-cw-a52': require('../../assets/icons/refresh-cw.png'),
  'navigation-lav': require('../../assets/icons/navigation-lav.png'),
  'navigation-a45': require('../../assets/icons/navigation-a45.png'),
  'navigation-green': require('../../assets/icons/navigation-green.png'),
  'navigation-red': require('../../assets/icons/navigation-red.png'),
  'navigation-orange': require('../../assets/icons/navigation-orange.png'),
  'plus-a50': require('../../assets/icons/plus-a50.png'),
  'plus-gold2': require('../../assets/icons/plus-gold2.png'),
  'rotate-cw-blue': require('../../assets/icons/rotate-cw-blue.png'),
  'search-a40': require('../../assets/icons/search-a40.png'),
  'sparkles-a72': require('../../assets/icons/sparkles-a72.png'),
  'sparkles-purple': require('../../assets/icons/sparkles-purple.png'),
  'sliders-horizontal-a45': require('../../assets/icons/sliders-horizontal.png'),
  'square-red': require('../../assets/icons/square-red.png'),
  'wrench-a40': require('../../assets/icons/wrench-a40.png'),
  'x-a45': require('../../assets/icons/x-a45.png'),
  'x-a56': require('../../assets/icons/x-a56.png'),
  'x-white': require('../../assets/icons/x-white.png'),
  // 直接生成 / 生成历史两页新增（lucide 同名图标，色值取网页版对应 class 的语义色）
  'alert-circle-a44': require('../../assets/icons/alert-circle-a44.png'),
  'arrow-left-a85': require('../../assets/icons/arrow-left-a85.png'),
  'check-blue': require('../../assets/icons/check-blue.png'),
  'filter-a62': require('../../assets/icons/filter-a62.png'),
  'image-plus-a45': require('../../assets/icons/image-plus-a45.png'),
  'image-plus-blue': require('../../assets/icons/image-plus-blue.png'),
  'music-a40': require('../../assets/icons/music-a40.png'),
  'pencil-a65': require('../../assets/icons/pencil-a65.png'),
  'rerun-a55': require('../../assets/icons/rerun-a55.png'),
  'sparkles-white': require('../../assets/icons/sparkles-white.png'),
  'square-white': require('../../assets/icons/square-white.png'),
  'zoom-in-a65': require('../../assets/icons/zoom-in-a65.png'),
  // Markdown / 图片卡 / 附件卡新增的 lucide 同名替身（复用既有 PNG，不新增资产）：
  //   share     → copy-plus（网页 Share2 的位置）
  //   layers    → images（「再来 N 组」）
  //   file-text / film / check 已按 lucide 原名生成（此前误用 box / clapperboard / check-green）
  //   play      → monitor-play（行内音频播放）
  'share-a45': require('../../assets/icons/copy-plus-a45.png'),
  'layers-a45': require('../../assets/icons/images-a72.png'),
  'file-text-a56': require('../../assets/icons/file-text-a56.png'),
  'film-a56': require('../../assets/icons/film-a56.png'),
  'play-a45': require('../../assets/icons/monitor-play.png'),
} as const

export type IconName = keyof typeof ICON_MAP

export interface IconProps {
  name: IconName
  className?: string
  style?: React.CSSProperties
}

export function Icon({ name, className, style }: IconProps) {
  return <Image className={className} style={style} src={ICON_MAP[name]} mode='aspectFit' />
}
