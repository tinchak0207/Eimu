/**
 * 输入框 placeholder。文案逐行对齐网页版 AgentComposer.placeholder.ts：
 *   DEFAULT_PLACEHOLDER  「……拖进来」（桌面）
 *   TOUCH_PLACEHOLDER    「……传上来」（触控装置）
 *   COMPACT_PLACEHOLDER  窄框短句
 *
 * 平台差异：小程序没有 canvas 量字与 ResizeObserver，改用窗口宽度做一次静态决策
 * （≤360px 用短句，其余用触控长句）。不读 document/window。
 */

export const DEFAULT_PLACEHOLDER = '描述你想做的，或把剧本／资产图拖进来'
export const COMPACT_PLACEHOLDER = '描述你想做的画面或影片'
export const TOUCH_PLACEHOLDER = '描述你想做的，或把剧本／资产图传上来'

/** 窄于这个宽度（px）用短句，避免 placeholder 折行被一行高的空框裁半截。 */
export const COMPACT_WIDTH_PX = 360

/** 纯函数决策（窗口宽 → placeholder），便于直测与跨端复用。 */
export function resolveMiniappPlaceholder(windowWidth: number): string {
  return Number.isFinite(windowWidth) && windowWidth > 0 && windowWidth <= COMPACT_WIDTH_PX
    ? COMPACT_PLACEHOLDER
    : TOUCH_PLACEHOLDER
}
