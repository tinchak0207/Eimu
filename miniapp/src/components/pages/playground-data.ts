/**
 * 直接生成页用到的静态配方（全部逐字复制网页版真源，不做二次改写）。
 *
 * 为什么放在小程序侧而不是 import 根仓 lib：小程序是独立构建（Taro 只编 src/），
 * 根仓 lib 的 TS/ESM 依赖链拉不进来；本档只搬「展示 + 提示词组合」这两类纯数据，
 * 生成契约仍走 miniapp/src/lib/generation.ts 的真实接口。
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

/**
 * 模型展示元数据（厂商 / 推荐角标 / 单价）。
 *
 * 真源：src/lib/generation-model-catalog/catalog.ts
 *   gpt-image-2            :76-84   imageCredits 1k/2k/4k = 10/20/80
 *   gemini-3.1-flash-image :85-97   imageCredits 1k/2k/4k = 20/20/30
 *   pixai-tsubaki2         :424-436 imageCredits 1k = 0.01
 * 计价换算同 src/lib/generation-model-catalog/pricing.ts:33-49：币 = credits / 10。
 * miniapp/src/lib/models.ts 只开放这三个模型（本阶段硬编码，不做动态拉取）。
 */
export interface ModelMeta {
  vendor: string
  promotionTag?: string
  credits: Record<string, number>
}

export const MODEL_META: Record<string, ModelMeta> = {
  'gpt-image-2': {
    vendor: 'OpenAI',
    credits: { '1k': 10, '2k': 20, '4k': 80 },
  },
  'gemini-3.1-flash-image': {
    vendor: 'Google',
    credits: { '1k': 20, '2k': 20, '4k': 30 },
  },
  'pixai-tsubaki2': {
    vendor: 'PixAI',
    promotionTag: '推荐',
    credits: { '1k': 0.01 },
  },
}

/** 同 pricing.ts:33-49 的 generationCoins（没有费率表时回 1 币兜底）。 */
export function modelCoins(modelId: string, resolution: string): number {
  const meta = MODEL_META[modelId]
  const credits = meta?.credits[resolution]
  if (credits === undefined) return 1
  return Math.round((credits / 10) * 100000) / 100000
}

/** 同 pricing.ts:51-64 的 modelPriceLabel（图片分支）。 */
export function modelPriceLabel(modelId: string, resolution: string): string {
  return `${modelCoins(modelId, resolution)} 币/张`
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
