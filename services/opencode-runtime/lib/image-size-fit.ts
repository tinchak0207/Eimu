/**
 * 出图尺寸「就近落档」（2026-11-04，单一真源；services/opencode-runtime/lib/image-size-fit.ts
 * 是本档的逐字镜像，改这里必须同步那份——运行时不能 import src）。
 *
 * 病灶（生产真会话 16b511d6，暴君「给我一张极简风的咖啡馆海报」）：模型/子代理要 3:4 竖版海报，
 * image_generate 的 size 只认白名单 5 档（1024x1024／1536x1024／1024x1536／2048x2048／4096x4096），
 * 3:4（1536x2048）被参数校验挡下 → 子代理反复试错烧步骤，最后被叫停改「方形出图后裁切」。
 * 修法：比例/档位/非法像素尺寸一律在工具层映射到最接近的合法尺寸并告知，绝不报错让模型自己试。
 *
 * 规则：先比比例（对数误差，≤0.05 视为同比例），同比例内再比档位（1k/2k/4k，按最长边）。
 * 白名单里 2k/4k 目前只有 1:1，所以 3:4@2k → 1024x1536（比例优先于档位）。
 * 纯函数、零依赖；allowed 由调用方传入（运行时取站点 openapi 真源，src 侧传 DURABLE_IMAGE_SIZES）。
 */

export type ImageSizeFitInput = {
  /** 像素尺寸（"1536x2048"）、比例（"3:4"）、档位别名（"2k"）三种写法都收。 */
  size?: string
  /** 比例写法："3:4"、"3/4"、"3x4" 之类；与 size 同时给时 size 为 WxH 以 size 为准。 */
  aspect_ratio?: string
  /** 档位提示："1k"|"2k"|"4k"（其他值忽略）。 */
  resolution?: string
}

export type ImageSizeFit = {
  size: string
  /** 请求值与落档值不同（含 size 缺省时按比例/档位选档）。 */
  adjusted: boolean
  requested: string
  /** 人话说明，调用方原样告知用户；未调整时为 undefined。 */
  note?: string
}

const TIER_MAX_EDGE: Record<string, number> = { "1k": 1024, "2k": 2048, "4k": 4096 }

function parsePixels(s: string): { w: number; h: number } | null {
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(s.trim())
  if (!m) return null
  const w = Number(m[1]), h = Number(m[2])
  return w > 0 && h > 0 ? { w, h } : null
}

function parseRatio(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:/xX×]\s*(\d+(?:\.\d+)?)$/.exec(s.trim())
  if (!m) return null
  const a = Number(m[1]), b = Number(m[2])
  return a > 0 && b > 0 ? a / b : null
}

// 档位距离直接用最长边的对数距离；分档名与 resolutionFromImageSize 一致：≤1536→1k、≤3072→2k、其余→4k。
const tierOfEdge = (edge: number): number => edge

function tierName(edge: number): string {
  return edge <= 1536 ? "1k" : edge <= 3072 ? "2k" : "4k"
}

/**
 * 把请求落到 allowed 里最接近的尺寸。allowed 为空/全不可解析时原样返回请求（交上游裁决，不编造）。
 */
export function fitImageSize(input: ImageSizeFitInput, allowed: readonly string[]): ImageSizeFit {
  const rawSize = (input.size ?? "").trim()
  const rawAspect = (input.aspect_ratio ?? "").trim()
  const requested = rawSize || rawAspect || input.resolution?.trim() || "(默认)"
  const allowedLower = allowed.map((a) => a.trim().toLowerCase())
  // 已是合法尺寸：原样放行（aspect_ratio 与之矛盾时以明确的像素尺寸为准）。
  if (rawSize && allowedLower.includes(rawSize.toLowerCase())) return { size: rawSize.toLowerCase(), adjusted: false, requested }

  const cands = allowedLower
    .map((s) => ({ s, px: parsePixels(s) }))
    .filter((c): c is { s: string; px: { w: number; h: number } } => c.px !== null)
  if (cands.length === 0) return { size: rawSize || "1024x1024", adjusted: false, requested }

  let ratio: number | null = null
  let edge: number | null = null
  const px = rawSize ? parsePixels(rawSize) : null
  if (px) {
    ratio = px.w / px.h
    edge = Math.max(px.w, px.h)
  } else {
    if (rawSize) {
      const tier = TIER_MAX_EDGE[rawSize.toLowerCase()]
      if (tier) edge = tier
      else ratio = parseRatio(rawSize)
    }
    if (ratio === null && rawAspect) ratio = parseRatio(rawAspect)
  }
  const tierHint = TIER_MAX_EDGE[(input.resolution ?? "").trim().toLowerCase()]
  if (edge === null && tierHint) edge = tierHint
  if (ratio === null) ratio = 1
  if (edge === null) edge = 1024

  const scored = cands
    .map((c) => {
      const r = c.px.w / c.px.h
      const ratioErr = Math.abs(Math.log(r / ratio!))
      const tierErr = Math.abs(Math.log(tierOfEdge(Math.max(c.px.w, c.px.h)) / tierOfEdge(edge!)))
      return { s: c.s, ratioErr, tierErr }
    })
    .sort((a, b) => {
      const ra = a.ratioErr <= 0.05 ? 0 : a.ratioErr
      const rb = b.ratioErr <= 0.05 ? 0 : b.ratioErr
      return ra - rb || a.tierErr - b.tierErr
    })
  const best = scored[0]
  const [bw, bh] = best.s.split("x").map(Number)
  const bestRatio = bw / bh
  const exactRatio = Math.abs(Math.log(bestRatio / ratio)) <= 0.05
  const wantedTier = tierName(edge)
  const gotTier = tierName(Math.max(bw, bh))
  const parts: string[] = []
  const unparsed = !!rawSize && !px && !TIER_MAX_EDGE[rawSize.toLowerCase()] && parseRatio(rawSize) === null && !rawAspect
  if (unparsed) parts.push(`无法识别尺寸写法「${rawSize}」，按默认 1:1 落到 ${best.s}`)
  else if (!exactRatio) parts.push(`上游只认 ${allowed.join("、")}，不支持「${rawSize || rawAspect}」，已落到最接近的 ${best.s}`)
  else parts.push(`已按「${rawSize || rawAspect || input.resolution}」选档为 ${best.s}`)
  if (wantedTier !== gotTier && (input.resolution || TIER_MAX_EDGE[rawSize.toLowerCase()] || px)) {
    parts.push(`${wantedTier} 档在该比例上没有已验证尺寸，实际为 ${gotTier} 档`)
  }
  if (!exactRatio && !unparsed) parts.push("需要严格比例请在拿到图后裁切（不要为凑比例重复提交）")
  const adjusted = !!(rawSize || rawAspect || input.resolution) && best.s !== rawSize.toLowerCase()
  return { size: best.s, adjusted, requested, ...(adjusted ? { note: parts.join("；") + "。" } : {}) }
}
