/**
 * 直接生成页用到的静态配方（全部逐字复制网页版真源，不做二次改写）。
 *
 * 为什么放在小程序侧而不是 import 根仓 lib：小程序是独立构建（Taro 只编 src/），
 * 根仓 lib 的 TS/ESM 依赖链拉不进来；本档只搬「展示 + 提示词组合」这两类纯数据，
 * 生成契约仍走 apps/miniapp/src/lib/generation.ts 的真实接口。
 */

/** 示例句：逐字复制 src/lib/suggestions.ts:5-29（basePrompts）。 */
export interface Suggestion {
  text: string
  prompt: string
}

export const SUGGESTIONS: Suggestion[] = [
  {
    text: '海岸香氛大片',
    prompt: '帮我把这瓶香水放在落日海滩上，要有高级感环境光，像精品品牌广告。',
  },
  {
    text: '咖啡新品海报',
    prompt: '帮我做一张咖啡店新品海报，木质桌面、早晨阳光、奶油色调，整体干净又有质感。',
  },
  {
    text: '珠宝质感商品图',
    prompt: '把这款耳环做成棚拍商品图，背景干净，金属反光细致，整体要有高级感。',
  },
  {
    text: '甜点社交大片',
    prompt: '做一张适合发社交平台的甜点照片，草莓蛋糕放在窗边桌上，光线柔和，让人看了就想下单。',
  },
  {
    text: '品牌促销视觉',
    prompt: '帮我做一张小店限时优惠宣传图，画面简洁、好读，像品牌活动海报。',
  },
]

/** 风格预设：逐字复制 src/lib/prompt-enhancer.ts:17-51（STYLE_PRESETS）。 */
export interface StylePresetOption {
  key: string
  label: string
  suffix: string
}

export const STYLE_PRESETS: StylePresetOption[] = [
  {
    key: 'realistic',
    label: '真实摄影',
    suffix:
      'photorealistic, DSLR photography, natural lighting, sharp focus, 8K resolution, professional color grading',
  },
  {
    key: 'anime',
    label: '动漫美学',
    suffix:
      'anime style illustration, vibrant colors, clean linework, studio ghibli inspired, detailed background',
  },
  {
    key: 'street',
    label: '潮流街拍',
    suffix:
      'street photography aesthetic, film grain, candid moment, urban environment, trendy composition, social media ready',
  },
  {
    key: 'product',
    label: '产品视觉',
    suffix:
      'product photography, clean white or gradient background, studio lighting, commercial quality, high detail, e-commerce ready',
  },
  {
    key: 'poster',
    label: '品牌海报',
    suffix:
      'graphic design poster, bold typography space, strong visual hierarchy, modern design, print quality',
  },
  {
    key: 'watercolor',
    label: '水彩艺术',
    suffix:
      'watercolor illustration, soft washes, delicate brushstrokes, pastel tones, artistic texture, hand-painted feel',
  },
]

/** 与 src/lib/prompt-enhancer.ts:56-65 的 enhancePrompt 同一语义。 */
export function enhancePrompt(userPrompt: string, presetKey: string): string {
  const trimmed = userPrompt.trim()
  if (!presetKey || presetKey === 'none') return trimmed
  const meta = STYLE_PRESETS.find((preset) => preset.key === presetKey)
  if (!meta) return trimmed
  if (trimmed.includes(meta.suffix)) return trimmed
  return `${trimmed}, ${meta.suffix}`
}

/**
 * 示例句插入与替换：逐字复制 src/lib/prompt-compose.ts:1-42
 * （insertPromptSnippet / replacePromptSnippet / replacePromptStyleSuffix）。
 * 语义：连点多个示例只保留最新一个；手打正文不受影响。
 */
export function insertPromptSnippet(basePrompt: string, snippet: string): string {
  const current = basePrompt.trim()
  const addition = snippet.trim()
  if (!addition) return current
  if (!current) return addition
  if (current.includes(addition)) return current
  return `${current}\n\n${addition}`
}

export function replacePromptSnippet(
  basePrompt: string,
  previousSnippet: string | null,
  nextSnippet: string,
): string {
  const previous = previousSnippet?.trim()
  let base = basePrompt
  if (previous && base.includes(previous)) {
    base = base
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part && part !== previous)
      .join('\n\n')
  }
  return insertPromptSnippet(base, nextSnippet)
}

export function replacePromptStyleSuffix(
  basePrompt: string,
  nextSuffix: string | undefined,
  styleSuffixes: readonly string[],
): string {
  const promptWithoutStyle = basePrompt
    .trim()
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && !styleSuffixes.includes(part))
    .join('\n\n')
  return nextSuffix ? insertPromptSnippet(promptWithoutStyle, nextSuffix) : promptWithoutStyle
}

/** 与网页版模型目录同源；价格实时覆写由 syncModelPricing 注入。 */
export { generationCoins as modelCoins } from '../../lib/generation-model-catalog/pricing'
import { GENERATION_MODEL_CATALOG } from '../../lib/generation-model-catalog/catalog'
import { modelPriceLabel as catalogPriceLabel } from '../../lib/generation-model-catalog/pricing'
import type { OutputResolution } from '../../lib/generation-model-catalog/types'
export const MODEL_META = GENERATION_MODEL_CATALOG
export function modelPriceLabel(modelId: string, resolution: string, generateAudio?: boolean): string {
  const model = GENERATION_MODEL_CATALOG[modelId]
  const supportedResolution = model?.resolutions.includes(resolution as OutputResolution) ? resolution : model?.defaultResolution
  return catalogPriceLabel(modelId, { resolution: supportedResolution as OutputResolution, generateAudio: generateAudio ?? model?.defaultAudio })
}

/** 同 src/components/GenerationProgressBar.tsx:4-21（时长与曲线一字不动）。 */
export const NORMAL_PROGRESS_DURATION_MS = 50000

function easeOut(progress: number): number {
  return 1 - Math.pow(1 - progress, 3)
}

/** 生成完成前绝不报 100：进度是时间估算，提前满格会让排队中的用户看到「卡 100%」。 */
export function calculateGenerationProgress(
  startedAt: number,
  now: number,
  durationMs = NORMAL_PROGRESS_DURATION_MS,
): number {
  const elapsed = Math.max(0, now - startedAt)
  const ratio = Math.min(1, elapsed / Math.max(1, durationMs))
  if (ratio >= 1) return 99
  return Math.max(1, Math.min(99, Math.round(easeOut(ratio) * 100)))
}
