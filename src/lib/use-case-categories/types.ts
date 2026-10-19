/**
 * 行业枢纽页（2026-09-27 SEO 重构）。
 *
 * 取代旧的 102 个 `<行业>-<n>` 模板门页：同一套句子换关键词、同一组 FAQ、
 * 与场景无关的「数据来源」——Google 对这种规模化薄内容会整站降权。
 * 现在每个行业一页、写实内容，旧 URL 在 next.config.mjs 301 到这里。
 */

export interface UseCaseCategoryPrompt {
  title: string;
  prompt: string;
}

export interface UseCaseCategoryFAQ {
  question: string;
  answer: string;
}

/** 行业内的单一子场景（对应一个旧门页）。 */
export interface UseCaseCategoryScenario {
  /** 页内锚点，ASCII kebab-case，如 "app-screens"。 */
  id: string;
  /** 被合并进来的旧门页 slug，如 "ui-1"（仅作追溯，不渲染）。 */
  legacySlug: string;
  /** H3 标题。 */
  title: string;
  /** 这个子场景的主要搜索说法。 */
  searchKeyword: string;
  /** 2–4 段具体正文。 */
  body: string[];
  /** 2–3 条可直接复制的详细提示词。 */
  prompts: UseCaseCategoryPrompt[];
  /** 常见翻车点与对策（可选）。 */
  pitfalls?: string[];
}

export interface UseCaseCategory {
  /** URL 段：/use-cases/<slug>。 */
  slug: string;
  /** 行业短名，如「UI 与产品设计」。 */
  name: string;
  /** 主搜索关键词。 */
  keyword: string;
  /** <title> 与 H1（不含「| Eimu」），≤ 30 字。 */
  title: string;
  /** meta description，70–110 字。 */
  description: string;
  /** 2–3 段导语。 */
  intro: string[];
  /** 相关工作流落地页 slug（/workflows/<slug>）。 */
  workflowSlugs: string[];
  /** 子场景，通常 6 个。 */
  scenarios: UseCaseCategoryScenario[];
  /** 在 Eimu 里做这一类图的通用步骤。 */
  checklist: string[];
  /** 4–6 题行业专属 FAQ。 */
  faqs: UseCaseCategoryFAQ[];
  /** 2–4 个相关行业 slug。 */
  relatedCategorySlugs: string[];
  /** 相关的深度指南（现存 reddit-* 用例 slug）。 */
  relatedGuideSlugs: string[];
  /** 内容最后核对日，ISO 日期。 */
  updated: string;
}
