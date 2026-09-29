/**
 * 行業樞紐頁（2026-09-27 SEO 重構）。
 *
 * 取代舊的 102 個 `<行業>-<n>` 模板門頁：同一套句子換關鍵詞、同一組 FAQ、
 * 與場景無關的「數據來源」——Google 對這種規模化薄內容會整站降權。
 * 現在每個行業一頁、寫實內容，舊 URL 在 next.config.mjs 301 到這裡。
 */

export interface UseCaseCategoryPrompt {
  title: string;
  prompt: string;
}

export interface UseCaseCategoryFAQ {
  question: string;
  answer: string;
}

/** 行業內的單一子場景（對應一個舊門頁）。 */
export interface UseCaseCategoryScenario {
  /** 頁內錨點，ASCII kebab-case，如 "app-screens"。 */
  id: string;
  /** 被合併進來的舊門頁 slug，如 "ui-1"（僅作追溯，不渲染）。 */
  legacySlug: string;
  /** H3 標題。 */
  title: string;
  /** 這個子場景的主要搜索說法。 */
  searchKeyword: string;
  /** 2–4 段具體正文。 */
  body: string[];
  /** 2–3 條可直接複製的詳細提示詞。 */
  prompts: UseCaseCategoryPrompt[];
  /** 常見翻車點與對策（可選）。 */
  pitfalls?: string[];
}

export interface UseCaseCategory {
  /** URL 段：/use-cases/<slug>。 */
  slug: string;
  /** 行業短名，如「UI 与产品设计」。 */
  name: string;
  /** 主搜索關鍵詞。 */
  keyword: string;
  /** <title> 與 H1（不含「| Eimu」），≤ 30 字。 */
  title: string;
  /** meta description，70–110 字。 */
  description: string;
  /** 2–3 段導語。 */
  intro: string[];
  /** 相關工作流落地頁 slug（/workflows/<slug>）。 */
  workflowSlugs: string[];
  /** 子場景，通常 6 個。 */
  scenarios: UseCaseCategoryScenario[];
  /** 在 Eimu 裡做這一類圖的通用步驟。 */
  checklist: string[];
  /** 4–6 題行業專屬 FAQ。 */
  faqs: UseCaseCategoryFAQ[];
  /** 2–4 個相關行業 slug。 */
  relatedCategorySlugs: string[];
  /** 相關的深度指南（現存 reddit-* 用例 slug）。 */
  relatedGuideSlugs: string[];
  /** 內容最後核對日，ISO 日期。 */
  updated: string;
}
