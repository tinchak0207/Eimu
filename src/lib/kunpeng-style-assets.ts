/**
 * 鲲鹏风格库资产（161 条，四件套文字逐字保留）。
 *
 * 数据来源：pengfeiqiao/kunpeng（v2.9.16，commit 872a58b，MIT License）
 * 的 aigc-memory/style-library/index.json —— 原样导入，不做任何文字改写。
 * 缩略图（298M jpg，商用授权未确认）刻意不导入：资源卡用文字 + 类别呈现，
 * visualDNA 摘要当描述。
 *
 * 契约对齐 creator-resource-library.ts 的「外部源 pin commit + license」先例。
 */

import rawLibrary from "@/data/kunpeng-style-library.json";

/** kunpeng 风格条目四件套（+ 元数据），字段与源 JSON 逐字一致。 */
export interface KunpengStyleAsset {
  /** 源 JSON 原始条目，四件套（promptTemplate/visualDNA/cameraLanguage/promptSuffix）一字不改。 */
  id: string;
  name: string;
  category: "live-action" | "2d-animation";
  /** 缩略图相对路径（仅作溯源用，本站不导入、不渲染该图片）。 */
  thumbnail: string;
  promptTemplate: string;
  visualDNA: string;
  cameraLanguage: string;
  promptSuffix: string;
}

interface RawLibrary {
  categories: Array<{ id: string; name: string; dir: string }>;
  styles: KunpengStyleAsset[];
}

const library = rawLibrary as unknown as RawLibrary;

/** 来源声明（creator-resource-library 同款先例）。 */
export const KUNPENG_SOURCE = {
  sourceName: "pengfeiqiao/kunpeng",
  sourceUrl: "https://github.com/pengfeiqiao/kunpeng",
  sourceCommit: "872a58b",
  license: "MIT",
} as const;

/** 类别 id → 简体中文名（沿用源 categories 的名称，逐字）。 */
export const KUNPENG_STYLE_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  library.categories.map((category) => [category.id, category.name]),
);

/** 全量 161 条风格资产（live-action 67 + 2d-animation 94）。 */
export const KUNPENG_STYLE_ASSETS: readonly KunpengStyleAsset[] = library.styles;

export function getKunpengStyleById(id: string | null | undefined): KunpengStyleAsset | undefined {
  if (!id) return undefined;
  return KUNPENG_STYLE_ASSETS.find((style) => style.id === id);
}

/**
 * 套用风格：把 promptSuffix / visualDNA / cameraLanguage 组合成可直接追加到
 * 用户提示词尾部的风格块（英文后缀 + 中文视觉 DNA / 镜头语言说明）。
 * 四件套文字原样拼接，不重写。
 */
export function buildKunpengStylePrompt(style: KunpengStyleAsset): string {
  return [style.promptSuffix, style.visualDNA, style.cameraLanguage].join("\n");
}

/**
 * 资源卡描述：visualDNA 首行摘要（「- 色调：…」取第一条），
 * 让卡片在无缩略图的情况下也能传达风格气质。
 */
export function kunpengStyleSummary(style: KunpengStyleAsset): string {
  const firstLine = style.visualDNA.split("\n").find((line) => line.trim().length > 0);
  return firstLine ? firstLine.replace(/^-\s*/, "") : style.name;
}
