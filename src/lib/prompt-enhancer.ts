/**
 * Prompt enhancer — auto-appends quality suffixes based on style preset.
 * Keeps small whites' prompts short while maximizing output quality.
 */

export type StylePreset =
  | "realistic"
  | "anime"
  | "street"
  | "product"
  | "poster"
  | "watercolor"
  | "none";

export interface StylePresetMeta {
  key: StylePreset;
  label: string;
  icon: string; // lucide icon name
  suffix: string;
}

export const STYLE_PRESETS: StylePresetMeta[] = [
  {
    key: "realistic",
    label: "真实摄影",
    icon: "Camera",
    suffix:
      "photorealistic, DSLR photography, natural lighting, sharp focus, 8K resolution, professional color grading",
  },
  {
    key: "anime",
    label: "动漫美学",
    icon: "Sparkles",
    suffix:
      "anime style illustration, vibrant colors, clean linework, studio ghibli inspired, detailed background",
  },
  {
    key: "street",
    label: "潮流街拍",
    icon: "Zap",
    suffix:
      "street photography aesthetic, film grain, candid moment, urban environment, trendy composition, social media ready",
  },
  {
    key: "product",
    label: "产品视觉",
    icon: "Package",
    suffix:
      "product photography, clean white or gradient background, studio lighting, commercial quality, high detail, e-commerce ready",
  },
  {
    key: "poster",
    label: "品牌海报",
    icon: "Layout",
    suffix:
      "graphic design poster, bold typography space, strong visual hierarchy, modern design, print quality",
  },
  {
    key: "watercolor",
    label: "水彩艺术",
    icon: "Droplets",
    suffix:
      "watercolor illustration, soft washes, delicate brushstrokes, pastel tones, artistic texture, hand-painted feel",
  },
];

/**
 * Enhance a user prompt with the selected style suffix.
 * If preset is "none", return the prompt as-is.
 */
export function enhancePrompt(userPrompt: string, preset: StylePreset): string {
  if (preset === "none") return userPrompt.trim();
  const meta = STYLE_PRESETS.find((p) => p.key === preset);
  if (!meta) return userPrompt.trim();
  if (userPrompt.trim().includes(meta.suffix)) return userPrompt.trim();
  return `${userPrompt.trim()}, ${meta.suffix}`;
}

/**
 * Suggest a preset based on keywords in the user's prompt.
 * Simple heuristic — good enough for small whites.
 */
export function suggestPreset(prompt: string): StylePreset {
  const lower = prompt.toLowerCase();
  if (/商品|產品|包裝|瓶|盒/.test(lower)) return "product";
  if (/動漫|卡通|二次元|插畫/.test(lower)) return "anime";
  if (/海報|宣傳|廣告|banner/.test(lower)) return "poster";
  if (/街拍|街頭|城市|urban/.test(lower)) return "street";
  if (/水彩|手繪|插圖/.test(lower)) return "watercolor";
  return "realistic";
}
