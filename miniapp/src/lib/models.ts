/**
 * 可用图片模型（真源：仓库 src/lib/generation-model-catalog/catalog.ts 与
 * src/lib/image-model-ids.js；本阶段不做动态拉取，因此硬编码）。
 *
 * 画幅只开放 1:1 / 3:2 / 2:3：后端 durable 尺寸白名单只有
 * 1024x1024、1536x1024、1024x1536（以及 1:1 的 2048x2048 / 4096x4096），
 * 其余比例会在提交前被 `unsupported_size` 具名拒绝。
 */
export interface ImageModelOption {
  id: string
  name: string
  hint: string
  /** catalog 中该模型声明的 resolutions；2k/4k 仅 1:1 可交付，见 allowedResolutions。 */
  resolutions: string[]
  defaultResolution: string
}

export const ASPECT_RATIOS = ['1:1', '3:2', '2:3'] as const
export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export const ASPECT_RATIO_LABELS: Record<AspectRatio, string> = {
  '1:1': '1:1 方形',
  '3:2': '3:2 横向',
  '2:3': '2:3 竖向',
}

export const RESOLUTION_LABELS: Record<string, string> = {
  '1k': '1K 标准',
  '2k': '2K 高清',
  '4k': '4K 超清',
}

export const IMAGE_MODELS: ImageModelOption[] = [
  {
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    hint: '通用默认模型，稳定出图',
    resolutions: ['1k', '2k', '4k'],
    defaultResolution: '1k',
  },
  {
    id: 'gemini-3.1-flash-image',
    name: 'Nano Banana 2',
    hint: '细节与文字表现好',
    resolutions: ['1k', '2k', '4k'],
    defaultResolution: '2k',
  },
  {
    id: 'pixai-tsubaki2',
    name: 'PixAI Tsubaki.2',
    hint: '二次元 / 插画风格',
    resolutions: ['1k'],
    defaultResolution: '1k',
  },
]

/** 后端只对 1:1 提供 2k/4k 的可交付尺寸；其他比例一律只能 1k。 */
export function allowedResolutions(model: ImageModelOption, ratio: AspectRatio): string[] {
  if (ratio === '1:1') return model.resolutions
  return model.resolutions.filter((resolution) => resolution === '1k')
}

export function clampResolution(model: ImageModelOption, ratio: AspectRatio, resolution: string): string {
  const allowed = allowedResolutions(model, ratio)
  return allowed.includes(resolution) ? resolution : allowed[0] ?? '1k'
}
