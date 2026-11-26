/** 目录数据逐行同步自网页版 generation-model-catalog；本文件只做小程序表单投影。 */
import { GENERATION_MODEL_CATALOG, GENERATION_MODEL_IDS } from './generation-model-catalog/catalog'
import { ASPECT_RATIO_VALUES, type AspectRatio as CatalogAspectRatio } from './generation-model-catalog/types'
import { applyModelPricingOverrides } from './generation-model-catalog/pricing-overrides'
import { request } from './request'
export type AspectRatio = CatalogAspectRatio
export const ASPECT_RATIOS = ASPECT_RATIO_VALUES
export const ASPECT_RATIO_LABELS: Record<AspectRatio, string> = Object.fromEntries(ASPECT_RATIOS.map(ratio => [ratio, ratio])) as Record<AspectRatio, string>
export const RESOLUTION_LABELS: Record<string, string> = { '1k': '1K 标准', '2k': '2K 高清', '4k': '4K 超清', '360p': '360P', '480p': '480P', '540p': '540P', '720p': '720P', '1080p': '1080P' }
export interface ImageModelOption {
  id: string
  name: string
  hint: string
  kind: 'image' | 'video'
  vendor: string
  resolutions: string[]
  aspectRatios: readonly AspectRatio[]
  defaultResolution: string
  defaultAspectRatio: AspectRatio
  durations: readonly number[]
  defaultDuration?: number
  supportsAudio: boolean
  defaultAudio: boolean
  referenceImages: boolean
}
export const IMAGE_MODELS: ImageModelOption[] = GENERATION_MODEL_IDS.flatMap(id => {
  const model = GENERATION_MODEL_CATALOG[id]
  if (!model || (model.kind !== 'image' && model.kind !== 'video') || model.pipeline) return []
  return [{ id, name: model.displayName, hint: model.knowledge?.strengths?.join('；') ?? '', kind: model.kind, vendor: model.vendor, resolutions: [...model.resolutions], aspectRatios: model.aspectRatios, defaultResolution: model.defaultResolution, defaultAspectRatio: model.defaultAspectRatio, durations: model.durations ?? [], defaultDuration: model.defaultDuration, supportsAudio: Boolean(model.supportsAudio), defaultAudio: Boolean(model.defaultAudio), referenceImages: model.referenceImages }]
})
export function allowedResolutions(model: ImageModelOption, _ratio: AspectRatio): string[] { return model.resolutions }
export function clampResolution(model: ImageModelOption, ratio: AspectRatio, resolution: string): string {
  const allowed = allowedResolutions(model, ratio)
  return allowed.includes(resolution) ? resolution : model.defaultResolution
}
/** 与网页版 PricingSync 使用同一公开定价源；失败保留本地目录基准价。 */
export async function syncModelPricing(): Promise<void> {
  const payload = await request<{ overrides?: unknown }>({ path: '/api/model-pricing', auth: false })
  applyModelPricingOverrides(payload?.overrides)
}
